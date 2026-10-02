/**
 * Characterization of the /config pane (src/platform/settings/ui/Config.tsx),
 * pinned before the levers cut removes its Remote Control row.
 *
 * The pane is mounted in a fake terminal and driven only by keys. What is
 * asserted is what a user can see or what the pane leaves behind: the frame,
 * the global config (held in memory under NODE_ENV=test), the settings.json
 * files it writes (real files in a temp tree), the app state, and the message
 * it closes with.
 *
 * Paths and switches the pane reads all point into a fresh temp tree per test:
 * CLAUDIN_CONFIG_DIR, the session's original directory, the admin directory
 * memo, and every environment variable that changes which rows are shown.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import { clearMemoryFileCaches } from 'src/memory/instructions/claudemd.js'
import { getAllowedSettingSources, getOriginalCwd, setAllowedSettingSources, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { resetGlobalConfigForTests } from 'src/platform/config/config/globalConfig.js'
import type { GlobalConfig } from 'src/platform/config/config/types.js'
import { isSupportedTerminal } from 'src/platform/ide/ide.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from 'src/platform/settings/managedPath.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { Config } from 'src/platform/settings/ui/Config.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { createFakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot } from 'src/terminal/ink.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { type AppState, getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

const SLOW = 60_000

const KEY = {
  enter: '\r',
  esc: '\x1B',
  space: ' ',
  tab: '\t',
  up: '\x1B[A',
  down: '\x1B[B',
  right: '\x1B[C',
  left: '\x1B[D',
} as const

/** Every variable that decides which rows exist or how they read. */
const ENV = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC',
  'ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_AUTOUPDATER',
  'DISABLE_TELEMETRY',
  'CLAUDIN_NO_FLICKER',
  'CLAUDIN_FPS',
  'CLAUDIN_DISABLE_FILE_CHECKPOINTING',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'CLAUDE_CODE_USE_COWORK_PLUGINS',
] as const

type Closed = { message: string | undefined; display: string | undefined }

/** The build inlines MACRO.VERSION; under bun test it is a global this file provides. */
const BUILD_VERSION = '9.8.7-char'
type WithMacro = { MACRO?: { VERSION: string } }

let tree: { root: string; config: string; project: string; admin: string }
const kept = {
  env: {} as Record<string, string | undefined>,
  cwd: '',
  sources: [] as ReturnType<typeof getAllowedSettingSources>,
  /** The global config as this file found it, and the clean one each test starts from. */
  outer: {} as Record<string, unknown>,
  config: {} as Record<string, unknown>,
}

/**
 * Under NODE_ENV=test the global config is one object held in memory, and a
 * save merges into it, so a key a test added would outlive the test. Put the
 * object back to exactly what it was.
 */
function restoreGlobalConfig(to: Record<string, unknown> = kept.config): void {
  const live = getGlobalConfig() as unknown as Record<string, unknown>
  for (const key of Object.keys(live)) if (!(key in to)) delete live[key]
  Object.assign(live, structuredClone(to))
  invalidateActiveProviderCache()
}

let macroBefore: WithMacro['MACRO']

beforeAll(() => {
  macroBefore = (globalThis as WithMacro).MACRO
  ;(globalThis as WithMacro).MACRO = { ...macroBefore, VERSION: BUILD_VERSION }
  for (const name of ENV) kept.env[name] = process.env[name]
  kept.cwd = getOriginalCwd()
  kept.sources = [...getAllowedSettingSources()]
  kept.outer = structuredClone(getGlobalConfig()) as unknown as Record<string, unknown>
  resetGlobalConfigForTests()
  kept.config = structuredClone(getGlobalConfig()) as unknown as Record<string, unknown>
})

afterAll(() => {
  if (macroBefore === undefined) delete (globalThis as WithMacro).MACRO
  else (globalThis as WithMacro).MACRO = macroBefore
  for (const name of ENV) {
    if (kept.env[name] === undefined) delete process.env[name]
    else process.env[name] = kept.env[name]
  }
  setOriginalCwd(kept.cwd)
  setAllowedSettingSources(kept.sources)
  restoreGlobalConfig(kept.outer)
  resetSettingsCache()
  clearMemoryFileCaches()
})

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'config-pane-')))
  tree = { root, config: join(root, 'cfg'), project: join(root, 'repo'), admin: join(root, 'admin') }
  for (const dir of [tree.config, tree.project, tree.admin]) mkdirSync(dir)
  for (const name of ENV) delete process.env[name]
  process.env.CLAUDIN_CONFIG_DIR = tree.config
  setOriginalCwd(tree.project)
  setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings'])
  getManagedFilePath.cache.set(undefined, tree.admin)
  getManagedSettingsDropInDir.cache.set(undefined, join(tree.admin, 'managed-settings.d'))
  // Which IDE row exists depends on the terminal running the tests; pin it.
  isSupportedTerminal.cache.set(undefined, false)
  restoreGlobalConfig()
  resetSettingsCache()
  clearMemoryFileCaches()
})

afterEach(() => {
  isSupportedTerminal.cache.delete(undefined)
  getManagedFilePath.cache.delete(undefined)
  getManagedSettingsDropInDir.cache.delete(undefined)
  setOriginalCwd(kept.cwd)
  rmSync(tree.root, { recursive: true, force: true })
})

// --- files -----------------------------------------------------------------

const userFile = () => join(tree.config, 'settings.json')
const localFile = () => join(tree.project, '.claudin', 'settings.local.json')

function writeJson(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
  resetSettingsCache()
}

function readJson(path: string): Record<string, unknown> | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

function seedConfig(patch: Partial<GlobalConfig>): void {
  saveGlobalConfig(current => ({ ...current, ...patch }))
  invalidateActiveProviderCache()
}

// --- the pane --------------------------------------------------------------

/** The list owns the keys again: its footer is back. */
const inList = (frame: string) => frame.includes('Space to change · Enter to save')

type Pane = {
  frame: () => string
  /** Sends keys one at a time, letting each one land. */
  press: (...keys: string[]) => Promise<void>
  /** Types a search query from search mode and moves to its first match. */
  pick: (query: string) => Promise<void>
  until: (check: (frame: string) => boolean, what: string) => Promise<string>
  value: (label: string) => string | undefined
  closed: Closed[]
  tabsHidden: boolean[]
  ownsEsc: boolean[]
  state: () => AppState
  dispose: () => Promise<void>
}

type MountOptions = {
  height?: number
  messages?: Array<{ type: string }>
  mcpClients?: Array<{ type: string; name: string }>
  appState?: Partial<AppState>
}

