/**
 * A rig for driving the real prompt box from the outside, the way the REPL
 * hosts it: the REPL owns the typed text, the input mode, the pastes, the
 * stash and the help toggle, and hands PromptInput a setter for each. Here a
 * small host component owns them instead and writes every value it holds to
 * a ledger the test reads.
 *
 * Every rig gets its own temp root holding a config directory, a project
 * directory (the working directory for the session) and a home directory, so
 * nothing touches the real ~/.claudin or this repository's own .claudin.
 */
import { afterEach, beforeEach } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import { useEffect, useState } from 'react'
import type { Command } from 'src/commands/commands.js'
import {
  getCwdState,
  getOriginalCwd,
  getProjectRoot,
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from 'src/platform/bootstrap/state.js'
import type { PastedContent } from 'src/platform/config/config.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import type { Message } from 'src/shared/types/message.js'
import type { PromptInputMode, VimMode } from 'src/shared/types/textInputTypes.js'
import { createFakeTerminal, type FakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot } from 'src/terminal/ink.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import PromptInput from 'src/terminal/prompt-input/PromptInput.js'
import { AppStateProvider, useAppStateStore } from 'src/terminal/state/AppState.js'
import { type AppState, type AppStateStore, getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

/** Variables a prompt reads that a developer's shell may have set. Cleared for each rig. */
const ISOLATED_VARIABLES = [
  'HOME',
  'CLAUDIN_CONFIG_DIR',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'CLAUDIN_EFFORT_LEVEL',
  'CLAUDIN_ENABLE_PROMPT_SUGGESTION',
  'CLAUDIN_NO_FLICKER',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'EDITOR',
  'VISUAL',
] as const

/** Global config fields a prompt writes. Put back after every test. */
const CONFIG_FIELDS = [
  'hasUsedStash',
  'hasSeenTasksHint',
  'lastPlanModeUse',
  'editorMode',
  'btwUseCount',
  'companion',
  'companionMuted',
] as const

export type Sandbox = { root: string; configDir: string; projectDir: string; home: string }

/**
 * Gives each test a fresh temp root and points every path the prompt reads
 * at it. Call once at the top level of a test file.
 */
export function useSandbox(): () => Sandbox {
  let current: Sandbox | undefined
  let undo: (() => void) | undefined

  beforeEach(() => {
    const saved = new Map(ISOLATED_VARIABLES.map(name => [name, process.env[name]]))
    const config = getGlobalConfig() as Record<string, unknown>
    const savedConfig = new Map(CONFIG_FIELDS.map(field => [field, config[field]]))
    const dirs = { cwd: getCwdState(), original: getOriginalCwd(), project: getProjectRoot() }

    const root = realpathSync(mkdtempSync(join(tmpdir(), 'prompt-rig-')))
    const sandbox: Sandbox = {
      root,
      configDir: join(root, 'config'),
      projectDir: join(root, 'project'),
      home: join(root, 'home'),
    }
    for (const dir of [sandbox.configDir, sandbox.projectDir, sandbox.home]) mkdirSync(dir, { recursive: true })
    for (const name of ISOLATED_VARIABLES) delete process.env[name]
    process.env.HOME = sandbox.home
    process.env.CLAUDIN_CONFIG_DIR = sandbox.configDir
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    setProjectRoot(sandbox.projectDir)
    setOriginalCwd(sandbox.projectDir)
    setCwdState(sandbox.projectDir)
    resetSettingsCache()
    current = sandbox

    undo = () => {
      setCwdState(dirs.cwd)
      setOriginalCwd(dirs.original)
      setProjectRoot(dirs.project)
      // Under bun test the save is an Object.assign onto one shared object, so
      // a deleted key would survive into the next file; write undefined instead.
      saveGlobalConfig(c => {
        const next = { ...c } as Record<string, unknown>
        for (const [field, value] of savedConfig) next[field] = value
        return next as typeof c
      })
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      resetSettingsCache()
      rmSync(root, { recursive: true, force: true })
    }
  })

  afterEach(() => {
    undo?.()
    undo = undefined
    current = undefined
  })

  return () => {
    if (!current) throw new Error('the sandbox only exists while a test runs')
    return current
  }
}

// --- the keys a user presses, as the bytes a terminal sends ------------------------

export const KEY = {
  enter: '\r',
  escape: '\x1b',
  tab: '\t',
  shiftTab: '\x1b[Z',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  ctrlC: '\x03',
  ctrlG: '\x07',
  ctrlS: '\x13',
  ctrlU: '\x15',
  ctrlUnderscore: '\x1f',
  metaP: '\x1bp',
  metaT: '\x1bt',
  metaEnter: '\x1b\r',
  /** Wraps text the way a terminal with bracketed paste delivers a paste. */
  paste: (text: string) => `\x1b[200~${text}\x1b[201~`,
} as const

// --- what the host hands the prompt and records back ---------------------------------

export type Submission = { text: string; options?: { fromKeybinding?: boolean }; speculation: boolean }

/** Everything the host holds after the latest render, and every call the prompt made. */
export type Ledger = {
  input: string
  mode: PromptInputMode
  pasted: Record<number, PastedContent>
  stash: { text: string; cursorOffset: number; pastedContents: Record<number, PastedContent> } | undefined
  helpOpen: boolean
  searching: boolean
  bashesDialog: string | boolean
  vimMode: VimMode
  permissionContexts: ToolPermissionContext[]
  submissions: Submission[]
  agentSubmissions: Array<{ text: string; taskId: string }>
  messageSelectorOpened: number
  messageActionsEntered: number
  exits: number
  /** Replaces the typed text from outside the prompt, the way dictation does. */
  replaceInput?: (value: string) => void
  /** The helpers the prompt handed with the latest submission. */
  lastHelpers?: { setCursorOffset: (offset: number) => void; clearBuffer: () => void; resetHistory: () => void }
}

export type Scenario = {
  input?: string
  mode?: PromptInputMode
  pasted?: Record<number, PastedContent>
  stash?: Ledger['stash']
  helpOpen?: boolean
  searching?: boolean
  bashesDialog?: string | boolean
  messages?: Message[]
  commands?: Command[]
  isLoading?: boolean
  appState?: Partial<AppState>
  permissionContext?: Partial<ToolPermissionContext>
  hasSuppressedDialogs?: boolean
  isLocalJSXCommandActive?: boolean
  sideQuestionVisible?: boolean
  withAgentSubmit?: boolean
  withMessageActions?: boolean
  voiceInterimRange?: { start: number; end: number }
  columns?: number
  /** What the host's submit does; by default it records and resolves. */
  onSubmit?: (text: string) => void
}

type InsertHandle = {
  insert: (text: string) => void
  setInputWithCursor: (value: string, cursor: number) => void
  cursorOffset: number
}

type HostProps = {
  scenario: Scenario
  ledger: Ledger
  insertRef: React.MutableRefObject<InsertHandle | null>
  storeRef: { current: AppStateStore | null }
  dismissedSideQuestion: { count: number }
}

function StoreTap({ storeRef }: { storeRef: { current: AppStateStore | null } }): React.ReactNode {
  storeRef.current = useAppStateStore()
  return null
}

function Host({ scenario, ledger, insertRef, storeRef, dismissedSideQuestion }: HostProps): React.ReactNode {
  const [input, setInput] = useState(scenario.input ?? '')
  const [mode, setMode] = useState<PromptInputMode>(scenario.mode ?? 'prompt')
  const [pasted, setPasted] = useState<Record<number, PastedContent>>(scenario.pasted ?? {})
  const [stash, setStash] = useState<Ledger['stash']>(scenario.stash)
  const [helpOpen, setHelpOpen] = useState(scenario.helpOpen ?? false)
  const [searching, setSearching] = useState(scenario.searching ?? false)
  const [bashesDialog, setBashesDialog] = useState<string | boolean>(scenario.bashesDialog ?? false)
  const [workflowsDialog, setWorkflowsDialog] = useState<string | boolean>(false)
  const [vimMode, setVimMode] = useState<VimMode>('INSERT')
  const [sideQuestion, setSideQuestion] = useState(scenario.sideQuestionVisible ?? false)
  const [permissionContext, setPermissionContext] = useState<ToolPermissionContext>(() => ({
    ...getDefaultAppState().toolPermissionContext,
    ...scenario.permissionContext,
  }))

  ledger.replaceInput = setInput
  Object.assign(ledger, {
    input,
    mode,
    pasted,
    stash,
    helpOpen,
    searching,
    bashesDialog,
    vimMode,
  })

  return (
    <PromptInput
      debug={false}
      ideSelection={undefined}
      toolPermissionContext={permissionContext}
      setToolPermissionContext={ctx => {
        ledger.permissionContexts.push(ctx)
        setPermissionContext(ctx)
      }}
      apiKeyStatus="valid"
      commands={scenario.commands ?? []}
      agents={[]}
      isLoading={scenario.isLoading ?? false}
      verbose={false}
      messages={scenario.messages ?? []}
      onAutoUpdaterResult={() => {}}
      autoUpdaterResult={null}
      input={input}
      onInputChange={setInput}
      mode={mode}
      onModeChange={setMode}
      stashedPrompt={stash}
      setStashedPrompt={setStash}
      submitCount={ledger.submissions.length}
      onShowMessageSelector={() => {
        ledger.messageSelectorOpened += 1
      }}
      onMessageActionsEnter={
        scenario.withMessageActions
          ? () => {
              ledger.messageActionsEntered += 1
            }
          : undefined
      }
      mcpClients={[]}
      pastedContents={pasted}
      setPastedContents={setPasted}
      vimMode={vimMode}
      setVimMode={setVimMode}
      showBashesDialog={bashesDialog}
      setShowBashesDialog={setBashesDialog}
      showWorkflowsDialog={workflowsDialog}
      setShowWorkflowsDialog={setWorkflowsDialog}
      onExit={() => {
        ledger.exits += 1
      }}
      getToolUseContext={() => {
        throw new Error('the rig does not open dialogs that need a tool-use context')
      }}
      onSubmit={async (text, helpers, speculation, options) => {
        ledger.submissions.push({ text, options, speculation: speculation !== undefined })
        ledger.lastHelpers = helpers
        scenario.onSubmit?.(text)
      }}
      onAgentSubmit={
        scenario.withAgentSubmit
          ? async (text, task) => {
              ledger.agentSubmissions.push({ text, taskId: task.id })
            }
          : undefined
      }
      isSearchingHistory={searching}
      setIsSearchingHistory={setSearching}
      onDismissSideQuestion={() => {
        dismissedSideQuestion.count += 1
        setSideQuestion(false)
      }}
      isSideQuestionVisible={sideQuestion}
      helpOpen={helpOpen}
      setHelpOpen={setHelpOpen}
      hasSuppressedDialogs={scenario.hasSuppressedDialogs}
      isLocalJSXCommandActive={scenario.isLocalJSXCommandActive}
      insertTextRef={insertRef}
      voiceInterimRange={scenario.voiceInterimRange ?? null}
    />
  )
}

function Mounted({ onMounted }: { onMounted: () => void }): React.ReactNode {
  useEffect(onMounted, [onMounted])
  return null
}

/** Sends each chunk on its own, pausing after every one so the tree can react. */
async function sendOneByOne(terminal: FakeTerminal, chunks: string[], pause: () => Promise<void>): Promise<void> {
  for (let index = 0; index < chunks.length; index += 1) {
    terminal.type(chunks[index] as string)
    await pause()
  }
}

export type Rig = {
  terminal: FakeTerminal
  ledger: Ledger
  store: AppStateStore
  state: () => AppState
  screen: () => string
  press: (...keys: string[]) => Promise<void>
  type: (text: string) => Promise<void>
  until: (check: () => boolean, what: string) => Promise<void>
  settle: () => Promise<void>
  insert: () => InsertHandle
  sideQuestionDismissals: () => number
  close: () => void
}

const WAIT_LIMIT_MS = 4_000

/** Mounts the prompt in a fake terminal and waits for its first frame. */
export async function openPrompt(scenario: Scenario = {}): Promise<Rig> {
  const terminal = createFakeTerminal({ columns: scenario.columns ?? 100 })
  const root = await createRoot({
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  const ledger: Ledger = {
    input: '',
    mode: 'prompt',
    pasted: {},
    stash: undefined,
    helpOpen: false,
    searching: false,
    bashesDialog: false,
    vimMode: 'INSERT',
    permissionContexts: [],
    submissions: [],
    agentSubmissions: [],
    messageSelectorOpened: 0,
    messageActionsEntered: 0,
    exits: 0,
  }
  const insertRef: React.MutableRefObject<InsertHandle | null> = { current: null }
  const storeRef: { current: AppStateStore | null } = { current: null }
  const dismissedSideQuestion = { count: 0 }
  let mounted = false
  const initialState = { ...getDefaultAppState(), ...scenario.appState } as AppState

  root.render(
    <AppStateProvider initialState={initialState}>
      <KeybindingSetup>
        <StoreTap storeRef={storeRef} />
        <Host
          scenario={scenario}
          ledger={ledger}
          insertRef={insertRef}
          storeRef={storeRef}
          dismissedSideQuestion={dismissedSideQuestion}
        />
        <Mounted
          onMounted={() => {
            mounted = true
          }}
        />
      </KeybindingSetup>
    </AppStateProvider>,
  )

  const until = async (check: () => boolean, what: string) => {
    const deadline = Date.now() + WAIT_LIMIT_MS
    while (!check()) {
      if (Date.now() > deadline) {
        throw new Error(
          `gave up waiting for ${what}\n--- screen ---\n${terminal.screen()}\n--- ledger ---\n${JSON.stringify(
            { ...ledger, lastHelpers: undefined },
            null,
            1,
          )}`,
        )
      }
      await Bun.sleep(10)
    }
  }
  const settle = () => Bun.sleep(120)

  await until(() => mounted && storeRef.current !== null && terminal.screen().trim() !== '', 'the prompt to paint')

  const rig: Rig = {
    terminal,
    ledger,
    get store() {
      return storeRef.current as AppStateStore
    },
    state: () => (storeRef.current as AppStateStore).getState(),
    screen: () => terminal.screen(),
    press: (...keys) => sendOneByOne(terminal, keys, settle),
    type: async text => {
      await sendOneByOne(terminal, [...text], () => Bun.sleep(15))
      await settle()
    },
    until,
    settle,
    insert: () => {
      if (!insertRef.current) throw new Error('the prompt never exposed its insert handle')
      return insertRef.current
    },
    sideQuestionDismissals: () => dismissedSideQuestion.count,
    close: () => {
      root.unmount()
      terminal.close()
    },
  }
  return rig
}

/** Opens a prompt, runs the check, and always unmounts. */
export async function withPrompt(scenario: Scenario, check: (rig: Rig) => Promise<void>): Promise<void> {
  const rig = await openPrompt(scenario)
  try {
    await check(rig)
  } finally {
    rig.close()
  }
}
