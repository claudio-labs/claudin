/**
 * A private tmux server for the worktree characterization suites.
 *
 * The unit runs `tmux` by name with no socket option. The lab steers it with
 * TMUX_TMPDIR (and, for "already inside tmux", TMUX): every tmux the unit
 * starts then talks to `<lab dir>/tmux-<uid>/default`, a server the lab
 * started with no configuration file (`-f /dev/null`) and kills on close.
 *
 * One trap shapes the whole harness. Under Bun, `child_process.spawnSync`
 * called without an `env` option runs the child with the environment the
 * process STARTED with, not the current `process.env`. The unit spawns
 * `tmux -V`, `has-session` and `switch-client` that way. So:
 * - in the suite's own process those three reach whatever tmux the test
 *   runner was started next to. `IN_PROCESS_TMUX_IS_PRIVATE` says whether
 *   that is provably nothing (no TMUX, no server on the runner's socket);
 *   tests that let them run in-process are skipped otherwise;
 * - everything that depends on them runs in a driver: a fresh `bun test`
 *   process whose startup environment points at the lab's server.
 *
 * Pieces:
 * - a `keeper` session keeps the server alive between the unit's sessions;
 * - `attachViewer()` puts a real client on the keeper, from inside a pane,
 *   for the unit's `switch-client` to act on;
 * - a recorder is a program the unit can be made to launch in place of the
 *   CLI (through `process.execPath`); it writes down its working directory,
 *   its tmux session and its arguments, then waits for `release()`;
 * - `runDriver()` runs a snippet against the unit in a fresh process, either
 *   plainly or inside a pane, where standard input is a real terminal: the
 *   only place the unit's attaching `tmux new-session` can run without taking
 *   over the terminal the suite runs in.
 */

import { spawnSync } from 'child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import type { WorktreeLab } from 'src/vcs/git/__testutils__/worktreeLab.js'

/** The lab's own tmux, resolved once: tests may empty PATH to hide tmux from the unit. */
const TMUX = Bun.which('tmux')
export const TMUX_ON_PATH = TMUX !== null

/**
 * True when a tmux started with this process's startup environment finds no
 * server at all, and the runner is not itself inside tmux.
 */
export const IN_PROCESS_TMUX_IS_PRIVATE =
  TMUX_ON_PATH &&
  !process.env.TMUX &&
  spawnSync('tmux', ['list-sessions'], { encoding: 'utf-8' }).status !== 0

/** The bun binary running the suite, captured before any test swaps execPath. */
const BUN = process.execPath
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')

export type Recording = { cwd: string; session: string; args: string[] }

export type Recorder = {
  readonly program: string
  recording(): Recording | null
  waitForRecording(timeoutMs?: number): Promise<Recording>
  release(): void
}

export type ClientView = { session: string; control: boolean }

export type DriverOptions = {
  /** Session working directory for the call. */
  cwd: string
  /** An async function body; `unit` is the barrel, and console.log is collected. */
  body: string
  /** Startup environment changes: a string sets the variable, null removes it. */
  env: Record<string, string | null>
  /** What the unit sees as `process.execPath`. */
  program: string
  /** Run in a pane of the lab's server, with a terminal on standard input. */
  inPane: boolean
}

export type DriverResult = { outcome: unknown; logs: string[] }

export type TmuxLab = {
  readonly dir: string
  readonly socket: string
  tmux(...args: string[]): { ok: boolean; stdout: string; stderr: string }
  sessions(): string[]
  clients(): ClientView[]
  /** A value for TMUX that makes the unit believe it runs inside this server. */
  insideValue(): string
  attachViewer(): Promise<void>
  recorder(label: string): Recorder
  runDriver(options: DriverOptions): Promise<DriverResult>
  close(): void
}