const mounted: Pane[] = []
afterEach(async () => {
  while (mounted.length > 0) await mounted.pop()!.dispose()
})

async function mount(options: MountOptions = {}): Promise<Pane> {
  const terminal = createFakeTerminal({ columns: 110 })
  const ink = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, patchConsole: false })
  const closed: Closed[] = []
  const tabsHidden: boolean[] = []
  const ownsEsc: boolean[] = []
  let current: AppState = { ...getDefaultAppState(), ...options.appState }
  const initial = current

  ink.render(
    <AppStateProvider initialState={initial} onChangeAppState={({ newState }) => (current = newState)}>
      <KeybindingSetup>
        <React.Suspense fallback={null}>
          <Config
            onClose={(message, opts) => closed.push({ message: message === undefined ? undefined : stripAnsi(message), display: opts?.display })}
            context={{ options: { mcpClients: options.mcpClients ?? [] }, messages: options.messages ?? [] } as never}
            setTabsHidden={hidden => tabsHidden.push(hidden)}
            onIsSearchModeChange={owns => ownsEsc.push(owns)}
            contentHeight={options.height ?? 80}
          />
        </React.Suspense>
      </KeybindingSetup>
    </AppStateProvider>,
  )

  const frame = () => terminal.screen()
  const until = async (check: (f: string) => boolean, what: string): Promise<string> => {
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      const now = frame()
      if (check(now)) return now
      await Bun.sleep(15)
    }
    throw new Error(`timed out waiting for ${what}. Last frame:\n${frame()}`)
  }
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      terminal.type(key)
      // A lone ESC is only told apart from a sequence after a pause.
      await Bun.sleep(key === KEY.esc ? 120 : 60)
    }
  }
  const value = (label: string): string | undefined => {
    for (const line of frame().split('\n')) {
      const body = line.replace(/^[❯ ]\s?/, '').trimStart()
      if (body.startsWith(label + ' ')) return body.slice(label.length).trim()
    }
    return undefined
  }
  const pick = async (query: string) => {
    await press(query)
    await until(f => f.includes(`⌕ ${query}`), `the query ${query}`)
    await press(KEY.enter)
    await until(f => f.includes('Space to change'), 'list mode')
  }
  const pane: Pane = {
    frame,
    press,
    pick,
    until,
    value,
    closed,
    tabsHidden,
    ownsEsc,
    state: () => current,
    dispose: async () => {
      ink.unmount()
      terminal.close()
      await Bun.sleep(0)
    },
  }
  mounted.push(pane)
  await until(f => f.includes('Search settings'), 'the pane')
  // The first paint lands before the input handlers are attached.
  await Bun.sleep(150)
  return pane
}

describe('first paint', () => {
  test(
    'groups the rows under section headers with their current values, the search box focused',
    async () => {
      const pane = await mount()
      const frame = pane.frame()
      const headers = ['Model & thinking', 'Agents & workflows', 'Tools & permissions', 'Interface', 'Terminal', 'Notifications', 'Integrations', 'Context & privacy']
      const at = headers.map(h => frame.indexOf(`  ${h}\n`))
      expect(at.every(i => i >= 0)).toBe(true)
      expect([...at].sort((a, b) => a - b)).toEqual(at)
      expect(frame).toContain('Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear')
      expect(pane.ownsEsc.at(-1)).toBe(true)
    },
    SLOW,
  )
})


// --- rows backed by the global config ----------------------------------------------

type ConfigRow = { query: string; label: string; key: keyof GlobalConfig; shown: [string, string]; stored: [unknown, unknown]; seed?: Partial<GlobalConfig>; inIdeTerminal?: boolean }

const CONFIG_ROWS: ConfigRow[] = [
  { query: 'auto-compact', label: 'Auto-compact', key: 'autoCompactEnabled', shown: ['true', 'false'], stored: [true, false] },
  { query: 'thinking history', label: 'Thinking history redaction', key: 'thinkingHistoryRedactionEnabled', shown: ['true', 'false'], stored: [true, false] },
  { query: 'narration', label: 'Narration history redaction', key: 'narrationHistoryRedactionEnabled', shown: ['true', 'false'], stored: [true, false] },
  { query: 'summarizer', label: 'Tool result summarizer', key: 'toolResultSummarizerEnabled', shown: ['true', 'false'], stored: [true, false] },
  { query: 'bash output filter', label: 'Bash output filter', key: 'bashOutputFilterEnabled', shown: ['true', 'false'], stored: [undefined, false] },
  { query: 'line cap', label: 'Bash output line cap', key: 'bashOutputFilterCapEnabled', shown: ['true', 'false'], stored: [undefined, false] },
  { query: 'auto-background', label: 'Auto-background agents', key: 'autoBackgroundAgentsEnabled', shown: ['false', 'true'], stored: [false, true] },
  { query: 'repeated', label: 'Repeated-failure hint', key: 'repeatedFailureHintEnabled', shown: ['true', 'false'], stored: [undefined, false] },
  { query: 'collapse', label: 'Collapse file writes', key: 'collapseFileWritesEnabled', shown: ['true', 'false'], stored: [undefined, false] },
  { query: 'workflows', label: 'Workflows run in background', key: 'workflowsDefaultBackground', shown: ['false', 'true'], stored: [false, true] },
  { query: 'rewind', label: 'Rewind code (checkpoints)', key: 'fileCheckpointingEnabled', shown: ['true', 'false'], stored: [true, false] },
  { query: 'progress bar', label: 'Terminal progress bar', key: 'terminalProgressBarEnabled', shown: ['true', 'false'], stored: [true, false] },
  { query: 'turn duration', label: 'Show turn duration', key: 'showTurnDuration', shown: ['true', 'false'], stored: [true, false] },
  { query: 'gitignore', label: 'Respect .gitignore in file picker', key: 'respectGitignore', shown: ['true', 'false'], stored: [true, false] },
  { query: 'copy full', label: 'Always copy full response (skip /copy)', key: 'copyFullResponse', shown: ['false', 'true'], stored: [false, true] },
  { query: 'pr/mr', label: 'Show PR/MR status footer', key: 'prStatusFooterEnabled', shown: ['true', 'false'], stored: [undefined, false] },
  { query: 'cache stats', label: 'Cache stats display', key: 'showCacheStats', shown: ['compact', 'full'], stored: ['compact', 'full'] },
  { query: 'inline terminal', label: 'Inline terminal images', key: 'inlineImagesMode', shown: ['auto', 'enable'], stored: ['auto', 'enable'] },
  { query: 'renderer', label: 'Terminal UI renderer', key: 'flickerFreeMode', shown: ['default', 'fullscreen'], stored: [false, true], seed: { flickerFreeMode: false } },
  { query: 'editor', label: 'Editor mode', key: 'editorMode', shown: ['normal', 'vim'], stored: ['normal', 'vim'] },
  { query: 'notifications', label: 'Notifications', key: 'preferredNotifChannel', shown: ['Auto', 'iTerm2 (OSC 9)'], stored: ['auto', 'iterm2'] },
  { query: 'auto-connect', label: 'Auto-connect to IDE (external terminal)', key: 'autoConnectIde', shown: ['false', 'true'], stored: [false, true] },
  { query: 'auto-install', label: 'Auto-install IDE extension', key: 'autoInstallIdeExtension', shown: ['true', 'false'], stored: [true, false], inIdeTerminal: true },
]

