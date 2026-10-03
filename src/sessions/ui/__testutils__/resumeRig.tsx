/**
 * What the `sessions/ui` characterization suites stand on: the startup
 * session picker (`ResumeConversation`) and its preview, mounted the way
 * `claudin --resume` mounts them — inside the app shell and the key-binding
 * provider — on the project's fake terminal.
 *
 * Sessions are real transcripts. `placeSession()` copies the fixture
 * transcript (written by the real session writer, see `__fixtures__/rewrite/`)
 * into the projects directory under the temp config dir, as a session of the
 * given project, with its id, title, PR link and age rewritten as asked.
 *
 * The picker ends the process on its own in three places. `useResumeWorld()`
 * turns those `process.exit` calls into a recorded list, keeps the clipboard
 * away from the developer's real one, and catches what the picker writes to
 * the real stdout.
 */
import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import React from 'react'
import { App } from 'src/agent/ui/App.js'
import { type ExitTrap, trapExits, useBootSandbox } from 'src/platform/main/__testutils__/bootHarness.js'
import type { RestoreSandbox } from 'src/sessions/__testutils__/restoreHarness.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'
import { ResumeConversation } from 'src/sessions/ui/ResumeConversation.js'
import { createFakeTerminal, type FakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createStatsStore } from 'src/terminal/contexts/stats.js'
import instances from 'src/terminal/ink/instances.js'
import { createRoot } from 'src/terminal/ink.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { type AppState, useAppStateStore } from 'src/terminal/state/AppState.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

export const FIXTURE = join(import.meta.dir, '..', '__fixtures__', 'rewrite', 'resume', 'parser-rewrite.jsonl')
/** The session id, project path and title the fixture was written with. */
export const FIXTURE_ID = 'aeff62ea-64ed-4fe8-988a-8b604b28e83c'
export const FIXTURE_PROJECT = '/work/fixture'
export const FIXTURE_TITLE = 'Parser rewrite'

export const KEYS = {
  enter: '\r',
  escape: '\x1b',
  down: '\x1b[B',
  ctrlA: '\x01',
  ctrlB: '\x02',
  ctrlC: '\x03',
  ctrlR: '\x12',
  ctrlV: '\x16',
} as const

export type ResumeWorld = {
  sandbox: RestoreSandbox
  exits: () => Array<number | undefined>
  /** Everything written to the process's real stdout while the test ran. */
  stdout: () => string
}

/** Variables the picker's paths read; each test starts from these values, and gets the old ones back. */
const WORLD_ENV: Record<string, string | undefined> = {
  // With SSH_CONNECTION set and no TMUX, a copy is only an OSC 52 sequence on
  // stdout: no native clipboard tool and no tmux buffer are touched.
  SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22',
  TMUX: undefined,
  STY: undefined,
  CLAUDIN_DISABLE_BACKGROUND_TASKS: undefined,
  CLAUDIN_DISABLE_FILE_CHECKPOINTING: undefined,
  // A resumed session opens the REPL, whose startup checks would otherwise
  // reach out to install the plugin marketplace.
  CLAUDIN_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
  CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC: '1',
}

export function useResumeWorld(): ResumeWorld {
  let trap: ExitTrap | undefined
  let realWrite: typeof process.stdout.write | undefined
  let written = ''
  let macro: unknown

  // Hooks of one kind run in the order they are registered. This one comes
  // before the sandbox's, so the screens are down before the sandbox removes
  // the directories they were using.
  afterEach(async () => {
    await closeAllPickers()
    trap?.release()
    if (realWrite) process.stdout.write = realWrite
  })

  const sandbox = useBootSandbox(Object.keys(WORLD_ENV))

  beforeAll(() => {
    // MACRO is inlined by the bundler; under bun test the REPL reads it from globalThis.
    macro = (globalThis as Record<string, unknown>).MACRO
    ;(globalThis as Record<string, unknown>).MACRO = {
      ...((macro as object | undefined) ?? {}),
      VERSION: '0.0.0-resume',
      DISPLAY_VERSION: '0.0.0-resume',
      BUILD_TIME: 'resume-suite',
    }
  })

  beforeEach(() => {
    const present = Object.entries(WORLD_ENV).filter((entry): entry is [string, string] => entry[1] !== undefined)
    const absent = Object.keys(WORLD_ENV).filter(name => WORLD_ENV[name] === undefined)
    absent.forEach(name => Reflect.deleteProperty(process.env, name))
    Object.assign(process.env, Object.fromEntries(present))
    written = ''
    realWrite = process.stdout.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      return true
    }) as typeof process.stdout.write
    trap = trapExits({ returns: true })
  })

  afterAll(() => {
    ;(globalThis as Record<string, unknown>).MACRO = macro
  })

  return {
    sandbox,
    exits: () => [...(trap?.codes ?? [])],
    stdout: () => written,
  }
}

export type SessionCopy = {
  /** The project the session belongs to; its transcript goes under that project's directory. */
  project: string
  id?: string
  title?: string
  /** The linked PR number, or null for no link. Default: the fixture's #17. */
  pr?: number | null
  sidechain?: boolean
  /** The git branch the messages were written on, or null for none. Default: `parser-fix`. */
  branch?: string | null
  /** A further user message appended after the fixture's last one. */
  reply?: string
  /** How long ago the transcript was last written. Default: 30 minutes. */
  minutesAgo?: number
}

/** The fixture's last message, which an appended user message answers. */
const FIXTURE_LEAF = 'da633dc2-7d49-43ac-93d5-776300498786'

