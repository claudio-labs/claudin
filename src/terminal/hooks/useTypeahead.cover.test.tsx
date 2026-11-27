/**
 * Characterization of useTypeahead: what the prompt input's suggestion layer
 * shows and does today, pinned before the MCP prompt-argument completions
 * landed (their cases are the last describe; they run in a branch of their
 * own ahead of the `exactMatch?.type === 'prompt'` hint).
 *
 * The hook runs inside a real Ink root (AppStateProvider + KeybindingSetup) so
 * Tab / Esc / arrows reach it through the Autocomplete keybinding context the
 * way PromptInput drives it. The async sources (file index, Slack channels,
 * path/directory listing, shell history, session titles) are replaced with
 * spyOn on their module exports and restored after each test.
 */
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import React, { useState } from 'react'

import * as swarms from 'src/agent/coordinator/agentSwarmsEnabled.js'
import type { Command } from 'src/commands/commands.js'
import * as sessionSearch from 'src/sessions/indexing/search.js'
import type { PromptInputMode } from 'src/shared/types/textInputTypes.js'
import {
  applyDirectorySuggestion,
  applyShellSuggestion,
  extractCompletionToken,
  extractSearchToken,
  formatReplacementValue,
  useTypeahead,
} from 'src/terminal/hooks/useTypeahead.js'
import { createRoot } from 'src/terminal/ink.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import type { SuggestionItem } from 'src/terminal/prompt-input/PromptInputFooterSuggestions.js'
import * as fileSuggestions from 'src/terminal/prompt-suggestion/fileSuggestions.js'
import * as unified from 'src/terminal/prompt-suggestion/unifiedSuggestions.js'
import { AppStateProvider, useAppStateStore } from 'src/terminal/state/AppState.js'
import * as directoryCompletion from 'src/terminal/suggestions/directoryCompletion.js'
import * as shellHistory from 'src/terminal/suggestions/shellHistoryCompletion.js'
import * as slack from 'src/terminal/suggestions/slackChannelSuggestions.js'

// ── fixtures ────────────────────────────────────────────────────────────────

function localCommand(name: string, extra: Partial<Command> = {}): Command {
  return {
    type: 'local',
    name,
    description: `${name} command`,
    supportsNonInteractive: false,
    load: async () => ({ call: async () => ({ type: 'skip' }) }),
    ...extra,
  } as unknown as Command
}

function promptCommand(name: string, argNames: string[]): Command {
  return {
    type: 'prompt',
    name,
    description: `${name} prompt`,
    progressMessage: 'running',
    contentLength: 0,
    source: 'builtin',
    argNames,
    getPromptForCommand: async () => [],
  } as unknown as Command
}

const HELP = localCommand('help', { argumentHint: '[topic]' })
const CLEAR = localCommand('clear')
const SECRET = localCommand('secret', { isHidden: true })
const REVIEW = promptCommand('review', ['repo', 'branch'])
const COMMANDS: Command[] = [HELP, CLEAR, SECRET, REVIEW]
// A stable reference: a fresh `agents` array each render recreates the
// debounced fetch, which re-runs the input effect forever (PromptInput passes
// a memoized list).
const NO_AGENTS: never[] = []

function file(displayText: string): SuggestionItem {
  return { id: `file-${displayText}`, displayText }
}

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

// ── harness ─────────────────────────────────────────────────────────────────

type SuggestionsState = {
  suggestions: SuggestionItem[]
  selectedSuggestion: number
  commandArgumentHint?: string
}

type Extra = {
  commands: Command[]
  mode: string
  suppressSuggestions?: boolean
  promptSuggestionGhost?: { fullText: string; remainder: string }
  onModeChange?: (mode: PromptInputMode) => void
  onDismissPromptSuggestion?: () => void
}

type Calls = {
  inputs: string[]
  cursors: number[]
  submits: Array<[string, boolean | undefined]>
  accepted: number
}

type Ctl = {
  result: ReturnType<typeof useTypeahead>
  input: string
  cursor: number
  state: SuggestionsState
  store: ReturnType<typeof useAppStateStore>
  setInput: (value: string, cursor?: number) => void
  setExtra: (patch: Partial<Extra>) => void
}

function Harness({
  ctl,
  calls,
  initialInput,
  initialExtra,
}: {
  ctl: Partial<Ctl>
  calls: Calls
  initialInput: string
  initialExtra: Extra
}): React.ReactNode {
  const [input, setInput] = useState(initialInput)
  const [cursor, setCursor] = useState(initialInput.length)
  const [extra, setExtra] = useState<Extra>(initialExtra)
  const [state, setState] = useState<SuggestionsState>({
    suggestions: [],
    selectedSuggestion: -1,
  })
  const store = useAppStateStore()
  const result = useTypeahead({
    commands: extra.commands,
    agents: NO_AGENTS,
    mode: extra.mode,
    input,
    cursorOffset: cursor,
    onInputChange: value => {
      calls.inputs.push(value)
      setInput(value)
    },
    setCursorOffset: offset => {
      calls.cursors.push(offset)
      setCursor(offset)
    },
    onSubmit: (value, isSlash) => {
      calls.submits.push([value, isSlash])
    },
    setSuggestionsState: setState,
    suggestionsState: state,
    suppressSuggestions: extra.suppressSuggestions,
    markAccepted: () => {
      calls.accepted++
    },
    onModeChange: extra.onModeChange,
    promptSuggestionGhost: extra.promptSuggestionGhost,
    onDismissPromptSuggestion: extra.onDismissPromptSuggestion,
  })
  ctl.result = result
  ctl.input = input
  ctl.cursor = cursor
  ctl.state = state
  ctl.store = store
  ctl.setInput = (value, at) => {
    setInput(value)
    setCursor(at ?? value.length)
  }
  ctl.setExtra = patch => setExtra(prev => ({ ...prev, ...patch }))
  return null
}

const KEY = {
  tab: '\t',
  enter: '\r',
  escape: '\x1B',
  up: '\x1B[A',
  down: '\x1B[B',
  right: '\x1B[C',
  ctrlN: '\x0E',
  ctrlP: '\x10',
}

type Mounted = {
  ctl: Ctl
  calls: Calls
  type: (value: string, cursor?: number) => Promise<void>
  press: (key: string) => Promise<void>
  dispose: () => Promise<void>
}

const mounted: Mounted[] = []

async function settle(ms = 40): Promise<void> {
  await Bun.sleep(ms)
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) await Bun.sleep(5)
}