describe('a row stored in the global config', () => {
  for (const row of CONFIG_ROWS) {
    test(
      `${row.label}: Space changes it and the config keeps it`,
      async () => {
        if (row.seed) seedConfig(row.seed)
        if (row.inIdeTerminal) isSupportedTerminal.cache.set(undefined, true)
        const pane = await mount()
        expect(getGlobalConfig()[row.key]).toEqual(row.stored[0])
        await pane.pick(row.query)
        expect(pane.value(row.label)).toBe(row.shown[0])
        await pane.press(KEY.space)
        await pane.until(() => pane.value(row.label) === row.shown[1], `${row.label} to read ${row.shown[1]}`)
        expect(getGlobalConfig()[row.key]).toEqual(row.stored[1])
      },
      SLOW,
    )
  }

  test(
    'the notification channel cycles through every choice and wraps around',
    async () => {
      const pane = await mount()
      await pane.pick('notifications')
      const seen: string[] = [pane.value('Notifications')!]
      for (let i = 0; i < 8; i++) {
        const previous = seen.at(-1)
        await pane.press(KEY.space)
        await pane.until(() => pane.value('Notifications') !== previous, 'the next channel')
        seen.push(pane.value('Notifications')!)
      }
      expect(seen).toEqual(['Auto', 'iTerm2 (OSC 9)', 'Terminal Bell (\\a)', 'iTerm2 w/ Bell', 'Kitty (OSC 99)', 'Ghostty (OSC 777)', 'os_native', 'Disabled', 'Auto'])
      expect(getGlobalConfig().preferredNotifChannel).toBe('auto')
    },
    SLOW,
  )

  test(
    'the frame rate label names the rate in force, which follows the stored choice',
    async () => {
      const pane = await mount()
      await pane.pick('frame rate')
      expect(pane.value('Frame rate (60fps)')).toBe('auto')
      await pane.press(KEY.space, KEY.space)
      await pane.until(() => pane.value('Frame rate (120fps)') === '120', 'the label to follow the stored rate')
      expect(getGlobalConfig().renderFrameRate).toBe('120')
    },
    SLOW,
  )

  test(
    'left, right and Tab change the selected row as Space does',
    async () => {
      const pane = await mount()
      await pane.pick('editor')
      const values: string[] = []
      for (const key of [KEY.right, KEY.left, KEY.tab]) {
        const before = pane.value('Editor mode')
        await pane.press(key)
        await pane.until(() => pane.value('Editor mode') !== before, 'the editor mode to change')
        values.push(pane.value('Editor mode')!)
      }
      expect(values).toEqual(['vim', 'normal', 'vim'])
    },
    SLOW,
  )

  test(
    'an editor mode stored as emacs reads as normal',
    async () => {
      seedConfig({ editorMode: 'emacs' as GlobalConfig['editorMode'] })
      const pane = await mount()
      expect(pane.value('Editor mode')).toBe('normal')
    },
    SLOW,
  )
})

// --- rows backed by settings.json --------------------------------------------------

