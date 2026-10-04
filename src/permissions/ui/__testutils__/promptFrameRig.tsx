/**
 * Shared rig for the permissions/promptFrame characterization suites.
 *
 * It puts a permission component on a fake terminal inside the two providers
 * every dialog runs under in the app (the app state and the key bindings),
 * presses real keys, and keeps a ledger of what the component reported to its
 * caller. The app state is followed through the provider's change callback,
 * so a test can read what the component wrote there.
 */
import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test'
import chalk from 'chalk'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import { getOriginalCwd, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from 'src/platform/settings/managedPath.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { createFakeTerminal, lastPaintedFrame } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot } from 'src/terminal/ink.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { type AppState, getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

/** Mounting a real Ink root and waiting on key parsing is slow on a busy machine. */
export const SLOW = 30_000

export const KEYS = {
  enter: '\r',
  esc: '\x1B',
  tab: '\t',
  up: '\x1B[A',
  down: '\x1B[B',
  ctrlC: '\x03',
} as const

// --- an isolated world -------------------------------------------------------

export type World = { home: string; project: string; config: string }

/**
 * A fresh config home, project directory and managed-settings directory for
 * every test, so nothing is read from the user's files or from this
 * repository's own `.claudin`.
 */
export function isolatedWorld(): () => World {
  let world: World | undefined
  const before = { cwd: '', configDir: undefined as string | undefined }
  beforeAll(() => {
    before.cwd = getOriginalCwd()
    before.configDir = process.env.CLAUDIN_CONFIG_DIR
  })
  beforeEach(() => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'prompt-frame-')))
    world = { home, project: join(home, 'project'), config: join(home, 'config') }
    for (const dir of [world.project, world.config, join(home, 'managed')]) mkdirSync(dir)
    process.env.CLAUDIN_CONFIG_DIR = world.config
    setOriginalCwd(world.project)
    getManagedFilePath.cache.set(undefined, join(home, 'managed'))
    getManagedSettingsDropInDir.cache.set(undefined, join(home, 'managed', 'managed-settings.d'))
    resetSettingsCache()
  })
  afterEach(() => {
    getManagedFilePath.cache.delete(undefined)
    getManagedSettingsDropInDir.cache.delete(undefined)
    setOriginalCwd(before.cwd)
    resetSettingsCache()
    if (world) rmSync(world.home, { recursive: true, force: true })
    world = undefined
  })
  afterAll(() => {
    if (before.configDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
    else process.env.CLAUDIN_CONFIG_DIR = before.configDir
  })
  return () => {
    if (!world) throw new Error('the world exists only inside a test')
    return world
  }
}

/** Truecolor output for the tests that read colours, put back afterwards. */
export function withTruecolor(): void {
  let level = chalk.level
  beforeAll(() => {
    level = chalk.level
    chalk.level = 3
  })
  afterAll(() => {
    chalk.level = level
  })
}

// --- mounting -----------------------------------------------------------------

export type Screen = {
  /** The last painted frame as plain text. */
  text: () => string
  /** The last painted frame with its escape codes. */
  styled: () => string
  /** The app state as the component last left it. */
  state: () => AppState
  /** Sends keys one at a time and lets each one land. */
  press: (...keys: string[]) => Promise<void>
  /** Waits until the plain frame passes the check. */
  until: (check: (frame: string) => boolean, what: string) => Promise<string>
  /** Renders another element into the same root, keeping the providers. */
  replace: (node: React.ReactNode) => Promise<void>
  close: () => Promise<void>
}

type MountOptions = { columns?: number; appState?: Partial<AppState>; ready?: (frame: string) => boolean }

const open: Screen[] = []
afterEach(async () => {
  while (open.length > 0) await open.pop()!.close()
})

export async function mount(node: React.ReactNode, options: MountOptions = {}): Promise<Screen> {
  const terminal = createFakeTerminal({ columns: options.columns ?? 80 })
  const root = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, patchConsole: false, exitOnCtrlC: false })
  let current: AppState = { ...getDefaultAppState(), ...options.appState }
  const initial = current
  const wrap = (inner: React.ReactNode) => (
    <AppStateProvider initialState={initial} onChangeAppState={({ newState }) => (current = newState)}>
      <KeybindingSetup>
        <React.Suspense fallback={null}>{inner}</React.Suspense>
      </KeybindingSetup>
    </AppStateProvider>
  )
  root.render(wrap(node))

  const text = () => terminal.screen()
  const until = async (check: (frame: string) => boolean, what: string) => {
    const deadline = Date.now() + 8_000
    for (;;) {
      const frame = text()
      if (check(frame)) return frame
      if (Date.now() > deadline) throw new Error(`waited in vain for ${what}; the screen shows:\n${frame}`)
      await Bun.sleep(15)
    }
  }
  let closed = false
  const screen: Screen = {
    text,
    styled: () => lastPaintedFrame(terminal.transcript()),
    state: () => current,
    until,
    press: async (...keys) => {
      for (const key of keys) {
        terminal.type(key)
        // A bare ESC is only known to be one after the parser's pause.
        await Bun.sleep(key === KEYS.esc ? 150 : 70)
      }
      await Bun.sleep(60)
    },
    replace: async next => {
      root.render(wrap(next))
      await Bun.sleep(120)
    },
    close: async () => {
      if (closed) return
      closed = true
      root.unmount()
      terminal.close()
      await Bun.sleep(0)
    },
  }
  open.push(screen)
  await until(options.ready ?? (frame => frame.trim() !== ''), 'the first paint')
  // Key handlers subscribe in an effect that runs after the first paint.
  await Bun.sleep(150)
  return screen
}

// --- reading the screen ---------------------------------------------------------

/** The frame's lines with their right padding removed. */
export const linesOf = (frame: string) => frame.split('\n').map(line => line.trimEnd())

/** The frame squeezed to single spaces, for checking that words stay together and in order. */
export const flat = (frame: string) => frame.replace(/\s+/g, ' ').trim()

/** The opening SGR codes that sit right before `text` in a styled frame. */
export function styleBefore(styled: string, text: string): string {
  const at = styled.indexOf(text)
  if (at < 0) throw new Error(`${JSON.stringify(text)} is not on the screen:\n${stripAnsi(styled)}`)
  const codes = styled.slice(0, at).match(/(?:\u001B\[[0-9;]*m)+$/)
  return codes?.[0] ?? ''
}
