/**
 * Characterization of the process entry, src/platform/entrypoints/cli.tsx,
 * pinned before the lever cut removes its `remote-control` fast path and the
 * bridge behind it. Those are not pinned.
 *
 * The module exports nothing: importing it runs `main()` against
 * `process.argv`. Each case therefore sets `process.argv`, imports a fresh
 * copy of the module (a new query string is a new module instance), and
 * reads what a user would see: stdout, stderr, the exit code, the
 * environment it leaves. Coverage keeps only the instance loaded last, so
 * the richest path (a subcommand's help) runs last.
 *
 * Covered here, in-process:
 * - `--version` / `-v` / `-V` print the version and stop;
 * - `--help` / `-h` / `-help` and `<cmd> --help` serve the help snapshot that
 *   sits beside the entry file (dist/ in the bundle);
 * - the defaults it puts in the environment before anything else runs.
 *
 * Not reachable in-process, and left uncovered:
 * - everything after the fast paths. Each way out of it either runs main.js,
 *   which is the whole CLI started inside the test process (its signal
 *   handlers, its client type, its REPL), or calls process.exit from inside
 *   the fire-and-forget main(): trapping that exit with a throw becomes an
 *   unhandled rejection, which fails the run, and trapping it with a return
 *   lets main() run on into main.js. That covers `--provider`, the settings
 *   env and provider checks, the opt-in screen clear, `--worktree --tmux`
 *   (its tmux probe also ignores a stand-in on process.env.PATH: Bun's
 *   spawnSync without an `env` resolves through the PATH the process
 *   started with), `--update`, `--bare` and early input capture;
 * - the polyfills, which only run on runtimes without File,
 *   Promise.withResolvers or util.markAsUncloneable;
 * - `--dump-system-prompt`, behind a build flag that is off under `bun test`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { trapExits, waitFor } from 'src/platform/main/__testutils__/bootHarness.js'
import { envSnapshot, type EnvSnapshot } from 'src/sessions/__testutils__/lifecycleHarness.js'

const ENTRY_DIR = join(import.meta.dir)
const STARTUP_ENV = [
  'CLAUDIN_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDIN_ENABLE_FINE_GRAINED_TOOL_STREAMING',
  'COREPACK_ENABLE_AUTO_PIN',
  'CLAUDIN_SKIP_STARTUP_UPDATE',
  'CLAUDIN_HELP_CAPTURE',
]


type Macro = { VERSION?: string; DISPLAY_VERSION?: string }
const globals = globalThis as { MACRO?: Macro }
let macroBefore: Macro | undefined
let argvBefore: string[]
let loads = 0

beforeAll(() => {
  macroBefore = globals.MACRO
  argvBefore = process.argv
})
afterAll(() => {
  if (macroBefore === undefined) delete globals.MACRO
  else globals.MACRO = macroBefore
  process.argv = argvBefore
})

type Run = {
  stdout: string
  stderr: string
  exitCodes: Array<number | undefined>
  argv: string[]
}

let captured: { out: string[]; err: string[] } = { out: [], err: [] }
const restorers: Array<() => void> = []

let env: EnvSnapshot

beforeEach(() => {
  env = envSnapshot(STARTUP_ENV)
  captured = { out: [], err: [] }
  process.env.CLAUDIN_SKIP_STARTUP_UPDATE = '1'
  delete process.env.CLAUDIN_HELP_CAPTURE
  globals.MACRO = { VERSION: '7.7.7-char' }
  const log = console.log
  const error = console.error
  const write = process.stdout.write
  console.log = (...parts: unknown[]) => void captured.out.push(`${parts.join(' ')}\n`)
  console.error = (...parts: unknown[]) => void captured.err.push(`${parts.join(' ')}\n`)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured.out.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  restorers.push(() => {
    console.log = log
    console.error = error
    process.stdout.write = write
  })
})

afterEach(() => {
  while (restorers.length > 0) restorers.pop()!()
  process.argv = argvBefore
  env.restore()
})

/**
 * Imports a fresh cli.tsx with `args` after the script path and waits until
 * `done` says main() has reached its end (or the exit it asked for).
 */