describe('a row stored in a settings file', () => {
  test(
    'messages from other sessions: each choice is written to the user file, default removes the key',
    async () => {
      writeJson(userFile(), { model: 'kept' })
      const pane = await mount()
      await pane.pick('other sessions')
      const trail: Array<[string | undefined, unknown]> = []
      for (let i = 0; i < 4; i++) {
        const before = pane.value('Messages from other sessions')
        await pane.press(KEY.space)
        await pane.until(() => pane.value('Messages from other sessions') !== before, 'the next policy')
        trail.push([pane.value('Messages from other sessions'), readJson(userFile())])
      }
      expect(trail).toEqual([
        ['accept', { model: 'kept', crossSessionInbound: 'accept' }],
        ['hold', { model: 'kept', crossSessionInbound: 'hold' }],
        ['refuse', { model: 'kept', crossSessionInbound: 'refuse' }],
        ['default', { model: 'kept' }],
      ])
      await pane.press(KEY.enter)
      await pane.until(() => pane.closed.length > 0, 'the pane to close')
      expect(pane.closed).toEqual([{ message: 'Set crossSessionInbound to default', display: undefined }])
    },
    SLOW,
  )

  test(
    'messages from other sessions: a user file that cannot be written leaves the row as it was',
    async () => {
      mkdirSync(userFile())
      const pane = await mount()
      await pane.pick('other sessions')
      await pane.press(KEY.space)
      await Bun.sleep(200)
      expect(pane.value('Messages from other sessions')).toBe('default')
      await pane.press(KEY.enter)
      await pane.until(() => pane.closed.length > 0, 'the pane to close')
      expect(pane.closed[0]!.message).toBe('Config dialog dismissed')
    },
    SLOW,
  )

  const LOCAL_ROWS = [
    { query: 'tips', label: 'Show tips', key: 'spinnerTipsEnabled', shown: ['true', 'false'], written: false },
    { query: 'reduce motion', label: 'Reduce motion', key: 'prefersReducedMotion', shown: ['false', 'true'], written: true },
  ] as const
  for (const row of LOCAL_ROWS) {
    test(
      `${row.label}: written to the project's local file`,
      async () => {
        const pane = await mount()
        await pane.pick(row.query)
        expect(pane.value(row.label)).toBe(row.shown[0])
        await pane.press(KEY.space)
        await pane.until(() => pane.value(row.label) === row.shown[1], `${row.label} to change`)
        expect(readJson(localFile())).toEqual({ [row.key]: row.written })
        expect(readJson(userFile())).toBeNull()
      },
      SLOW,
    )
  }

  test(
    'reduce motion also reaches the app state at once',
    async () => {
      const pane = await mount()
      await pane.pick('reduce motion')
      await pane.press(KEY.space)
      await pane.until(() => pane.value('Reduce motion') === 'true', 'reduce motion on')
      expect(pane.state().settings.prefersReducedMotion).toBe(true)
    },
    SLOW,
  )

  test(
    'values already in the files are what the rows show',
    async () => {
      writeJson(localFile(), { spinnerTipsEnabled: false, prefersReducedMotion: true, outputStyle: 'Explanatory' })
      writeJson(userFile(), { crossSessionInbound: 'hold', language: 'Deutsch', permissions: { defaultMode: 'acceptEdits' } })
      const pane = await mount()
      const shown = ['Show tips', 'Reduce motion', 'Output style', 'Messages from other sessions', 'Language', 'Default permission mode'].map(pane.value)
      expect(shown).toEqual(['false', 'true', 'Explanatory', 'hold', 'Deutsch', 'Accept edits'])
    },
    SLOW,
  )

  test(
    'thinking mode: off is written as false to the user file, on removes the key',
    async () => {
      const pane = await mount({ appState: { thinkingEnabled: true } })
      await pane.pick('thinking mode')
      await pane.press(KEY.space)
      await pane.until(() => pane.value('Thinking mode') === 'false', 'thinking off')
      expect([readJson(userFile()), pane.state().thinkingEnabled]).toEqual([{ alwaysThinkingEnabled: false }, false])
      await pane.press(KEY.space)
      await pane.until(() => pane.value('Thinking mode') === 'true', 'thinking on')
      expect([readJson(userFile()), pane.state().thinkingEnabled]).toEqual([{}, true])
    },
    SLOW,
  )

  test(
    'thinking mode: once the model has answered, a change carries a warning that leaves with the change',
    async () => {
      const WARNING = 'Changing thinking mode mid-conversation'
      const pane = await mount({ appState: { thinkingEnabled: true }, messages: [{ type: 'user' }, { type: 'assistant' }] })
      await pane.pick('thinking mode')
      await pane.press(KEY.space)
      await pane.until(f => f.includes(WARNING), 'the warning')
      await pane.press(KEY.space)
      await pane.until(f => !f.includes(WARNING), 'the warning to go once back at the start')
    },
    SLOW,
  )

  test(
    'thinking mode: with no answer yet there is no warning',
    async () => {
      const pane = await mount({ appState: { thinkingEnabled: true }, messages: [{ type: 'user' }] })
      await pane.pick('thinking mode')
      await pane.press(KEY.space)
      await pane.until(() => pane.value('Thinking mode') === 'false', 'thinking off')
      expect(pane.frame()).not.toContain('Changing thinking mode')
    },
    SLOW,
  )

  test(
    'prompt suggestions: off is written as false, on removes the key',
    async () => {
      const pane = await mount({ appState: { promptSuggestionEnabled: false } })
      await pane.pick('prompt suggestions')
      await pane.press(KEY.space)
      await pane.until(() => pane.value('Prompt suggestions') === 'true', 'suggestions on')
      expect([readJson(userFile()), pane.state().promptSuggestionEnabled]).toEqual([{}, true])
      await pane.press(KEY.space)
      await pane.until(() => pane.value('Prompt suggestions') === 'false', 'suggestions off')
      expect([readJson(userFile()), pane.state().promptSuggestionEnabled]).toEqual([{ promptSuggestionEnabled: false }, false])
    },
    SLOW,
  )

  test(
    'verbose output: saved in the config and the app state, and reported only while it differs',
    async () => {
      const pane = await mount({ appState: { verbose: false } })
      await pane.pick('verbose')
      await pane.press(KEY.space)
      await pane.until(() => pane.value('Verbose output') === 'true', 'verbose on')
      expect([getGlobalConfig().verbose, pane.state().verbose]).toEqual([true, true])
      await pane.press(KEY.enter)
      await pane.until(() => pane.closed.length > 0, 'the pane to close')
      expect(pane.closed).toEqual([{ message: 'Set verbose to true', display: undefined }])
    },
    SLOW,
  )

  test(
    'verbose output: flipped twice, there is nothing to report',
    async () => {
      const pane = await mount({ appState: { verbose: false } })
      await pane.pick('verbose')
      await pane.press(KEY.space)
      await pane.until(() => pane.value('Verbose output') === 'true', 'verbose on')
      await pane.press(KEY.space)
      await pane.until(() => pane.value('Verbose output') === 'false', 'verbose off')
      await pane.press(KEY.enter)
      await pane.until(() => pane.closed.length > 0, 'the pane to close')
      expect(pane.closed).toEqual([{ message: 'Config dialog dismissed', display: 'system' }])
    },
    SLOW,
  )

  test(
    'default permission mode: steps through the modes, without bypass, and writes the user file',
    async () => {
      const pane = await mount()
      await pane.pick('permission mode')
      const seen = [pane.value('Default permission mode')]
      const written: unknown[] = []
      for (let i = 0; i < 4; i++) {
        const before = seen.at(-1)
        await pane.press(KEY.space)
        await pane.until(() => pane.value('Default permission mode') !== before, 'the next mode')
        seen.push(pane.value('Default permission mode'))
        written.push((readJson(userFile()) as { permissions?: { defaultMode?: string } }).permissions?.defaultMode)
      }
      expect(seen).toEqual(['Default', 'Plan Mode', 'Accept edits', "Don't Ask", 'Default'])
      expect(written).toEqual(['plan', 'acceptEdits', 'dontAsk', 'default'])
      await pane.press(KEY.enter)
      await pane.until(() => pane.closed.length > 0, 'the pane to close')
      expect(pane.closed[0]!.message).toBe('Set defaultPermissionMode to default')
    },
    SLOW,
  )

  test(
    'default permission mode: a user file that cannot be written leaves the row as it was',
    async () => {
      mkdirSync(userFile())
      const pane = await mount()
      await pane.pick('permission mode')
      await pane.press(KEY.space)
      await Bun.sleep(200)
      expect(pane.value('Default permission mode')).toBe('Default')
    },
    SLOW,
  )

  test(
    'default permission mode: DEFECT, rules merged from the project file are copied into the user file',
    async () => {
      writeJson(join(tree.project, '.claudin', 'settings.json'), { permissions: { allow: ['Bash(make deploy)'] } })
      const pane = await mount()
      await pane.pick('permission mode')
      await pane.press(KEY.space)
      await pane.until(() => pane.value('Default permission mode') === 'Plan Mode', 'plan mode')
      expect(readJson(userFile())).toEqual({ permissions: { allow: ['Bash(make deploy)'], defaultMode: 'plan' } })
    },
    SLOW,
  )
})

// --- rows that open a picker ----------------------------------------------------------