async function mount(
  initialInput = '',
  extra: Partial<Extra> = {},
): Promise<Mounted> {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 100
  stdout.on('data', () => {})

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  const ctl: Partial<Ctl> = {}
  const calls: Calls = { inputs: [], cursors: [], submits: [], accepted: 0 }
  root.render(
    <AppStateProvider>
      <KeybindingSetup>
        <Harness
          ctl={ctl}
          calls={calls}
          initialInput={initialInput}
          initialExtra={{ commands: COMMANDS, mode: 'prompt', ...extra }}
        />
      </KeybindingSetup>
    </AppStateProvider>,
  )
  await settle()

  let disposed = false
  const m: Mounted = {
    ctl: ctl as Ctl,
    calls,
    type: async (value, cursor) => {
      ctl.setInput!(value, cursor)
      await waitFor(() => ctl.input === value)
      await settle()
    },
    press: async key => {
      stdin.write(key)
      await settle(key === KEY.escape ? 120 : 40)
    },
    dispose: async () => {
      if (disposed) return
      disposed = true
      root.unmount()
      stdin.end()
      stdout.end()
      await Bun.sleep(0)
    },
  }
  mounted.push(m)
  return m
}

// ── spies ───────────────────────────────────────────────────────────────────

let unifiedSpy: ReturnType<typeof spyOn>
let slackSpy: ReturnType<typeof spyOn>
let hasSlackSpy: ReturnType<typeof spyOn>
let historySpy: ReturnType<typeof spyOn>
let dirSpy: ReturnType<typeof spyOn>
let pathSpy: ReturnType<typeof spyOn>
let titleSpy: ReturnType<typeof spyOn>
let swarmSpy: ReturnType<typeof spyOn>
let spies: Array<ReturnType<typeof spyOn>> = []

beforeEach(() => {
  unifiedSpy = spyOn(unified, 'generateUnifiedSuggestions').mockImplementation(
    async () => [],
  )
  slackSpy = spyOn(slack, 'getSlackChannelSuggestions').mockImplementation(
    async () => [],
  )
  hasSlackSpy = spyOn(slack, 'hasSlackMcpServer').mockImplementation(() => false)
  historySpy = spyOn(shellHistory, 'getShellHistoryCompletion').mockImplementation(
    async () => null,
  )
  dirSpy = spyOn(directoryCompletion, 'getDirectoryCompletions').mockImplementation(
    async () => [],
  )
  pathSpy = spyOn(directoryCompletion, 'getPathCompletions').mockImplementation(
    async () => [],
  )
  titleSpy = spyOn(sessionSearch, 'searchSessionsByCustomTitle').mockImplementation(
    async () => [],
  )
  swarmSpy = spyOn(swarms, 'isAgentSwarmsEnabled').mockImplementation(() => false)
  spies = [
    unifiedSpy,
    slackSpy,
    hasSlackSpy,
    historySpy,
    dirSpy,
    pathSpy,
    titleSpy,
    swarmSpy,
  ]
})

afterEach(async () => {
  for (const m of mounted.splice(0)) await m.dispose()
  // usehooks-ts' unmount cancel targets a different debounce instance than
  // the one the hook calls, so a pending 50/150 ms fetch still fires after
  // unmount. Let it land on this test's spies, not the next test's.
  await settle(170)
  for (const s of spies) s.mockRestore()
  spies = []
})

// ── pure exports ────────────────────────────────────────────────────────────

describe('pure helpers', () => {
  test('extractSearchToken strips @ and quotes', () => {
    expect(extractSearchToken({ token: '@"my file"', isQuoted: true })).toBe('my file')
    expect(extractSearchToken({ token: '@"my fi', isQuoted: true })).toBe('my fi')
    expect(extractSearchToken({ token: '@src/a' })).toBe('src/a')
    expect(extractSearchToken({ token: 'plain' })).toBe('plain')
  })

  test('formatReplacementValue picks quotes, @ and trailing space by mode', () => {
    const base = { displayText: 'a b', hasAtPrefix: true, isComplete: true }
    expect(formatReplacementValue({ ...base, mode: 'prompt', needsQuotes: true })).toBe('@"a b" ')
    expect(formatReplacementValue({ ...base, mode: 'bash', needsQuotes: true })).toBe('"a b" ')
    expect(
      formatReplacementValue({ ...base, mode: 'prompt', needsQuotes: false, isQuoted: true, isComplete: false }),
    ).toBe('@"a b"')
    expect(formatReplacementValue({ displayText: 'x', mode: 'prompt', hasAtPrefix: true, needsQuotes: false, isComplete: true })).toBe('@x ')
    expect(formatReplacementValue({ displayText: 'x', mode: 'bash', hasAtPrefix: true, needsQuotes: false, isComplete: false })).toBe('x')
    expect(formatReplacementValue({ displayText: 'x', mode: 'prompt', hasAtPrefix: false, needsQuotes: false, isComplete: true })).toBe('x')
  })

  test('applyShellSuggestion replaces the word under the cursor per completion type', () => {
    const out: Array<[string, number]> = []
    let value = ''
    const onChange = (v: string) => {
      value = v
    }
    const onCursor = (c: number) => out.push([value, c])
    applyShellSuggestion({ id: 'v', displayText: 'HOME' }, 'echo $HO tail', 8, onChange, onCursor, 'variable')
    applyShellSuggestion({ id: 'c', displayText: 'git' }, 'gi', 2, onChange, onCursor, 'command')
    applyShellSuggestion({ id: 'f', displayText: 'src/' }, 'ls sr', 5, onChange, onCursor, undefined)
    expect(out).toEqual([
      ['echo $HOME  tail', 11],
      ['git ', 4],
      ['ls src/', 7],
    ])
  })

  test('applyDirectorySuggestion adds @ and a / or space suffix', () => {
    expect(applyDirectorySuggestion('see @sr now', 'src', 4, 3, true)).toEqual({
      newInput: 'see @src/ now',
      cursorPos: 9,
    })
    expect(applyDirectorySuggestion('a.t', 'a.ts', 0, 3, false)).toEqual({
      newInput: '@a.ts ',
      cursorPos: 6,
    })
  })

  test('extractCompletionToken finds quoted, @ and bare tokens and extends past the cursor', () => {
    expect(extractCompletionToken('', 0)).toBeNull()
    expect(extractCompletionToken('open @"my fi', 12, true)).toEqual({
      token: '@"my fi',
      startPos: 5,
      isQuoted: true,
    })
    expect(extractCompletionToken('@"my file" x', 4, true)).toEqual({
      token: '@"my file"',
      startPos: 0,
      isQuoted: true,
    })
    expect(extractCompletionToken('see @src/ab rest', 8, true)).toEqual({
      token: '@src/ab',
      startPos: 4,
      isQuoted: false,
    })
    expect(extractCompletionToken('cat src/file.ts', 9, false)).toEqual({
      token: 'src/file.ts',
      startPos: 4,
      isQuoted: false,
    })
    // An @ glued to a word is not a mention start: the tail regex picks it up
    // from the @ onward.
    expect(extractCompletionToken('a@b', 3, true)).toEqual({
      token: '@b',
      startPos: 1,
      isQuoted: false,
    })
    expect(extractCompletionToken('done ', 5, true)).toBeNull()
  })
})