function userLine(sessionId: string, content: string) {
  return {
    parentUuid: FIXTURE_LEAF,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content },
    uuid: randomUUID(),
    timestamp: '2026-10-03T18:00:00.000Z',
    userType: 'external',
    entrypoint: 'cli',
    cwd: FIXTURE_PROJECT,
    sessionId,
    version: 'unknown',
  }
}

/** Copies the fixture in as a session of `copy.project`; returns the session id and transcript path. */
export function placeSession(copy: SessionCopy): { id: string; transcript: string } {
  const id = copy.id ?? randomUUID()
  let text = readFileSync(FIXTURE, 'utf8').replaceAll(FIXTURE_ID, id)
  if (copy.title !== undefined) text = text.replaceAll(`"customTitle":"${FIXTURE_TITLE}"`, `"customTitle":"${copy.title}"`)
  if (copy.pr === null) {
    text = text
      .split('\n')
      .filter(line => !line.includes('"type":"pr-link"'))
      .join('\n')
  } else if (copy.pr !== undefined) {
    text = text.replaceAll('"prNumber":17', `"prNumber":${copy.pr}`).replaceAll('/pull/17', `/pull/${copy.pr}`)
  }
  if (copy.sidechain) text = text.replaceAll('"isSidechain":false', '"isSidechain":true')
  if (copy.branch === null) text = text.replaceAll(',"gitBranch":"parser-fix"', '')
  else if (copy.branch !== undefined) text = text.replaceAll('"gitBranch":"parser-fix"', `"gitBranch":"${copy.branch}"`)
  if (copy.reply !== undefined) text += `${JSON.stringify(userLine(id, copy.reply))}\n`
  const dir = getProjectDir(copy.project)
  mkdirSync(dir, { recursive: true })
  const transcript = join(dir, `${id}.jsonl`)
  writeFileSync(transcript, text)
  const at = new Date(Date.now() - (copy.minutesAgo ?? 30) * 60_000)
  utimesSync(transcript, at, at)
  return { id, transcript }
}

export type PickerProps = Partial<React.ComponentProps<typeof ResumeConversation>>

export type Picker = {
  term: FakeTerminal
  screen: () => string
  /** Every byte painted so far, escape codes included: frames that came and went are in it. */
  painted: () => string
  state: () => AppState
  setState: (update: (prev: AppState) => AppState) => void
  press: (...keys: string[]) => Promise<void>
  type: (text: string) => Promise<void>
  waitFor: (what: string | ((screen: string) => boolean), withinMs?: number) => Promise<string>
  close: () => Promise<void>
}

const open = new Set<Picker>()

async function closeAllPickers(): Promise<void> {
  for (const picker of [...open]) await picker.close()
}

/** Mounts `children` in the app shell and key-binding provider, on a fake terminal. */
export async function mountInApp(
  children: React.ReactNode,
  options: { columns?: number; rows?: number; initialState?: AppState } = {},
): Promise<Picker> {
  const term = createFakeTerminal({ columns: options.columns ?? 120 })
  Object.assign(term.stdout, { rows: options.rows ?? 24 })
  const root = await createRoot({
    stdout: term.stdout,
    stdin: term.stdin,
    stderr: term.stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  let store: ReturnType<typeof useAppStateStore> | undefined
  function StoreWindow(): null {
    store = useAppStateStore()
    return null
  }
  root.render(
    <App getFpsMetrics={() => undefined} stats={createStatsStore()} initialState={options.initialState ?? getDefaultAppState()}>
      <KeybindingSetup>
        <StoreWindow />
        {children}
      </KeybindingSetup>
    </App>,
  )
  const screen = () => term.screen().replaceAll('\u00A0', ' ')
  let closed = false
  const picker: Picker = {
    term,
    screen,
    painted: () => term.transcript(),
    state: () => {
      if (!store) throw new Error('the app has not rendered yet')
      return store.getState()
    },
    setState: update => {
      if (!store) throw new Error('the app has not rendered yet')
      store.setState(update)
    },
    press: async (...keys) => {
      for (const key of keys) {
        term.type(key)
        await Bun.sleep(key === KEYS.escape ? 150 : 60)
      }
    },
    type: async text => {
      for (const char of text) {
        term.type(char)
        await Bun.sleep(25)
      }
      await Bun.sleep(60)
    },
    waitFor: async (what, withinMs = 10_000) => {
      const accept = typeof what === 'string' ? (s: string) => s.includes(what) : what
      const deadline = Date.now() + withinMs
      for (;;) {
        const now = screen()
        if (accept(now)) return now
        if (Date.now() > deadline) throw new Error(`gave up waiting for ${String(what)}; the screen was:\n${now}`)
        await Bun.sleep(15)
      }
    },
    close: async () => {
      if (closed) return
      closed = true
      open.delete(picker)
      instances.get(term.stdout)?.unmount()
      term.close()
      await Bun.sleep(20)
    },
  }
  open.add(picker)
  return picker
}

/** The startup picker over `worktreePaths` (default: the sandbox project alone). */
export async function mountPicker(
  world: ResumeWorld,
  props: PickerProps = {},
  options: { columns?: number; rows?: number; initialState?: AppState } = {},
): Promise<Picker> {
  const picker = await mountInApp(
    <ResumeConversation
      commands={[]}
      initialTools={[]}
      debug={false}
      thinkingConfig={{ type: 'disabled' }}
      worktreePaths={[world.sandbox.projectDir]}
      {...props}
    />,
    options,
  )
  return picker
}

/** Waits for the list, then for its key handlers: a key sent before they subscribe is lost. */
export async function listed(picker: Picker, text: string): Promise<string> {
  const shown = await picker.waitFor(text)
  await Bun.sleep(150)
  return shown
}