describe('a row that opens a picker', () => {
  test(
    'theme: the picker replaces the list and hides the tabs; Esc returns with nothing changed',
    async () => {
      const pane = await mount()
      await pane.pick('theme')
      await pane.press(KEY.space)
      await pane.until(f => f.includes('Light mode') && !f.includes('Search settings'), 'the theme picker')
      expect(pane.tabsHidden).toEqual([true])
      await pane.press(KEY.esc)
      await pane.until(inList, 'the list again')
      expect([pane.tabsHidden, getGlobalConfig().theme, pane.value('Theme')]).toEqual([[true, false], 'dark', 'Dark mode'])
    },
    SLOW,
  )

  test(
    'theme: choosing one stores it and shows its long name',
    async () => {
      const pane = await mount()
      await pane.pick('theme')
      await pane.press(KEY.space)
      await pane.until(f => f.includes('Light mode') && !f.includes('Search settings'), 'the theme picker')
      await pane.press(KEY.down, KEY.enter)
      await pane.until(inList, 'the list again')
      expect(getGlobalConfig().theme).toBe('light')
      expect(pane.value('Theme')).toBe('Light mode')
      expect(pane.tabsHidden).toEqual([true, false])
    },
    SLOW,
  )

  test(
    'model: a choice goes to the app state and is reported on close',
    async () => {
      const pane = await mount({ appState: { mainLoopModel: null } })
      await pane.pick('model')
      expect(pane.value('Model')).toBe('Default (recommended)')
      await pane.press(KEY.space)
      await pane.until(f => f.includes('Select model'), 'the model picker')
      await pane.press(KEY.down, KEY.enter)
      await pane.until(inList, 'the list again')
      const first = pane.state().mainLoopModel
      expect(typeof first).toBe('string')
      expect(pane.state().mainLoopModelForSession).toBeNull()
      expect(pane.value('Model')).toBe(first!)
      // A second choice replaces the first in the closing report.
      await pane.press(KEY.space)
      await pane.until(f => f.includes('Select model'), 'the model picker again')
      await pane.press(KEY.down, KEY.enter)
      await pane.until(inList, 'the list again')
      const second = pane.state().mainLoopModel
      expect(second).not.toBe(first)
      await pane.press(KEY.enter)
      await pane.until(() => pane.closed.length > 0, 'the pane to close')
      expect(pane.closed[0]!.message!.split('\n')).toHaveLength(1)
      expect(pane.closed[0]!.message).toStartWith('Set model to ')
      expect(pane.closed[0]!.display).toBeUndefined()
    },
    SLOW,
  )

  test(
    'model: Esc leaves the picker without a change',
    async () => {
      const pane = await mount({ appState: { mainLoopModel: null } })
      await pane.pick('model')
      await pane.press(KEY.space)
      await pane.until(f => f.includes('Select model'), 'the model picker')
      await pane.press(KEY.esc)
      await pane.until(inList, 'the list again')
      expect(pane.state().mainLoopModel).toBeNull()
    },
    SLOW,
  )

  test(
    'output style: the choice is written to the local file and reported',
    async () => {
      const pane = await mount()
      await pane.pick('output style')
      expect(pane.value('Output style')).toBe('default')
      await pane.press(KEY.space)
      await pane.until(f => f.includes('Explanatory') && !f.includes('Search settings'), 'the style picker')
      await pane.press(KEY.down, KEY.enter)
      await pane.until(inList, 'the list again')
      const chosen = pane.value('Output style')!
      expect(chosen).not.toBe('default')
      expect(readJson(localFile())).toEqual({ outputStyle: chosen })
      await pane.press(KEY.enter)
      await pane.until(() => pane.closed.length > 0, 'the pane to close')
      expect(pane.closed[0]!.message).toBe(`Set output style to ${chosen}`)
    },
    SLOW,
  )

  test(
    'output style: Esc leaves the picker without a change',
    async () => {
      const pane = await mount()
      await pane.pick('output style')
      await pane.press(KEY.space)
      await pane.until(f => f.includes('Explanatory') && !f.includes('Search settings'), 'the style picker')
      await pane.press(KEY.esc)
      await pane.until(inList, 'the list again')
      expect(readJson(localFile())).toBeNull()
    },
    SLOW,
  )

  test(
    'language: what is typed is written to the user file and reported',
    async () => {
      const pane = await mount()
      await pane.pick('language')
      await pane.press(KEY.space)
      await pane.until(f => f.includes('preferred response and voice language'), 'the language prompt')
      await pane.press('Português')
      await pane.until(f => f.includes('Português'), 'the typed language')
      await pane.press(KEY.enter)
      await pane.until(inList, 'the list again')
      expect([pane.value('Language'), readJson(userFile())]).toEqual(['Português', { language: 'Português' }])
      await pane.press(KEY.enter)
      await pane.until(() => pane.closed.length > 0, 'the pane to close')
      expect(pane.closed[0]!.message).toBe('Set response language to Português')
    },
    SLOW,
  )

  test(
    'language: an empty answer clears the choice back to the default',
    async () => {
      writeJson(userFile(), { language: 'Deutsch' })
      const pane = await mount()
      await pane.pick('language')
      expect(pane.value('Language')).toBe('Deutsch')
      await pane.press(KEY.space)
      await pane.until(f => f.includes('preferred response and voice language'), 'the language prompt')
      await pane.press(...Array(7).fill('\x7F'))
      await pane.press(KEY.enter)
      await pane.until(inList, 'the list again')
      expect([pane.value('Language'), readJson(userFile())]).toEqual(['Default (English)', {}])
      await pane.press(KEY.enter)
      await pane.until(() => pane.closed.length > 0, 'the pane to close')
      expect(pane.closed[0]!.message).toBe('Set response language to Default (English)')
    },
    SLOW,
  )

  test(
    'language: Esc leaves the prompt without a change',
    async () => {
      const pane = await mount()
      await pane.pick('language')
      await pane.press(KEY.space)
      await pane.until(f => f.includes('preferred response and voice language'), 'the language prompt')
      await pane.press(KEY.esc)
      await pane.until(inList, 'the list again')
      expect(readJson(userFile())).toBeNull()
    },
    SLOW,
  )
})

// --- the auto-update channel ----------------------------------------------------------

/** Opts back in to nonessential traffic, so the privacy default stops disabling updates. */
function allowUpdates(enabledInConfig: boolean): void {
  process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC = '0'
  seedConfig({ autoUpdates: enabledInConfig })
}