// ── slash commands ──────────────────────────────────────────────────────────

describe('slash commands', () => {
  test('"/" lists visible commands, selects the first, and sizes the column from all commands', async () => {
    const m = await mount()
    await m.type('/')
    const names = m.ctl.result.suggestions.map(s => s.displayText)
    expect(names).toContain('/help')
    expect(names).toContain('/clear')
    expect(names).toContain('/review')
    expect(names).not.toContain('/secret')
    expect(m.ctl.result.suggestionType).toBe('command')
    expect(m.ctl.result.selectedSuggestion).toBe(0)
    // longest visible name is "review" (6) + 6
    expect(m.ctl.result.maxColumnWidth).toBe(12)
  })

  test('an input with no matching command shows nothing', async () => {
    const m = await mount()
    await m.type('/zzzzqqq')
    expect(m.ctl.result.suggestions).toEqual([])
    expect(m.ctl.result.suggestionType).toBe('none')
  })

  test('Tab accepts the selected command without running it, then shows its static hint', async () => {
    const m = await mount()
    await m.type('/hel')
    expect(m.ctl.result.suggestions[0]?.displayText).toBe('/help')
    await m.press(KEY.tab)
    expect(m.ctl.input).toBe('/help ')
    expect(m.ctl.cursor).toBe(6)
    expect(m.calls.submits).toEqual([])
    expect(m.ctl.result.suggestions).toEqual([])
    expect(m.ctl.result.commandArgumentHint).toBe('[topic]')
  })

  test('Enter accepts and submits a command that takes no arguments', async () => {
    const m = await mount()
    await m.type('/clea')
    await m.press(KEY.enter)
    expect(m.ctl.input).toBe('/clear ')
    expect(m.calls.submits).toEqual([['/clear ', true]])
  })

  test('Enter on a prompt command with argNames fills it in without submitting', async () => {
    const m = await mount()
    await m.type('/revie')
    await m.press(KEY.enter)
    expect(m.ctl.input).toBe('/review ')
    expect(m.calls.submits).toEqual([])
    expect(m.ctl.result.commandArgumentHint).toBe('[repo] [branch]')
  })

  test('a prompt command shows a progressive hint over its remaining argNames', async () => {
    const m = await mount()
    await m.type('/review ')
    expect(m.ctl.result.commandArgumentHint).toBe('[repo] [branch]')
    expect(m.ctl.result.suggestions).toEqual([])
    await m.type('/review foo ')
    expect(m.ctl.result.commandArgumentHint).toBe('[branch]')
    await m.type('/review "a b" ')
    expect(m.ctl.result.commandArgumentHint).toBe('[branch]')
    await m.type('/review foo bar ')
    expect(m.ctl.result.commandArgumentHint).toBeUndefined()
  })

  test('typing an argument (no trailing space) clears a stale hint', async () => {
    const m = await mount()
    await m.type('/review foo ')
    expect(m.ctl.result.commandArgumentHint).toBe('[branch]')
    await m.type('/review foo b')
    expect(m.ctl.result.commandArgumentHint).toBeUndefined()
    expect(m.ctl.result.suggestions).toEqual([])
  })

  test('a static argumentHint shows only on exactly one trailing space', async () => {
    const m = await mount()
    await m.type('/help ')
    expect(m.ctl.result.commandArgumentHint).toBe('[topic]')
    await m.type('/help  ')
    expect(m.ctl.result.commandArgumentHint).toBeUndefined()
  })

  test('an unknown command with real arguments shows neither suggestions nor hint', async () => {
    const m = await mount()
    await m.type('/nope arg ')
    expect(m.ctl.result.suggestions).toEqual([])
    expect(m.ctl.result.commandArgumentHint).toBeUndefined()
  })

  test('down/up and ctrl+n/ctrl+p move the selection and wrap', async () => {
    const m = await mount()
    await m.type('/')
    const n = m.ctl.result.suggestions.length
    expect(n).toBe(3)
    await m.press(KEY.down)
    expect(m.ctl.result.selectedSuggestion).toBe(1)
    await m.press(KEY.up)
    expect(m.ctl.result.selectedSuggestion).toBe(0)
    await m.press(KEY.up)
    expect(m.ctl.result.selectedSuggestion).toBe(n - 1)
    await m.press(KEY.down)
    expect(m.ctl.result.selectedSuggestion).toBe(0)
    await m.press(KEY.ctrlN)
    expect(m.ctl.result.selectedSuggestion).toBe(1)
    await m.press(KEY.ctrlP)
    expect(m.ctl.result.selectedSuggestion).toBe(0)
  })

  test('leaving command input clears command suggestions', async () => {
    const m = await mount()
    await m.type('/hel')
    expect(m.ctl.result.suggestionType).toBe('command')
    await m.type('hello')
    expect(m.ctl.result.suggestions).toEqual([])
    expect(m.ctl.result.suggestionType).toBe('none')
  })

  test('Esc dismisses, and the same input does not re-trigger until it changes', async () => {
    const m = await mount()
    await m.type('/hel')
    expect(m.ctl.result.suggestions.length).toBeGreaterThan(0)
    await m.press(KEY.escape)
    expect(m.ctl.result.suggestions).toEqual([])
    // A fresh commands array recreates updateSuggestions and re-runs the
    // input effect; the dismissed input must stay dismissed.
    m.ctl.setExtra({ commands: [...COMMANDS] })
    await settle()
    expect(m.ctl.result.suggestions).toEqual([])
    await m.type('/he')
    expect(m.ctl.result.suggestions[0]?.displayText).toBe('/help')
  })

  test('suppressSuggestions clears everything and hides ghost text', async () => {
    const m = await mount()
    await m.type('/hel')
    expect(m.ctl.result.suggestions.length).toBeGreaterThan(0)
    m.ctl.setExtra({ suppressSuggestions: true })
    await settle()
    expect(m.ctl.result.suggestions).toEqual([])
    await m.type('run /he')
    expect(m.ctl.result.inlineGhostText).toBeUndefined()
  })
})

