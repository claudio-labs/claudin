/**
 * Shared ground for the `levers/boot` characterization suites: the CLI's boot
 * path (cli.tsx, init, the preAction hook, the resume branch, the dialog
 * launchers).
 *
 * - `trapExits()` turns `process.exit(code)` into a thrown `ExitRequest`, so
 *   a code path that ends the process can be followed to its end and its exit
 *   code read. The real `process.exit` is handed back by `release()`.
 * - `openScreen()` gives an Ink root drawing into a fake terminal, and
 *   `closeScreen()` takes it down by rejecting its exit promise, which stops
 *   `renderAndRun` before it reaches `gracefulShutdown`: that function runs
 *   once per process and would leave the whole run marked as shutting down.
 */
import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { init } from 'src/platform/entrypoints/init.js'
import { getClaudeTempDir } from 'src/platform/tmpdir.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { addProviderProfile } from 'src/providers/presets/providerProfiles.js'
import { envSnapshot, type EnvSnapshot } from 'src/sessions/__testutils__/lifecycleHarness.js'
import { type RestoreSandbox, useRestoreSandbox } from 'src/sessions/__testutils__/restoreHarness.js'
import instances from 'src/terminal/ink/instances.js'
import { createFakeTerminal, type FakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot, type Root } from 'src/terminal/ink.js'

const PROCESS_HOOKS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection'] as const

/**
 * The world `init()` runs in, set up per test: the restore sandbox (a temp
 * CLAUDIN_CONFIG_DIR and project, a fresh in-memory global config), a temp
 * CLAUDIN_TMPDIR, and a local OpenAI-compatible provider profile so nothing
 * reaches for Anthropic's servers. `init()` is made to run again in every
 * test, and the process handlers it installs are removed at the end of the
 * file. `envKeys` are put back after every test.
 */
export function useBootSandbox(envKeys: readonly string[] = []): RestoreSandbox {
  const sandbox = useRestoreSandbox()
  let env: EnvSnapshot
  let fileEnv: EnvSnapshot
  let handlersBefore: Map<string, Function[]>

  beforeAll(() => {
    fileEnv = envSnapshot(['CLAUDIN_TMPDIR', 'CLAUDIN_SCRATCHPAD'])
    handlersBefore = new Map(PROCESS_HOOKS.map(name => [name, [...process.listeners(name as never)] as Function[]]))
  })

  beforeEach(() => {
    env = envSnapshot(envKeys)
    delete process.env.CLAUDIN_SCRATCHPAD
    process.env.CLAUDIN_TMPDIR = join(sandbox.root, 'tmp')
    mkdirSync(process.env.CLAUDIN_TMPDIR)
    getClaudeTempDir.cache.clear?.()
    addProviderProfile({ provider: 'openai', name: 'Local stand-in', baseUrl: 'http://127.0.0.1:9/v1', model: 'stand-in' })
    invalidateActiveProviderCache()
    init.cache.clear?.()
  })

  afterEach(() => {
    env.restore()
    invalidateActiveProviderCache()
    getClaudeTempDir.cache.clear?.()
  })

  afterAll(() => {
    for (const name of PROCESS_HOOKS) {
      const kept = handlersBefore.get(name)!
      for (const handler of process.listeners(name as never) as Function[]) {
        if (!kept.includes(handler)) process.removeListener(name, handler as never)
      }
    }
    fileEnv.restore()
    getClaudeTempDir.cache.clear?.()
    init.cache.clear?.()
  })

  return sandbox
}

export class ExitRequest extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code}) requested`)
  }
}

export type ExitTrap = { readonly codes: Array<number | undefined>; release(): void }

/**
 * `returns: true` records the exit and lets the caller carry on instead of
 * throwing. That is for code with no caller to catch the throw (a module that
 * runs `void main()` on import), where the rejection would fail the test run.
 */
export function trapExits(options: { returns?: boolean } = {}): ExitTrap {
  const realExit = process.exit
  const codes: Array<number | undefined> = []
  process.exit = ((code?: number) => {
    codes.push(code)
    if (!options.returns) throw new ExitRequest(code)
  }) as typeof process.exit
  return {
    codes,
    release() {
      process.exit = realExit
      process.exitCode = 0
    },
  }
}

export type Screen = { root: Root; term: FakeTerminal }

export async function openScreen(columns = 100): Promise<Screen> {
  const term = createFakeTerminal({ columns })
  const root = await createRoot({
    stdout: term.stdout,
    stdin: term.stdin,
    stderr: term.stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  return { root, term }
}

/** The reason `closeScreen` gives the Ink instance; callers awaiting it see this. */
export const SCREEN_CLOSED = 'screen closed by the test'

export function closeScreen(screen: Screen): void {
  instances.get(screen.term.stdout)?.unmount(new Error(SCREEN_CLOSED))
  screen.term.close()
}

/** Resolves once `read()` satisfies `accept`, or throws with the last value seen. */
export async function waitFor<T>(read: () => T, accept: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (accept(value)) return value
    if (Date.now() > deadline) throw new Error(`gave up waiting; last value:\n${String(value)}`)
    await Bun.sleep(15)
  }
}

/** Settles `promise` into a plain record, so a test can assert on a rejection without a try. */
export async function outcome<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  try {
    return { value: await promise }
  } catch (error) {
    return { error }
  }
}