describe('the auto-update channel', () => {
  test(
    'under the privacy default the row says why it is off, and its dialog only explains',
    async () => {
      const pane = await mount()
      expect(pane.value('Auto-update channel')).toBe('disabled (claudin-default set)')
      await pane.pick('auto-update')
      await pane.press(KEY.space)
      await pane.until(f => f.includes('Enable Auto-Updates'), 'the enable dialog')
      expect(pane.frame()).toContain('Auto-updates are controlled by an environment variable and cannot be changed here.')
      expect(pane.frame()).toContain('Unset claudin-default to re-enable')
      await pane.press(KEY.esc)
      await pane.until(inList, 'the list again')
      expect(pane.tabsHidden).toEqual([true, false])
    },
    SLOW,
  )

  test(
    'DISABLE_AUTOUPDATER is named as the reason',
    async () => {
      process.env.DISABLE_AUTOUPDATER = '1'
      const pane = await mount()
      expect(pane.value('Auto-update channel')).toBe('disabled (DISABLE_AUTOUPDATER set)')
      await pane.pick('auto-update')
      await pane.press(KEY.space)
      await pane.until(f => f.includes('Unset DISABLE_AUTOUPDATER to re-enable'), 'the reason')
    },
    SLOW,
  )

  test(
    'turned off in the config: the dialog turns updates back on with the chosen channel',
    async () => {
      allowUpdates(false)
      const pane = await mount()
      expect(pane.value('Auto-update channel')).toBe('disabled (config)')
      await pane.pick('auto-update')
      await pane.press(KEY.space)
      await pane.until(f => f.includes('Enable with stable channel'), 'the channel choice')
      await pane.press(KEY.down, KEY.enter)
      await pane.until(inList, 'the list again')
      expect(getGlobalConfig().autoUpdates).toBe(true)
      expect(readJson(userFile())).toEqual({ autoUpdatesChannel: 'stable' })
      expect(pane.value('Auto-update channel')).toBe('stable')
      await pane.press(KEY.enter)
      await pane.until(() => pane.closed.length > 0, 'the pane to close')
      expect(pane.closed[0]!.message).toBe('Set auto-update channel to stable')
    },
    SLOW,
  )

  test(
    'on latest: moving to stable asks first, and cancelling changes nothing',
    async () => {
      allowUpdates(true)
      const pane = await mount()
      await pane.pick('auto-update')
      expect(pane.value('Auto-update channel')).toBe('latest')
      await pane.press(KEY.space)
      await pane.until(f => f.includes('Switch to Stable Channel'), 'the downgrade question')
      await pane.press(KEY.esc)
      await pane.until(inList, 'the list again')
      expect([pane.value('Auto-update channel'), readJson(userFile())]).toEqual(['latest', null])
    },
    SLOW,
  )

  const DOWNGRADE = [
    { choice: 'allow the downgrade', keys: [KEY.enter], written: { autoUpdatesChannel: 'stable' } },
    { choice: 'stay on this version', keys: [KEY.down, KEY.enter], written: { autoUpdatesChannel: 'stable', minimumVersion: BUILD_VERSION } },
  ]
  for (const row of DOWNGRADE) {
    test(
      `on latest: moving to stable, ${row.choice}`,
      async () => {
        allowUpdates(true)
        const pane = await mount()
        await pane.pick('auto-update')
        await pane.press(KEY.space)
        await pane.until(f => f.includes('Allow possible downgrade to stable version'), 'the downgrade choices')
        await pane.press(...row.keys)
        await pane.until(inList, 'the list again')
        expect([pane.value('Auto-update channel'), readJson(userFile())]).toEqual(['stable', row.written])
      },
      SLOW,
    )
  }

  test(
    'on stable: going back to latest needs no question and drops the pinned version',
    async () => {
      allowUpdates(true)
      writeJson(userFile(), { autoUpdatesChannel: 'stable', minimumVersion: '1.0.0' })
      const pane = await mount()
      await pane.pick('auto-update')
      expect(pane.value('Auto-update channel')).toBe('stable')
      await pane.press(KEY.space)
      await pane.until(() => pane.value('Auto-update channel') === 'latest', 'latest')
      expect(readJson(userFile())).toEqual({ autoUpdatesChannel: 'latest' })
    },
    SLOW,
  )
})

// --- rows that only some sessions have ------------------------------------------------