// ── ghost text ──────────────────────────────────────────────────────────────

describe('ghost text', () => {
  test('a mid-input slash command shows inline completion and Tab inserts it', async () => {
    const m = await mount()
    await m.type('run /hel')
    expect(m.ctl.result.inlineGhostText).toEqual({
      text: 'p',
      fullCommand: 'help',
      insertPosition: 8,
    })
    expect(m.ctl.result.suggestions).toEqual([])
    await m.press(KEY.tab)
    expect(m.ctl.input).toBe('run /help ')
    expect(m.ctl.cursor).toBe(10)
  })

  test('the prompt-suggestion ghost shows only with the cursor at the end, and Tab accepts it', async () => {
    const m = await mount('fix', {
      promptSuggestionGhost: { fullText: 'fix the bug', remainder: ' the bug' },
    })
    expect(m.ctl.result.inlineGhostText).toEqual({
      text: ' the bug',
      fullCommand: 'fix the bug',
      insertPosition: 3,
    })
    await m.type('fix', 1)
    expect(m.ctl.result.inlineGhostText).toBeUndefined()
    await m.type('fix', 3)
    await m.press(KEY.tab)
    expect(m.calls.accepted).toBe(1)
    expect(m.ctl.input).toBe('fix the bug')
    expect(m.ctl.cursor).toBe(11)
  })

  test('Esc over a prompt-suggestion ghost calls onDismissPromptSuggestion', async () => {
    let dismissed = 0
    const m = await mount('fix', {
      promptSuggestionGhost: { fullText: 'fix the bug', remainder: ' the bug' },
      onDismissPromptSuggestion: () => {
        dismissed++
      },
    })
    await m.press(KEY.escape)
    expect(dismissed).toBe(1)
  })

  test('bash mode shows history ghost text and Tab replaces the input with it', async () => {
    historySpy.mockImplementation(async (value: string) =>
      value === 'git st' ? { suffix: 'atus', fullCommand: 'git status' } : null,
    )
    const m = await mount('', { mode: 'bash' })
    await m.type('git st')
    expect(m.ctl.result.inlineGhostText).toEqual({
      text: 'atus',
      fullCommand: 'git status',
      insertPosition: 6,
    })
    await m.press(KEY.tab)
    expect(m.ctl.input).toBe('git status')
    expect(m.ctl.cursor).toBe(10)
    await m.type('ls -')
    expect(m.ctl.result.inlineGhostText).toBeUndefined()
  })

  test('bash mode discards a history result that arrives after the input moved on', async () => {
    const slow = deferred<{ suffix: string; fullCommand: string } | null>()
    historySpy.mockImplementation(async (value: string) =>
      value === 'gi' ? slow.promise : null,
    )
    const m = await mount('', { mode: 'bash' })
    await m.type('gi')
    await m.type('gx')
    slow.resolve({ suffix: 't log', fullCommand: 'git log' })
    await settle()
    expect(m.ctl.result.inlineGhostText).toBeUndefined()
  })

  test('bash mode ignores @ mentions', async () => {
    const m = await mount('', { mode: 'bash' })
    await m.type('cat @sr')
    await settle(90)
    expect(unifiedSpy).not.toHaveBeenCalled()
  })
})

// ── prompt suggestion from AppState ─────────────────────────────────────────

describe('AppState prompt suggestion', () => {
  function showSuggestion(m: Mounted, text: string): void {
    m.ctl.store.setState(prev => ({
      ...prev,
      promptSuggestion: { ...prev.promptSuggestion, text, shownAt: 1 },
    }))
  }

  test('Right on an empty input accepts it', async () => {
    const m = await mount()
    showSuggestion(m, 'run the tests')
    await settle()
    await m.press(KEY.right)
    expect(m.calls.accepted).toBe(1)
    expect(m.ctl.input).toBe('run the tests')
    expect(m.ctl.cursor).toBe(13)
  })

  test('a "!" suggestion switches to bash mode and strips the prefix', async () => {
    const modes: PromptInputMode[] = []
    const m = await mount('', { onModeChange: mode => modes.push(mode) })
    showSuggestion(m, '!ls -la')
    await settle()
    await m.press(KEY.tab)
    expect(modes).toEqual(['bash'])
    expect(m.ctl.input).toBe('ls -la')
    expect(m.calls.accepted).toBe(1)
  })

  test('nothing is accepted while viewing a teammate', async () => {
    const m = await mount()
    showSuggestion(m, 'run the tests')
    m.ctl.store.setState(prev => ({ ...prev, viewingAgentTaskId: 't1' }))
    await settle()
    await m.press(KEY.right)
    expect(m.calls.accepted).toBe(0)
    expect(m.ctl.input).toBe('')
  })

  test('Tab on an empty input with no suggestion shows the thinking-toggle hint', async () => {
    const m = await mount()
    await m.press(KEY.tab)
    const n = m.ctl.store.getState().notifications
    const keys = [n.current?.key, ...n.queue.map(q => q.key)]
    expect(keys).toContain('thinking-toggle-hint')
    expect(m.ctl.input).toBe('')
  })
})

// ── @ mentions: files and MCP resources ─────────────────────────────────────