export async function waitUntil<T>(
  read: () => T,
  accept: (value: T) => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (accept(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(25)
  }
}

function driverSource(options: DriverOptions, anchor: string, managed: string, resultFile: string): string {
  return [
    `import { test } from 'bun:test'`,
    `import { writeFileSync } from 'fs'`,
    `const root = ${JSON.stringify(REPO_ROOT)}`,
    `test('driver', async () => {`,
    `  const env = ${JSON.stringify(options.env)} as Record<string, string | null>`,
    `  for (const [name, value] of Object.entries(env)) {`,
    `    if (value === null) delete process.env[name]`,
    `    else process.env[name] = value`,
    `  }`,
    `  const state = await import(root + '/src/platform/bootstrap/state.ts')`,
    `  state.setOriginalCwd(${JSON.stringify(anchor)})`,
    `  state.setIsInteractive(false)`,
    `  const managedPath = await import(root + '/src/platform/settings/managedPath.ts')`,
    `  managedPath.getManagedFilePath.cache.set(undefined, ${JSON.stringify(managed)})`,
    `  managedPath.getManagedSettingsDropInDir.cache.set(undefined, ${JSON.stringify(join(managed, 'd'))})`,
    `  const { runWithCwdOverride } = await import(root + '/src/shared/fs/cwd.ts')`,
    `  const unit = await import(root + '/src/vcs/git/worktree.ts')`,
    `  const logs: string[] = []`,
    `  const log = console.log`,
    `  console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')) }`,
    `  process.execPath = ${JSON.stringify(options.program)}`,
    `  let outcome: unknown`,
    `  try {`,
    `    outcome = await runWithCwdOverride(${JSON.stringify(options.cwd)}, async () => {`,
    options.body,
    `    })`,
    `  } catch (error) {`,
    `    outcome = { threw: String(error) }`,
    `  } finally {`,
    `    console.log = log`,
    `  }`,
    `  writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ outcome, logs }))`,
    `}, 60_000)`,
    '',
  ].join('\n')
}

export function openTmuxLab(lab: WorktreeLab): TmuxLab {
  if (TMUX === null) throw new Error('tmux is not on PATH')
  const tmuxBinary = TMUX
  const dir = lab.git.tempDir('tmux')
  lab.env.set('TMUX_TMPDIR', dir)
  lab.env.set('TMUX', undefined)
  lab.env.set('TMUX_PANE', undefined)
  const socket = join(dir, `tmux-${process.getuid?.() ?? 0}`, 'default')
  let drivers = 0

  const started = Bun.spawnSync(
    [tmuxBinary, '-f', '/dev/null', 'new-session', '-d', '-s', 'keeper', '-x', '80', '-y', '24', '--', 'sleep', '3600'],
    { env: process.env, stdin: 'ignore' },
  )
  if (started.exitCode !== 0) {
    throw new Error(`could not start the lab's tmux server: ${started.stderr.toString()}`)
  }

  const tmux = (...args: string[]) => {
    const child = Bun.spawnSync([tmuxBinary, '-S', socket, ...args], { env: process.env, stdin: 'ignore' })
    return {
      ok: child.exitCode === 0,
      stdout: child.stdout.toString().replace(/\n$/, ''),
      stderr: child.stderr.toString(),
    }
  }

  const keeperId = tmux('display-message', '-p', '-t', '=keeper:', '#{session_id}').stdout.replace('$', '')

  const clients = (): ClientView[] => {
    const listed = tmux('list-clients', '-F', '#{client_session}\t#{client_control_mode}')
    if (!listed.ok || listed.stdout === '') return []
    return listed.stdout.split('\n').map(line => {
      const [session = '', control = '0'] = line.split('\t')
      return { session, control: control === '1' }
    })
  }

  return {
    dir,
    socket,
    tmux,
    sessions() {
      const listed = tmux('list-sessions', '-F', '#{session_name}')
      return listed.ok && listed.stdout !== '' ? listed.stdout.split('\n').sort() : []
    },
    clients,
    insideValue: () => `${socket},${process.pid},${keeperId}`,
    async attachViewer() {
      const before = clients().filter(c => c.session === 'keeper').length
      tmux('new-session', '-d', '-x', '100', '-y', '30', '--', 'env', '-u', 'TMUX', tmuxBinary, '-S', socket, 'attach', '-t', '=keeper')
      await waitUntil(clients, now => now.filter(c => c.session === 'keeper').length > before, 'a viewer client')
    },
    recorder(label) {
      const home = lab.git.tempDir(`rec-${label}`)
      const program = join(home, 'launched')
      writeFileSync(
        program,
        [
          '#!/bin/sh',
          `here='${home}'`,
          `session=$('${tmuxBinary}' display-message -p '#{session_name}')`,
          '{',
          '  printf "cwd\\t%s\\n" "$(pwd -P)"',
          '  printf "session\\t%s\\n" "$session"',
          '  for a in "$@"; do printf "arg\\t%s\\n" "$a"; done',
          '} > "$here/recording.part"',
          'mv "$here/recording.part" "$here/recording"',
          'n=0',
          'while [ ! -e "$here/release" ] && [ "$n" -lt 1200 ]; do sleep 0.05; n=$((n+1)); done',
          '',
        ].join('\n'),
      )
      chmodSync(program, 0o755)
      const read = (): Recording | null => {
        const file = join(home, 'recording')
        if (!existsSync(file)) return null
        const recording: Recording = { cwd: '', session: '', args: [] }
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          const tab = line.indexOf('\t')
          if (tab < 0) continue
          const [key, value] = [line.slice(0, tab), line.slice(tab + 1)]
          if (key === 'arg') recording.args.push(value)
          else if (key === 'cwd' || key === 'session') recording[key] = value
        }
        return recording
      }
      return {
        program,
        recording: read,
        async waitForRecording(timeoutMs = 20_000) {
          return (await waitUntil(read, r => r !== null, `${label} to be launched`, timeoutMs)) as Recording
        },
        release: () => writeFileSync(join(home, 'release'), ''),
      }
    },
    async runDriver(options) {
      drivers += 1
      const work = lab.git.tempDir(`driver-${drivers}`)
      const resultFile = join(work, 'result.json')
      const managed = lab.git.tempDir(`driver-managed-${drivers}`)
      const driverFile = join(work, 'driver.test.ts')
      writeFileSync(driverFile, driverSource(options, lab.anchor, managed, resultFile))
      let output: Promise<string> | null = null
      if (options.inPane) {
        const launched = tmux(
          'new-session', '-d', '-s', `driver-${drivers}`, '-x', '120', '-y', '40', '-c', REPO_ROOT,
          '--', BUN, 'test', driverFile,
        )
        if (!launched.ok) throw new Error(`could not start a driver: ${launched.stderr}`)
      } else {
        const startup: Record<string, string> = {}
        for (const [name, value] of Object.entries(process.env)) {
          if (value !== undefined) startup[name] = value
        }
        for (const [name, value] of Object.entries(options.env)) {
          if (value === null) delete startup[name]
          else startup[name] = value
        }
        const child = Bun.spawn([BUN, 'test', driverFile], {
          cwd: REPO_ROOT,
          env: startup,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        })
        output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(
          parts => parts.join('\n'),
        )
      }
      try {
        await waitUntil(() => existsSync(resultFile), done => done, `driver ${drivers} to finish`, 45_000)
      } catch (error) {
        const said = output ? await Promise.race([output, Bun.sleep(1_000).then(() => '')]) : ''
        throw new Error(`${(error as Error).message}\n${said}`)
      }
      return JSON.parse(readFileSync(resultFile, 'utf8')) as DriverResult
    },
    close() {
      try {
        tmux('kill-server')
      } catch {
        // The server is gone already; nothing of the user's was ever involved.
      }
    },
  }
}
