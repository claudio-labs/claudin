/**
 * Mounts the whole <REPL> on the project's fake terminal and lets a test use it
 * the way a person at the keyboard would: type, press keys, read the screen.
 *
 * Each mount gets its own scratch directory. The config dir, HOME, TMPDIR and
 * the session's working directory all point inside it, so nothing the REPL
 * writes (history, global config, a rendered transcript) lands in the real
 * home directory or in this checkout. `release()` puts every one of them back.
 *
 * The app store is exposed through a probe rendered next to the REPL, inside
 * the same provider: a test may seed state the way main.tsx does before the
 * first render, and read back what the REPL wrote into it.
 *
 * The module mocks the REPL needs (preventSleep, IDE, swarm, ...) are the ones
 * replTestHarness.ts installs; call its setup/teardown around these mounts.
 */
import * as React from 'react'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeTerminal, type FakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot, Text } from 'src/terminal/ink.js'
import type { Command } from 'src/commands/commands.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from 'src/shared/types/command.js'
import { AppStateProvider, useAppStateStore } from 'src/terminal/state/AppState.js'
import { getDefaultAppState, type AppState } from 'src/terminal/state/AppStateStore.js'
import { REPL, type Props } from 'src/agent/repl/REPL.js'
import { mockReplProps } from 'src/agent/repl/__testutils__/replTestHarness.js'
import { getCwdState, getOriginalCwd, setCwdState, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import { clearCommandQueue } from 'src/agent/messageQueueManager.js'
import { __resetSidePanelStoreForTests } from 'src/terminal/sidePanelStore.js'

export const KEY = {
  enter: '\r',
  escape: '\u001B',
  left: '\u001B[D',
  up: '\u001B[A',
  pageUp: '\u001B[5~',
  ctrlO: '\u000F',
  ctrlS: '\u0013',
} as const

type Store = ReturnType<typeof useAppStateStore>

export type LiveRepl = {
  /** The scratch directory standing in for the project and for HOME. */
  dir: string
  configDir: string
  terminal: FakeTerminal
  store: () => Store
  screen: () => string
  /** Types text, then lets the renderer take it in. */
  type: (input: string) => Promise<void>
  /** Polls the screen (or any condition) until it holds. */
  waitFor: (what: string, check: (screen: string) => boolean, withinMs?: number) => Promise<string>
  rerender: (props: Partial<Props>) => void
  release: () => void
}

export type MountOptions = {
  props?: Partial<Props>
  state?: (base: AppState) => AppState
  columns?: number
  /** Extra variables for this mount; undefined unsets one. Restored on release. */
  env?: Record<string, string | undefined>
  /** Runs once the scratch directory exists, before the REPL mounts. */
  prepare?: (paths: { dir: string; configDir: string }) => void
}

const ENV_KEYS = ['CLAUDIN_CONFIG_DIR', 'HOME', 'TMPDIR'] as const

/** The painted frame, with the prompt's no-break spaces read as plain ones. */
function readScreen(terminal: FakeTerminal): string {
  return terminal.screen().replaceAll('\u00A0', ' ')
}

const live = new Set<LiveRepl>()

export async function mountLiveRepl(options: MountOptions = {}): Promise<LiveRepl> {
  const dir = mkdtempSync(join(tmpdir(), 'repl-live-'))
  const configDir = join(dir, 'config')
  const scratchTmp = join(dir, 'tmp')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(scratchTmp, { recursive: true })

  const extraKeys = Object.keys(options.env ?? {})
  const savedEnv = [...ENV_KEYS, ...extraKeys].map(key => [key, process.env[key]] as const)
  const savedCwd = process.cwd
  const savedOriginal = getOriginalCwd()
  const savedState = getCwdState()
  process.env.CLAUDIN_CONFIG_DIR = configDir
  process.env.HOME = dir
  process.env.TMPDIR = scratchTmp
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  process.cwd = () => dir
  setOriginalCwd(dir)
  setCwdState(dir)
  clearCommandQueue()
  __resetSidePanelStoreForTests()
  options.prepare?.({ dir, configDir })

  const terminal = createFakeTerminal({ columns: options.columns ?? 100 })
  const root = await createRoot({
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  })

  let store: Store | undefined
  function StoreProbe(): null {
    store = useAppStateStore()
    return null
  }
  const initialState = options.state ? options.state(getDefaultAppState()) : undefined
  const draw = (props: Partial<Props>): void => {
    root.render(
      <AppStateProvider initialState={initialState}>
        <StoreProbe />
        <REPL {...mockReplProps(props)} />
      </AppStateProvider>,
    )
  }
  let currentProps = options.props ?? {}
  draw(currentProps)

  const waitFor: LiveRepl['waitFor'] = async (what, check, withinMs = 10_000) => {
    const deadline = performance.now() + withinMs
    for (;;) {
      const now = readScreen(terminal)
      if (check(now)) return now
      if (performance.now() > deadline) {
        throw new Error(`timed out waiting for ${what}; the screen was:\n${now}`)
      }
      await Bun.sleep(10)
    }
  }

  let released = false
  const handle: LiveRepl = {
    dir,
    configDir,
    terminal,
    store: () => {
      if (!store) throw new Error('the REPL has not rendered yet')
      return store
    },
    screen: () => readScreen(terminal),
    type: async input => {
      terminal.type(input)
      await Bun.sleep(input.startsWith('\u001B') && input.length === 1 ? 120 : 40)
    },
    waitFor,
    rerender: props => {
      currentProps = { ...currentProps, ...props }
      draw(currentProps)
    },
    release: () => {
      if (released) return
      released = true
      live.delete(handle)
      root.unmount()
      terminal.close()
      clearCommandQueue()
      __resetSidePanelStoreForTests()
      process.cwd = savedCwd
      setOriginalCwd(savedOriginal)
      setCwdState(savedState)
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
  live.add(handle)
  // The prompt is the last thing to mount; until it shows, keys go nowhere.
  await waitFor('the prompt', screen => screen.includes('❯'))
  return handle
}

export function releaseAllRepls(): void {
  for (const repl of [...live]) repl.release()
}

export type CommandRun = {
  args: string
  done: LocalJSXCommandOnDone
  context: LocalJSXCommandContext
}

/**
 * A local-jsx slash command for the REPL's `commands` prop. Every run is kept,
 * so a test can close the command (`done`) or reach into the context the REPL
 * handed it. `view` decides what the command shows: null shows nothing, and
 * undefined (or no `view`) shows "<name> view: <args>".
 */
export function fixtureCommand(
  name: string,
  options: {
    immediate?: boolean
    view?: (run: CommandRun) => React.ReactNode | null | undefined
  } = {},
): { command: Command; runs: CommandRun[] } {
  const runs: CommandRun[] = []
  const command = {
    type: 'local-jsx',
    name,
    description: `fixture command ${name}`,
    immediate: options.immediate,
    isEnabled: () => true,
    isHidden: false,
    load: async () => ({
      call: async (done: LocalJSXCommandOnDone, context: LocalJSXCommandContext, args: string) => {
        const run = { args, done, context }
        runs.push(run)
        const shown = options.view?.(run)
        return shown === undefined ? <Text>{`${name} view: ${args}`}</Text> : shown
      },
    }),
  } as unknown as Command
  return { command, runs }
}

/** The prompt row: the first line below the first full-width rule. */
export function promptRow(screen: string): string {
  const lines = screen.split('\n')
  const rule = lines.findIndex(line => /^─{20,}$/.test(line.trim()))
  return rule === -1 ? '' : (lines[rule + 1] ?? '').trimEnd()
}

/** What the transcript shows: everything above the prompt's rule. */
export function transcriptPart(screen: string): string {
  const lines = screen.split('\n')
  const rule = lines.findIndex(line => /^─{20,}$/.test(line.trim()))
  return (rule === -1 ? lines : lines.slice(0, rule)).join('\n')
}

/**
 * Key handlers switch on in an effect after the paint that shows them (the
 * spinner's Esc, the transcript's keys), so a key sent the moment that frame
 * appears can arrive before anything listens for it.
 */
export function settle(): Promise<void> {
  return Bun.sleep(150)
}

/** A promise a test settles by hand, for holding a turn open. */
export function gate<T>(): { promise: Promise<T>; open: (value: T) => void } {
  let open!: (value: T) => void
  const promise = new Promise<T>(resolve => {
    open = resolve
  })
  return { promise, open }
}