describe('@ file suggestions', () => {
  test('are fetched after the 50 ms debounce with the token after @', async () => {
    unifiedSpy.mockImplementation(async () => [file('src/a.ts'), file('src/b.ts')])
    const m = await mount()
    m.ctl.setInput('see @sr')
    await waitFor(() => m.ctl.input === 'see @sr')
    await settle(10)
    expect(unifiedSpy).not.toHaveBeenCalled()
    await settle(90)
    expect(unifiedSpy).toHaveBeenCalledTimes(1)
    const [token, resources, agents, isAt] = unifiedSpy.mock.calls[0]!
    expect(token).toBe('sr')
    expect(resources).toEqual({})
    expect(agents).toEqual([])
    expect(isAt).toBe(true)
    expect(m.ctl.result.suggestionType).toBe('file')
    expect(m.ctl.result.suggestions.map(s => s.displayText)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(m.ctl.result.selectedSuggestion).toBe(0)
  })

  test('a stale result is discarded when a newer query started', async () => {
    const first = deferred<SuggestionItem[]>()
    const second = deferred<SuggestionItem[]>()
    unifiedSpy.mockImplementation(async (token: string) =>
      token === 'a' ? first.promise : second.promise,
    )
    const m = await mount()
    await m.type('@a')
    await settle(90)
    await m.type('@ab')
    await settle(90)
    second.resolve([file('ab.ts')])
    await settle()
    first.resolve([file('a.ts')])
    await settle()
    expect(m.ctl.result.suggestions.map(s => s.displayText)).toEqual(['ab.ts'])
  })

  test('an empty result clears the menu', async () => {
    unifiedSpy.mockImplementation(async (token: string) =>
      token === 'sr' ? [file('src/a.ts')] : [],
    )
    const m = await mount()
    await m.type('@sr')
    await settle(90)
    expect(m.ctl.result.suggestions.length).toBe(1)
    await m.type('@srq')
    await settle(90)
    expect(m.ctl.result.suggestions).toEqual([])
    expect(m.ctl.result.suggestionType).toBe('none')
  })

  test('Tab first completes the common prefix and keeps the menu open', async () => {
    unifiedSpy.mockImplementation(async () => [file('src/alpha.ts'), file('src/beta.ts')])
    const m = await mount()
    await m.type('@s')
    await settle(90)
    await m.press(KEY.tab)
    expect(m.calls.inputs[0]).toBe('@src/')
    expect(m.calls.cursors[0]).toBe(5)
  })

  test('Tab on a lone match completes it through the common-prefix path, with no trailing space', async () => {
    unifiedSpy.mockImplementation(async () => [file('README.md')])
    const m = await mount()
    await m.type('read @READ')
    await settle(90)
    await m.press(KEY.tab)
    expect(m.ctl.input).toBe('read @README.md')
    expect(m.ctl.cursor).toBe(15)
  })

  test('Tab with no common prefix inserts the selected file plus a space and closes', async () => {
    unifiedSpy.mockImplementation(async () => [file('x/a.ts'), file('y/a.ts')])
    const m = await mount()
    await m.type('read @a')
    await settle(90)
    await m.press(KEY.down)
    await m.press(KEY.tab)
    expect(m.ctl.input).toBe('read @y/a.ts ')
    expect(m.ctl.cursor).toBe(13)
    expect(m.ctl.result.suggestions).toEqual([])
  })

  test('Tab quotes a path with spaces', async () => {
    unifiedSpy.mockImplementation(async () => [file('my notes.md'), file('other.md')])
    const m = await mount()
    await m.type('@m')
    await settle(90)
    await m.press(KEY.tab)
    expect(m.ctl.input).toBe('@"my notes.md" ')
  })

  test('Enter on a file inserts it; Enter on a directory drills in', async () => {
    unifiedSpy.mockImplementation(async (token: string) =>
      token === 'do' ? [file('docs/'), file('doc.md')] : [file('doc.md')],
    )
    pathSpy.mockImplementation(async () => [
      { id: 'docs/a.md', displayText: 'a.md', metadata: { type: 'file' } },
    ])
    const m = await mount()
    await m.type('@do')
    await settle(90)
    await m.press(KEY.down)
    await m.press(KEY.enter)
    expect(m.ctl.input).toBe('@doc.md ')
    expect(m.ctl.result.suggestions).toEqual([])

    await m.type('@do')
    await settle(90)
    await m.press(KEY.enter)
    expect(m.ctl.input).toBe('@docs/')
    await settle(90)
    expect(pathSpy).toHaveBeenCalled()
    expect(pathSpy.mock.calls.at(-1)?.[0]).toBe('docs/')
  })

  test('Tab on a directory entry drills in without a trailing space', async () => {
    unifiedSpy.mockImplementation(async () => [file('lib/'), file('package.json')])
    const m = await mount()
    await m.type('@l')
    await settle(90)
    await m.press(KEY.tab)
    expect(m.ctl.input).toBe('@lib/')
    expect(m.ctl.cursor).toBe(5)
  })

  test('removing the @ re-queries without @, and a trailing space closes the menu', async () => {
    unifiedSpy.mockImplementation(async () => [file('src/a.ts')])
    const m = await mount()
    await m.type('@sr')
    await settle(90)
    expect(m.ctl.result.suggestionType).toBe('file')
    await m.type('sr')
    await settle(90)
    expect(unifiedSpy.mock.calls.at(-1)?.slice(0, 1)).toEqual(['sr'])
    expect(unifiedSpy.mock.calls.at(-1)?.[3]).toBe(false)
    await m.type('sr ')
    await settle(90)
    expect(m.ctl.result.suggestions).toEqual([])
  })

  test('the index-build-complete signal re-runs the last search', async () => {
    let fire: (() => void) | undefined
    const sub = spyOn(fileSuggestions, 'onIndexBuildComplete').mockImplementation(
      (listener: () => void) => {
        fire = listener
        return () => {}
      },
    )
    spies.push(sub)
    unifiedSpy.mockImplementation(async () => [file('src/a.ts')])
    const m = await mount()
    await m.type('@sr')
    await settle(90)
    expect(unifiedSpy).toHaveBeenCalledTimes(1)
    fire?.()
    await settle()
    expect(unifiedSpy).toHaveBeenCalledTimes(2)
    expect(unifiedSpy.mock.calls[1]?.[0]).toBe('sr')
    expect(unifiedSpy.mock.calls[1]?.[3]).toBe(false)
  })
})

// ── @ path completion (path-like tokens) ────────────────────────────────────

describe('@ path completion', () => {
  const DIR = { id: './src', displayText: 'src/', metadata: { type: 'directory' } }
  const FILE = { id: './src/a.ts', displayText: 'a.ts', metadata: { type: 'file' } }

  test('a path-like token lists the directory instead of fuzzy searching', async () => {
    pathSpy.mockImplementation(async () => [DIR])
    const m = await mount()
    await m.type('@./sr')
    expect(pathSpy).toHaveBeenCalledWith('./sr', { maxResults: 100 })
    expect(m.ctl.result.suggestionType).toBe('directory')
    expect(m.ctl.result.suggestions).toEqual([DIR])
    await settle(90)
    expect(unifiedSpy).not.toHaveBeenCalled()
  })

  test('no path results falls back to the fuzzy search', async () => {
    const m = await mount()
    await m.type('@./zz')
    await settle(90)
    expect(unifiedSpy).toHaveBeenCalledTimes(1)
    expect(unifiedSpy.mock.calls[0]?.[0]).toBe('./zz')
  })

  test('Tab on a directory drills in; Tab on a file inserts it and closes', async () => {
    pathSpy.mockImplementation(async (token: string) =>
      token === './src/' ? [FILE] : [DIR],
    )
    const m = await mount()
    await m.type('@./sr')
    await m.press(KEY.tab)
    expect(m.ctl.input).toBe('@./src/')
    expect(m.ctl.result.suggestions).toEqual([FILE])
    await m.press(KEY.tab)
    expect(m.ctl.input).toBe('@./src/a.ts ')
    expect(m.ctl.result.suggestions).toEqual([])
  })

  test('Enter on a directory drills in; Enter on a file inserts it and closes', async () => {
    pathSpy.mockImplementation(async (token: string) =>
      token === './src/' ? [FILE] : [DIR],
    )
    const m = await mount()
    await m.type('@./sr')
    await m.press(KEY.enter)
    expect(m.ctl.input).toBe('@./src/')
    expect(m.ctl.result.suggestions).toEqual([FILE])
    await m.press(KEY.enter)
    expect(m.ctl.input).toBe('@./src/a.ts ')
    expect(m.ctl.result.suggestions).toEqual([])
  })

  test('a slower path result is discarded once a newer token started', async () => {
    const slow = deferred<SuggestionItem[]>()
    pathSpy.mockImplementation(async (token: string) =>
      token === './a' ? slow.promise : [FILE],
    )
    const m = await mount()
    await m.type('@./a')
    await m.type('@./ab')
    slow.resolve([DIR])
    await settle()
    expect(m.ctl.result.suggestions).toEqual([FILE])
  })
})

// ── /add-dir and /resume ────────────────────────────────────────────────────

describe('command argument completion', () => {
  const ADD_DIR = localCommand('add-dir')
  const RESUME = localCommand('resume')
  const SRC = { id: 'src', displayText: 'src/', metadata: { type: 'directory' } }
  const NOTES = { id: 'notes.txt', displayText: 'notes.txt', metadata: { type: 'file' } }

  test('/add-dir lists directories for its argument', async () => {
    dirSpy.mockImplementation(async () => [SRC])
    const m = await mount('', { commands: [ADD_DIR] })
    await m.type('/add-dir sr')
    expect(dirSpy).toHaveBeenCalledWith('sr')
    expect(m.ctl.result.suggestionType).toBe('directory')
    expect(m.ctl.result.suggestions).toEqual([SRC])
  })

  test('/add-dir Tab replaces the argument; a directory keeps listing', async () => {
    dirSpy.mockImplementation(async (arg: string) => (arg === 'src/' ? [NOTES] : [SRC]))
    const m = await mount('', { commands: [ADD_DIR] })
    await m.type('/add-dir sr')
    await m.press(KEY.tab)
    expect(m.ctl.input).toBe('/add-dir src/')
    expect(m.ctl.result.suggestions).toEqual([NOTES])
    await m.press(KEY.tab)
    expect(m.ctl.input).toBe('/add-dir notes.txt ')
  })

  test('/add-dir Enter only closes the menu so the command submits as typed', async () => {
    dirSpy.mockImplementation(async () => [SRC])
    const m = await mount('', { commands: [ADD_DIR] })
    await m.type('/add-dir sr')
    await m.press(KEY.enter)
    expect(m.ctl.input).toBe('/add-dir sr')
    expect(m.calls.inputs).toEqual([])
    expect(m.calls.submits).toEqual([])
  })

  test('/add-dir closes on a trailing space or no results', async () => {
    dirSpy.mockImplementation(async (arg: string) => (arg === 'sr' ? [SRC] : []))
    const m = await mount('', { commands: [ADD_DIR] })
    await m.type('/add-dir sr')
    expect(m.ctl.result.suggestions.length).toBe(1)
    await m.type('/add-dir src ')
    expect(m.ctl.result.suggestions).toEqual([])
    await m.type('/add-dir sr')
    await m.type('/add-dir zz')
    expect(m.ctl.result.suggestions).toEqual([])
  })

  function log(title: string, sessionId: string) {
    return {
      customTitle: title,
      sessionId,
      modified: new Date(),
      messageCount: 3,
      messages: [],
    }
  }

  test('/resume lists sessions by custom title; Tab fills in the session id', async () => {
    titleSpy.mockImplementation(async () => [log('my work', 'sess-1')])
    const m = await mount('', { commands: [RESUME] })
    await m.type('/resume my')
    expect(titleSpy).toHaveBeenCalledWith('my', { limit: 10 })
    expect(m.ctl.result.suggestionType).toBe('custom-title')
    expect(m.ctl.result.suggestions[0]).toMatchObject({
      id: 'resume-title-sess-1',
      displayText: 'my work',
      metadata: { sessionId: 'sess-1' },
    })
    await m.press(KEY.tab)
    expect(m.ctl.input).toBe('/resume sess-1')
    expect(m.calls.submits).toEqual([])
  })

  test('/resume Enter fills in and submits', async () => {
    titleSpy.mockImplementation(async () => [log('my work', 'sess-1')])
    const m = await mount('', { commands: [RESUME] })
    await m.type('/resume my')
    await m.press(KEY.enter)
    expect(m.calls.submits).toEqual([['/resume sess-1', true]])
  })

  test('/resume with no match clears, and leaving /resume clears its titles', async () => {
    titleSpy.mockImplementation(async (q: string) => (q === 'my' ? [log('my work', 'sess-1')] : []))
    const m = await mount('', { commands: [RESUME] })
    await m.type('/resume zz')
    expect(m.ctl.result.suggestions).toEqual([])
    await m.type('/resume my')
    expect(m.ctl.result.suggestionType).toBe('custom-title')
    await m.type('hello')
    expect(m.ctl.result.suggestions).toEqual([])
    expect(m.ctl.result.suggestionType).toBe('none')
  })
})

// ── @ team members / named agents ───────────────────────────────────────────

describe('@ agent members', () => {
  function seedAgents(m: Mounted): void {
    m.ctl.store.setState(prev => ({
      ...prev,
      agentNameRegistry: new Map([
        ['alice', 'a1'],
        ['albert', 'a2'],
      ]) as typeof prev.agentNameRegistry,
      tasks: { a1: { status: 'running' } } as unknown as typeof prev.tasks,
    }))
  }

  test('named agents matching the prefix are offered with their task status', async () => {
    const m = await mount()
    seedAgents(m)
    await m.type('hey @al')
    expect(m.ctl.result.suggestionType).toBe('agent')
    expect(m.ctl.result.suggestions).toEqual([
      { id: 'dm-alice', displayText: '@alice', description: 'send message · running' },
      { id: 'dm-albert', displayText: '@albert', description: 'send message' },
    ])
    await settle(90)
    expect(unifiedSpy).not.toHaveBeenCalled()
  })

  test('swarm teammates come first, the team lead is skipped, and a name is not repeated', async () => {
    swarmSpy.mockImplementation(() => true)
    const m = await mount()
    seedAgents(m)
    m.ctl.store.setState(prev => ({
      ...prev,
      teamContext: {
        teamName: 't',
        teamFilePath: '/tmp/t',
        leadAgentId: 'lead',
        teammates: {
          lead: { name: 'team-lead', tmuxSessionName: '', tmuxPaneId: '', cwd: '/', spawnedAt: 0 },
          x: { name: 'alice', tmuxSessionName: '', tmuxPaneId: '', cwd: '/', spawnedAt: 0 },
          y: { name: 'bob', tmuxSessionName: '', tmuxPaneId: '', cwd: '/', spawnedAt: 0 },
        },
      },
    }))
    await m.type('@')
    expect(m.ctl.result.suggestions.map(s => s.displayText)).toEqual([
      '@alice',
      '@bob',
      '@albert',
    ])
    expect(m.ctl.result.suggestions[0]?.description).toBe('send message')
  })

  test('Tab and Enter replace the @ token with the member and a space', async () => {
    const m = await mount()
    seedAgents(m)
    await m.type('hey @ali')
    await m.press(KEY.tab)
    expect(m.ctl.input).toBe('hey @alice ')
    expect(m.ctl.cursor).toBe(11)
    await m.type('@alb')
    await m.press(KEY.enter)
    expect(m.ctl.input).toBe('@albert ')
  })

  test('dropping the @ clears member suggestions', async () => {
    const m = await mount()
    seedAgents(m)
    await m.type('@al')
    expect(m.ctl.result.suggestionType).toBe('agent')
    await m.type('al')
    expect(m.ctl.result.suggestions).toEqual([])
  })
})

// ── # Slack channels ────────────────────────────────────────────────────────

describe('# slack channels', () => {
  const GENERAL = { id: 'slack-general', displayText: '#general' }
  const GENTLE = { id: 'slack-gentle', displayText: '#gentle' }

  test('need a Slack MCP server', async () => {
    const m = await mount()
    await m.type('post in #gen')
    await settle(200)
    expect(slackSpy).not.toHaveBeenCalled()
  })

  test('are fetched once after the 150 ms debounce with the partial after #', async () => {
    hasSlackSpy.mockImplementation(() => true)
    slackSpy.mockImplementation(async () => [GENERAL, GENTLE])
    const m = await mount()
    m.ctl.setInput('post in #ge')
    await settle(10)
    m.ctl.setInput('post in #gen')
    await waitFor(() => m.ctl.input === 'post in #gen')
    await settle(10)
    expect(slackSpy).not.toHaveBeenCalled()
    await settle(200)
    expect(slackSpy).toHaveBeenCalledTimes(1)
    expect(slackSpy.mock.calls[0]?.[1]).toBe('gen')
    expect(m.ctl.result.suggestionType).toBe('slack-channel')
    expect(m.ctl.result.suggestions).toEqual([GENERAL, GENTLE])
  })

  test('a stale channel result is discarded', async () => {
    hasSlackSpy.mockImplementation(() => true)
    const first = deferred<SuggestionItem[]>()
    slackSpy.mockImplementation(async (_clients: unknown, partial: string) =>
      partial === 'g' ? first.promise : [GENTLE],
    )
    const m = await mount()
    await m.type('#g')
    await settle(200)
    await m.type('#gent')
    await settle(200)
    first.resolve([GENERAL])
    await settle()
    expect(m.ctl.result.suggestions).toEqual([GENTLE])
  })

  test('an empty channel result sets type none', async () => {
    hasSlackSpy.mockImplementation(() => true)
    const m = await mount()
    await m.type('#zz')
    await settle(200)
    expect(slackSpy).toHaveBeenCalledTimes(1)
    expect(slackSpy.mock.calls[0]?.[1]).toBe('zz')
    expect(m.ctl.result.suggestionType).toBe('none')
  })

  test('Tab and Enter replace the # token with the channel and a space', async () => {
    hasSlackSpy.mockImplementation(() => true)
    slackSpy.mockImplementation(async () => [GENERAL, GENTLE])
    const m = await mount()
    await m.type('post #gen')
    await settle(200)
    await m.press(KEY.tab)
    expect(m.ctl.input).toBe('post #general ')
    expect(m.ctl.cursor).toBe(14)
    await m.type('#gen')
    await settle(200)
    await m.press(KEY.down)
    await m.press(KEY.enter)
    expect(m.ctl.input).toBe('#gentle ')
  })

  test('moving off the # clears channel suggestions', async () => {
    hasSlackSpy.mockImplementation(() => true)
    slackSpy.mockImplementation(async () => [GENERAL])
    const m = await mount()
    await m.type('#gen')
    await settle(200)
    expect(m.ctl.result.suggestionType).toBe('slack-channel')
    await m.type('#gen ')
    expect(m.ctl.result.suggestions).toEqual([])
    expect(m.ctl.result.suggestionType).toBe('none')
  })
})

// ── MCP prompt argument values (completion/complete) ───────────────────────

describe('MCP prompt argument values', () => {
  type Values = (argName: string, partial: string, filled: Readonly<Record<string, string>>) => Promise<string[]>

  function mcpGreet(argumentValues?: Values): Command {
    return {
      type: 'prompt',
      name: 'mcp__srv__greet',
      description: 'Greet',
      progressMessage: 'running',
      contentLength: 0,
      source: 'mcp',
      isMcp: true,
      argNames: ['name', 'greeting'],
      argSpecs: [
        { name: 'name', required: true, description: 'Who to greet' },
        { name: 'greeting', required: false },
      ],
      ...(argumentValues && { argumentValues }),
      userFacingName: () => 'srv:greet (MCP)',
      getPromptForCommand: async () => [],
    } as unknown as Command
  }

  function people(): { calls: Array<[string, string, Record<string, string>]>; values: Values } {
    const calls: Array<[string, string, Record<string, string>]> = []
    const values: Values = async (argName, partial, filled) => {
      calls.push([argName, partial, { ...filled }])
      if (argName === 'greeting') return ['Hello', 'Hi']
      return ['Alice', 'Alicia', 'Bob', 'Mary Ann'].filter(p => p.startsWith(partial))
    }
    return { calls, values }
  }

  const shown = (m: Mounted) => m.ctl.result.suggestions.map(s => s.displayText)

  test('values for the argument being typed appear after the debounce', async () => {
    const { calls, values } = people()
    const m = await mount('', { commands: [mcpGreet(values)] })
    await m.type('/mcp__srv__greet Al')
    expect(calls).toEqual([])
    await settle(200)
    expect(calls).toEqual([['name', 'Al', {}]])
    expect(m.ctl.result.suggestionType).toBe('prompt-argument')
    expect(shown(m)).toEqual(['Alice', 'Alicia'])
    expect(m.ctl.result.selectedSuggestion).toBe(0)
    // The type change re-runs the update for the same input: no second request
    await settle(200)
    expect(calls).toHaveLength(1)
  })

  test('between arguments the hint shows at once and the values follow', async () => {
    const { values } = people()
    const m = await mount('', { commands: [mcpGreet(values)] })
    await m.type('/srv:greet (MCP) ')
    expect(m.ctl.result.commandArgumentHint).toBe('<name> [greeting] · Who to greet')
    expect(m.ctl.result.suggestions).toEqual([])
    await settle(200)
    expect(shown(m)).toEqual(['Alice', 'Alicia', 'Bob', 'Mary Ann'])
    expect(m.ctl.result.commandArgumentHint).toBe('<name> [greeting] · Who to greet')
  })

  test('a stale response is discarded', async () => {
    const first = deferred<string[]>()
    const values: Values = async (_arg, partial) => (partial === 'A' ? first.promise : ['Alice'])
    const m = await mount('', { commands: [mcpGreet(values)] })
    await m.type('/mcp__srv__greet A')
    await settle(200)
    await m.type('/mcp__srv__greet Al')
    await settle(200)
    expect(shown(m)).toEqual(['Alice'])
    first.resolve(['Andrew'])
    await settle()
    expect(shown(m)).toEqual(['Alice'])
  })

  test('a response that lands after the line left the prompt is dropped', async () => {
    const pending = deferred<string[]>()
    const m = await mount('', { commands: [mcpGreet(async () => pending.promise)] })
    await m.type('/mcp__srv__greet Al')
    await settle(200)
    await m.type('hello')
    pending.resolve(['Alice'])
    await settle()
    expect(m.ctl.result.suggestions).toEqual([])
    expect(m.ctl.result.suggestionType).toBe('none')
  })

  test('Tab accepts a multi-word value quoted, then asks for the next argument with it', async () => {
    const { calls, values } = people()
    const m = await mount('', { commands: [mcpGreet(values)] })
    await m.type('/mcp__srv__greet Ma')
    await settle(200)
    expect(shown(m)).toEqual(['Mary Ann'])
    await m.press(KEY.tab)
    expect(m.ctl.input).toBe('/mcp__srv__greet "Mary Ann" ')
    expect(m.ctl.cursor).toBe(28)
    expect(m.calls.submits).toEqual([])
    expect(m.ctl.result.commandArgumentHint).toBe('[greeting]')
    await settle(200)
    expect(calls.at(-1)).toEqual(['greeting', '', { name: 'Mary Ann' }])
    expect(shown(m)).toEqual(['Hello', 'Hi'])
  })

  test('Enter accepts the selected value without submitting', async () => {
    const { values } = people()
    const m = await mount('', { commands: [mcpGreet(values)] })
    await m.type('/srv:greet (MCP) Al')
    await settle(200)
    await m.press(KEY.down)
    await m.press(KEY.enter)
    expect(m.ctl.input).toBe('/srv:greet (MCP) Alicia ')
    expect(m.calls.submits).toEqual([])
  })

  test('rows for the previous argument go when the next one starts', async () => {
    const later = deferred<string[]>()
    const values: Values = async argName => (argName === 'name' ? ['Alice'] : later.promise)
    const m = await mount('', { commands: [mcpGreet(values)] })
    await m.type('/mcp__srv__greet Al')
    await settle(200)
    expect(shown(m)).toEqual(['Alice'])
    await m.type('/mcp__srv__greet Al ')
    expect(m.ctl.result.suggestions).toEqual([])
    expect(m.ctl.result.commandArgumentHint).toBe('[greeting]')
    later.resolve(['Hi'])
  })

  test('rows for the same argument stay while its next fetch runs', async () => {
    const later = deferred<string[]>()
    const values: Values = async (_arg, partial) => (partial === 'A' ? ['Alice'] : later.promise)
    const m = await mount('', { commands: [mcpGreet(values)] })
    await m.type('/mcp__srv__greet A')
    await settle(200)
    await m.type('/mcp__srv__greet Al')
    expect(shown(m)).toEqual(['Alice'])
    later.resolve(['Alicia'])
    await settle(200)
    expect(shown(m)).toEqual(['Alicia'])
  })

  test('no values leave only the hint', async () => {
    const m = await mount('', { commands: [mcpGreet(async () => [])] })
    await m.type('/mcp__srv__greet ')
    await settle(200)
    expect(m.ctl.result.suggestions).toEqual([])
    expect(m.ctl.result.suggestionType).toBe('none')
    expect(m.ctl.result.commandArgumentHint).toBe('<name> [greeting] · Who to greet')
  })

  test('a server without completions shows only the hint', async () => {
    const m = await mount('', { commands: [mcpGreet()] })
    await m.type('/srv:greet (MCP) ')
    expect(m.ctl.result.commandArgumentHint).toBe('<name> [greeting] · Who to greet')
    await settle(200)
    expect(m.ctl.result.suggestions).toEqual([])
    expect(m.ctl.result.suggestionType).toBe('none')
    await m.type('/srv:greet (MCP) Al')
    expect(m.ctl.result.commandArgumentHint).toBeUndefined()
    await m.type('/srv:greet (MCP) Al ')
    expect(m.ctl.result.commandArgumentHint).toBe('[greeting]')
  })

  test('typing every argument, or leaving the command, clears the values', async () => {
    const { values } = people()
    const m = await mount('', { commands: [mcpGreet(values)] })
    await m.type('/mcp__srv__greet Al')
    await settle(200)
    expect(m.ctl.result.suggestionType).toBe('prompt-argument')
    await m.type('/mcp__srv__greet Alice Hi there')
    expect(m.ctl.result.suggestions).toEqual([])
    expect(m.ctl.result.suggestionType).toBe('none')
    await m.type('/mcp__srv__greet Al')
    await settle(200)
    await m.type('hello')
    expect(m.ctl.result.suggestions).toEqual([])
  })

  test('Esc dismisses the values for that input', async () => {
    const { values } = people()
    const m = await mount('', { commands: [mcpGreet(values)] })
    await m.type('/mcp__srv__greet Al')
    await settle(200)
    await m.press(KEY.escape)
    expect(m.ctl.result.suggestions).toEqual([])
    await settle(200)
    expect(m.ctl.result.suggestions).toEqual([])
  })
})