async function runCli(args: string[], done: (run: Run) => boolean): Promise<Run> {
  // Nothing here should exit; if something does, the throw fails the test.
  const exits = trapExits()
  process.argv = [process.argv[0]!, join(ENTRY_DIR, 'cli.tsx'), ...args]
  const snapshot = (): Run => ({
    stdout: captured.out.join(''),
    stderr: captured.err.join(''),
    exitCodes: [...exits.codes],
    argv: process.argv.slice(2),
  })
  try {
    await import(`src/platform/entrypoints/cli.tsx?char=${++loads}`)
    return await waitFor(snapshot, done)
  } finally {
    exits.release()
  }
}

const printed = (run: Run) => run.stdout.length > 0

/** A help snapshot beside cli.tsx for the duration of `body`, the way the build puts one beside dist/cli.mjs. */
async function withHelpSnapshot(name: string, text: string, body: () => Promise<void>): Promise<void> {
  const path = join(ENTRY_DIR, name)
  if (existsSync(path)) throw new Error(`refusing to replace an existing ${path}`)
  writeFileSync(path, text)
  try {
    await body()
  } finally {
    rmSync(path, { force: true })
  }
}

describe('cli.tsx — the version fast path', () => {
  const cases = [
    { args: ['--version'], macro: { VERSION: '7.7.7-char' }, line: '7.7.7-char (Claudin)' },
    { args: ['-v'], macro: { VERSION: '7.7.7-char' }, line: '7.7.7-char (Claudin)' },
    { args: ['-V'], macro: { VERSION: '7.7.7-char' }, line: '7.7.7-char (Claudin)' },
    { args: ['--version'], macro: { VERSION: '7.7.7-char', DISPLAY_VERSION: '7.7.7 preview' }, line: '7.7.7 preview (Claudin)' },
  ]
  for (const c of cases) {
    test(`${c.args.join(' ')} with ${JSON.stringify(c.macro)} prints "${c.line}"`, async () => {
      globals.MACRO = c.macro
      const run = await runCli(c.args, printed)
      expect(run.stdout).toBe(`${c.line}\n`)
      expect(run.exitCodes).toEqual([])
    })
  }
})

describe('cli.tsx — the environment it sets up on load', () => {
  const cases = [
    { key: 'CLAUDIN_DISABLE_EXPERIMENTAL_BETAS', preset: undefined, after: 'true' },
    { key: 'CLAUDIN_DISABLE_EXPERIMENTAL_BETAS', preset: 'false', after: 'false' },
    { key: 'CLAUDIN_ENABLE_FINE_GRAINED_TOOL_STREAMING', preset: undefined, after: '1' },
    { key: 'CLAUDIN_ENABLE_FINE_GRAINED_TOOL_STREAMING', preset: '0', after: '0' },
    { key: 'COREPACK_ENABLE_AUTO_PIN', preset: undefined, after: '0' },
    { key: 'COREPACK_ENABLE_AUTO_PIN', preset: '1', after: '0' },
  ]
  for (const c of cases) {
    test(`${c.key}: ${c.preset ?? '(unset)'} -> ${c.after}`, async () => {
      if (c.preset === undefined) delete process.env[c.key]
      else process.env[c.key] = c.preset
      await runCli(['--version'], printed)
      expect(process.env[c.key]).toBe(c.after)
    })
  }
})

describe('cli.tsx — the help fast path', () => {
  const cases = [
    { args: ['--help'], snapshot: 'help.txt', argv: ['--help'] },
    { args: ['-h'], snapshot: 'help.txt', argv: ['-h'] },
    { args: ['-help'], snapshot: 'help.txt', argv: ['--help'] },
    { args: ['char-fixture-cmd', '-h'], snapshot: 'help-char-fixture-cmd.txt', argv: ['char-fixture-cmd', '-h'] },
    { args: ['char-fixture-cmd', '-help'], snapshot: 'help-char-fixture-cmd.txt', argv: ['char-fixture-cmd', '--help'] },
    { args: ['char-fixture-cmd', '--help'], snapshot: 'help-char-fixture-cmd.txt', argv: ['char-fixture-cmd', '--help'] },
  ]
  for (const c of cases) {
    test(`${c.args.join(' ')} serves ${c.snapshot} verbatim`, async () => {
      const text = `Usage: from ${c.snapshot}\n  no trailing newline added`
      await withHelpSnapshot(c.snapshot, text, async () => {
        const run = await runCli(c.args, printed)
        expect(run.stdout).toBe(text)
        expect(run.exitCodes).toEqual([])
        expect(run.argv).toEqual(c.argv)
      })
    })
  }
})