describe('rows that depend on the session', () => {
  test(
    'connected to an IDE: the diff tool row appears and switches tools',
    async () => {
      const pane = await mount({ mcpClients: [{ type: 'connected', name: 'ide' }] })
      await pane.pick('diff tool')
      expect(pane.value('Diff tool')).toBe('auto')
      await pane.press(KEY.space)
      await pane.until(() => pane.value('Diff tool') === 'terminal', 'the terminal diff tool')
      expect(getGlobalConfig().diffTool).toBe('terminal')
    },
    SLOW,
  )

  test(
    'without an IDE, or with one that is not connected, there is no diff tool row',
    async () => {
      const pane = await mount({ mcpClients: [{ type: 'pending', name: 'ide' }] })
      expect(pane.frame()).not.toContain('Diff tool')
    },
    SLOW,
  )

  test(
    'agent teams on: the teammate rows appear; the mode cycles and is stored',
    async () => {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
      const pane = await mount()
      expect(pane.frame()).toContain('Default teammate model')
      await pane.pick('teammate mode')
      const seen = [pane.value('Teammate mode')]
      for (let i = 0; i < 3; i++) {
        const before = seen.at(-1)
        await pane.press(KEY.space)
        await pane.until(() => pane.value('Teammate mode') !== before, 'the next mode')
        seen.push(pane.value('Teammate mode'))
      }
      expect(seen).toEqual(['auto', 'tmux', 'in-process', 'auto'])
      expect(getGlobalConfig().teammateMode).toBe('auto')
    },
    SLOW,
  )

  test(
    'agent teams on: the default teammate model is chosen in a picker and reported',
    async () => {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
      const pane = await mount()
      await pane.pick('teammate model')
      const before = pane.value('Default teammate model')
      await pane.press(KEY.space)
      await pane.until(f => f.includes('Default model for newly spawned teammates'), 'the teammate model picker')
      await pane.press(KEY.down, KEY.enter)
      await pane.until(inList, 'the list again')
      const stored = getGlobalConfig().teammateDefaultModel
      expect(typeof stored).toBe('string')
      expect(pane.value('Default teammate model')).not.toBe(before)
      await pane.press(KEY.enter)
      await pane.until(() => pane.closed.length > 0, 'the pane to close')
      expect(pane.closed[0]!.message).toStartWith('Set teammateDefaultModel to ')
    },
    SLOW,
  )

  test(
    'agent teams on: confirming the highlighted default from an unset model stores nothing',
    async () => {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
      const pane = await mount()
      await pane.pick('teammate model')
      await pane.press(KEY.space)
      await pane.until(f => f.includes('Default model for newly spawned teammates'), 'the teammate model picker')
      await pane.press(KEY.enter)
      await pane.until(inList, 'the list again')
      expect('teammateDefaultModel' in getGlobalConfig()).toBe(false)
      await pane.press(KEY.enter)
      await pane.until(() => pane.closed.length > 0, 'the pane to close')
      expect(pane.closed[0]!.message).toBe('Config dialog dismissed')
    },
    SLOW,
  )

  test(
    'agent teams on: Esc leaves the teammate model picker without a change',
    async () => {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
      const pane = await mount()
      await pane.pick('teammate model')
      await pane.press(KEY.space)
      await pane.until(f => f.includes('Default model for newly spawned teammates'), 'the teammate model picker')
      await pane.press(KEY.esc)
      await pane.until(inList, 'the list again')
      expect('teammateDefaultModel' in getGlobalConfig()).toBe(false)
    },
    SLOW,
  )

  test(
    'agent teams off: no teammate rows',
    async () => {
      const pane = await mount()
      expect(pane.frame()).not.toContain('Teammate mode')
    },
    SLOW,
  )

  const KEY_TAIL = 'qrstuvwxyz0123456789'
  const API_KEY_CASES = [
    { name: 'a key never answered is approved', before: undefined, shown: 'false', after: { approved: [KEY_TAIL], rejected: [] } },
    { name: 'an approved key is rejected', before: { approved: ['older', KEY_TAIL] }, shown: 'true', after: { approved: ['older'], rejected: [KEY_TAIL] } },
    { name: 'a rejected key is approved', before: { rejected: [KEY_TAIL, 'older'] }, shown: 'false', after: { approved: [KEY_TAIL], rejected: ['older'] } },
  ]
  for (const row of API_KEY_CASES) {
    test(
      `an Anthropic profile with an API key: the key row shows the key tail; ${row.name}`,
      async () => {
        seedConfig({
          providerProfiles: [{ id: 'p1', name: 'Mine', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet', apiKey: `sk-ant-api03-abcdefghijklmnop${KEY_TAIL}` }],
          activeProviderProfileId: 'p1',
          customApiKeyResponses: row.before,
        } as Partial<GlobalConfig>)
        const pane = await mount()
        await pane.pick('custom api key')
        expect(pane.value(`Use custom API key: ${KEY_TAIL}`)).toBe(row.shown)
        await pane.press(KEY.space)
        await pane.until(() => Bun.deepEquals(getGlobalConfig().customApiKeyResponses, row.after), 'the answer to be stored')
      },
      SLOW,
    )
  }

  test(
    'without an Anthropic API key there is no key row',
    async () => {
      seedConfig({
        providerProfiles: [{ id: 'p1', name: 'Other', provider: 'openai', baseUrl: 'https://example.invalid/v1', model: 'gpt-x', apiKey: 'sk-x' }],
      } as Partial<GlobalConfig>)
      const pane = await mount()
      expect(pane.frame()).not.toContain('Use custom API key')
    },
    SLOW,
  )

  test(
    'CLAUDIN_NO_FLICKER: the renderer row says the environment decides, and copy on select appears',
    async () => {
      process.env.CLAUDIN_NO_FLICKER = '1'
      const pane = await mount()
      expect(pane.value('Terminal UI renderer (env)')).toBe('fullscreen')
      await pane.pick('copy on select')
      expect(pane.value('Copy on select')).toBe('true')
      await pane.press(KEY.space)
      await pane.until(() => pane.value('Copy on select') === 'false', 'copy on select off')
      expect(getGlobalConfig().copyOnSelect).toBe(false)
    },
    SLOW,
  )

  test(
    'CLAUDIN_FPS: the frame rate label says the environment decides',
    async () => {
      process.env.CLAUDIN_FPS = '30'
      const pane = await mount()
      expect(pane.value('Frame rate (env, 30fps)')).toBe('auto')
      expect(pane.frame()).not.toContain('Copy on select')
    },
    SLOW,
  )

  test(
    'CLAUDIN_DISABLE_FILE_CHECKPOINTING: no rewind row',
    async () => {
      process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING = '1'
      const pane = await mount()
      expect(pane.frame()).not.toContain('Rewind code')
    },
    SLOW,
  )

  test(
    'a project CLAUDE.md that imports a file outside the project: the includes row opens the approval dialog',
    async () => {
      const outside = join(tree.root, 'elsewhere', 'shared.md')
      mkdirSync(dirname(outside), { recursive: true })
      writeFileSync(outside, 'shared rules\n')
      writeFileSync(join(tree.project, 'CLAUDE.md'), `Project notes\n\n@${outside}\n`)
      const pane = await mount()
      await pane.pick('claude.md')
      expect(pane.value('External CLAUDE.md includes')).toBe('false')
      await pane.press(KEY.space)
      await pane.until(f => f.includes('Allow external CLAUDE.md file imports?'), 'the approval dialog')
      expect(pane.frame()).toContain(outside)
      await pane.press(KEY.enter)
      await pane.until(inList, 'the list again')
      expect(pane.value('External CLAUDE.md includes')).toBe('true')
      expect(pane.tabsHidden).toEqual([true, false])
    },
    SLOW,
  )

  test(
    'with no outside imports there is no includes row',
    async () => {
      writeFileSync(join(tree.project, 'CLAUDE.md'), 'Project notes only\n')
      const pane = await mount()
      expect(pane.frame()).not.toContain('External CLAUDE.md includes')
    },
    SLOW,
  )
})

// --- moving around -------------------------------------------------------------------

describe('moving around the list', () => {
  test(
    'a query narrows the list to a flat run of matches; a query with none says so',
    async () => {
      const pane = await mount()
      await pane.press('bash')
      await pane.until(f => f.includes('⌕ bash'), 'the query')
      const frame = pane.frame()
      expect(frame).toContain('Bash output filter')
      expect(frame).toContain('Bash output line cap')
      expect(frame).not.toContain('Tools & permissions')
      expect(frame).not.toContain('Auto-compact')
      await pane.press('zz')
      await pane.until(f => f.includes('No settings match "bashzz"'), 'the empty result')
    },
    SLOW,
  )

  test(
    'Esc in search clears the query first, then hands the keys to the list, then closes',
    async () => {
      const pane = await mount()
      await pane.press('tips')
      await pane.until(f => f.includes('⌕ tips'), 'the query')
      await pane.press(KEY.esc)
      await pane.until(f => f.includes('Search settings') && f.includes('Auto-compact'), 'the query cleared')
      expect(pane.frame()).toContain('Type to filter')
      await pane.press(KEY.esc)
      await pane.until(f => f.includes('Space to change · Enter to save · / to search · Esc to cancel'), 'list mode')
      expect(pane.ownsEsc.at(-1)).toBe(false)
      expect(pane.frame()).toMatch(/❯ Model /)
      await pane.press(KEY.esc)
      await pane.until(() => pane.closed.length > 0, 'the pane to close')
      expect(pane.closed).toEqual([{ message: 'Config dialog dismissed', display: 'system' }])
    },
    SLOW,
  )

  test(
    'down and j move down, up and k move up, skipping section headers; up from the top returns to search',
    async () => {
      const pane = await mount()
      const selected = () => pane.frame().split('\n').find(l => l.startsWith('❯ '))?.slice(2).trim().split(/\s{2,}/)[0]
      await pane.press(KEY.down)
      await pane.until(f => f.includes('Space to change'), 'list mode')
      const path: Array<string | undefined> = [selected()]
      for (const key of ['j', 'j', 'j', 'j', KEY.down, 'k', KEY.up]) {
        await pane.press(key)
        path.push(selected())
      }
      expect(path).toEqual(['Model', 'Thinking mode', 'Output style', 'Language', 'Auto-compact', 'Auto-background agents', 'Auto-compact', 'Language'])
      await pane.press(KEY.up, KEY.up, KEY.up, KEY.up)
      await pane.until(f => f.includes('Type to filter'), 'search mode again')
    },
    SLOW,
  )

  test(
    'brackets jump between sections',
    async () => {
      const pane = await mount()
      const selected = () => pane.frame().split('\n').find(l => l.startsWith('❯ '))?.slice(2).trim().split(/\s{2,}/)[0]
      await pane.press(KEY.enter)
      await pane.until(f => f.includes('Space to change'), 'list mode')
      const path: Array<string | undefined> = []
      for (const key of [']', ']', ']', '[', '[']) {
        await pane.press(key)
        path.push(selected())
      }
      expect(path).toEqual(['Auto-background agents', 'Default permission mode', 'Theme', 'Default permission mode', 'Auto-background agents'])
    },
    SLOW,
  )

  test(
    'in the list, a letter starts a new search with it and / starts an empty one',
    async () => {
      const pane = await mount()
      await pane.press(KEY.enter)
      await pane.until(f => f.includes('Space to change'), 'list mode')
      await pane.press('x')
      await pane.until(f => f.includes('⌕ x') && f.includes('Type to filter'), 'a search for x')
      await pane.press(KEY.enter)
      await pane.until(f => f.includes('Space to change'), 'list mode')
      await pane.press('/')
      await pane.until(f => f.includes('Search settings') && f.includes('Type to filter'), 'an empty search')
    },
    SLOW,
  )

  test(
    'a short pane scrolls, counting the settings above and below the window',
    async () => {
      const pane = await mount({ height: 16 })
      expect(pane.frame()).toMatch(/↓ \d+ more below/)
      expect(pane.frame()).not.toMatch(/more above/)
      await pane.press(KEY.down)
      await pane.until(f => f.includes('Space to change'), 'list mode')
      await pane.press(...Array(8).fill('j'))
      await pane.until(f => /↑ \d+ more above/.test(f), 'settings hidden above')
      const above = Number(/↑ (\d+) more above/.exec(pane.frame())![1])
      const below = Number(/↓ (\d+) more below/.exec(pane.frame())![1])
      const visible = pane.frame().split('\n').filter(l => /^[❯ ] \S/.test(l) && /\s{2,}\S/.test(l.slice(2))).length
      expect(above).toBeGreaterThan(0)
      expect(above + visible + below).toBe(35)
    },
    SLOW,
  )
})

// --- leaving ---------------------------------------------------------------------------

describe('leaving the pane', () => {
  test(
    'Enter with nothing changed closes quietly',
    async () => {
      const pane = await mount()
      await pane.press(KEY.enter)
      await pane.until(f => f.includes('Space to change'), 'list mode')
      await pane.press(KEY.enter)
      await pane.until(() => pane.closed.length > 0, 'the pane to close')
      expect(pane.closed).toEqual([{ message: 'Config dialog dismissed', display: 'system' }])
    },
    SLOW,
  )

  test(
    'Esc with nothing changed writes no file',
    async () => {
      const pane = await mount()
      await pane.press(KEY.esc)
      await pane.until(f => f.includes('Space to change'), 'list mode')
      await pane.press(KEY.esc)
      await pane.until(() => pane.closed.length > 0, 'the pane to close')
      expect([readJson(userFile()), readJson(localFile())]).toEqual([null, null])
    },
    SLOW,
  )

  test(
    'Esc after changes puts the settings files and the app state back as they were',
    async () => {
      writeJson(userFile(), { language: 'Deutsch', permissions: { allow: ['Read'] } })
      writeJson(localFile(), { spinnerTipsEnabled: true })
      const pane = await mount({ appState: { thinkingEnabled: true, verbose: false, promptSuggestionEnabled: false } })
      // Each row is reached by searching for the start of its label.
      const labels = ['Show tips', 'Reduce motion', 'Thinking mode', 'Verbose output', 'Prompt suggestions', 'Default permission mode']
      for (const label of labels) {
        const query = label.toLowerCase()
        if (inList(pane.frame())) await pane.press('/')
        await pane.until(f => f.includes('Type to filter') && f.includes('Search settings'), 'an empty search')
        await pane.pick(query)
        const before = pane.value(label)
        await pane.press(KEY.space)
        await pane.until(() => pane.value(label) !== before, `${label} to change`)
      }
      expect(readJson(localFile())).toEqual({ spinnerTipsEnabled: false, prefersReducedMotion: true })
      await pane.press('/')
      await pane.until(f => f.includes('Type to filter') && f.includes('Search settings'), 'an empty search')
      await pane.pick('theme')
      await pane.press(KEY.space)
      await pane.until(f => f.includes('Light mode') && !inList(f), 'the theme picker')
      await pane.press(KEY.down, KEY.enter)
      await pane.until(inList, 'the list again')
      expect(getGlobalConfig().theme).toBe('light')
      await pane.press(KEY.esc)
      await pane.until(() => pane.closed.length > 0, 'the pane to close')

      expect(pane.closed).toEqual([{ message: 'Config dialog dismissed', display: 'system' }])
      expect(readJson(localFile())).toEqual({ spinnerTipsEnabled: true })
      expect(readJson(userFile())).toEqual({ language: 'Deutsch', permissions: { allow: ['Read'] } })
      const state = pane.state()
      expect([state.thinkingEnabled, state.verbose, state.promptSuggestionEnabled, state.settings.prefersReducedMotion]).toEqual([true, false, false, undefined])
      expect(getGlobalConfig().theme).toBe('dark')
    },
    SLOW,
  )
})
