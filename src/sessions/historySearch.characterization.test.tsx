/**
 * Characterization suite for the prompt-history search, written before its
 * clean-base rewrite: the new code has to pass it unchanged.
 *
 * Two ways back to a prompt typed earlier, both reading `history.jsonl` under
 * the config directory:
 *   - `useHistorySearch`, the inline search: while the user types a query in
 *     the footer, the prompt box shows the newest prompt that contains it. It
 *     is driven through `SearchablePrompt` below, which owns the prompt's
 *     state the way the real prompt input does and stands in for the footer's
 *     query box.
 *   - `HistorySearchDialog`, the Ctrl+R picker of the shipped build.
 *
 * Every test gets a fresh config directory holding a real history file and a
 * fixed project root. Keys go in as raw bytes through a fake TTY and the
 * dialog is read off the painted frame. docs/tech/rewrite/sessions/historySearch.md
 * is the spec.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import { useEffect, useState } from 'react'
import stripAnsi from 'strip-ansi'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import type { HistoryEntry } from 'src/platform/config/config.js'
import { useHistorySearch } from 'src/sessions/hooks/useHistorySearch.js'
import { HistorySearchDialog } from 'src/sessions/ui/HistorySearchDialog.js'
import type { PromptInputMode } from 'src/shared/types/textInputTypes.js'
import { createFakeTerminal, type FakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { useIsModalOverlayActive } from 'src/terminal/contexts/overlayContext.js'
import { KeyboardEvent } from 'src/terminal/ink/events/keyboard-event.js'
import { createRoot, Text, useInput } from 'src/terminal/ink.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { AppStoreContext } from 'src/terminal/state/AppState.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import { createStore } from 'src/terminal/state/store.js'

/** Every test mounts a real Ink root and waits on key parsing and file reads. */
const SLOW = 20_000

const CTRL_R = '\x12'
const CTRL_C = '\x03'
const CTRL_D = '\x04'
const CTRL_G = '\x07'
const CTRL_N = '\x0e'
const CTRL_P = '\x10'
const CTRL_U = '\x15'
const ESC = '\x1b'
const ENTER = '\r'
const TAB = '\t'
const SHIFT_TAB = '\x1b[Z'
const BACKSPACE = '\x7f'
const UP = '\x1b[A'
const DOWN = '\x1b[B'

const PROJECT = '/work/alpha'
const OTHER_PROJECT = '/work/beta'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const FIXTURE = join(import.meta.dir, '__fixtures__', 'rewrite', 'historySearch')
const FIXTURE_PROJECT = '/work/fixture'

// --- the history on disk ----------------------------------------------------------

let configHome = ''
let restore: () => void = () => {}

beforeEach(() => {
  const previousDir = process.env.CLAUDIN_CONFIG_DIR
  const previousRoot = getProjectRoot()
  configHome = mkdtempSync(join(tmpdir(), 'history-search-'))
  process.env.CLAUDIN_CONFIG_DIR = configHome
  setProjectRoot(PROJECT)
  restore = () => {
    if (previousDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
    else process.env.CLAUDIN_CONFIG_DIR = previousDir
    setProjectRoot(previousRoot)
    rmSync(configHome, { recursive: true, force: true })
  }
})

afterEach(() => restore())

/** One remembered prompt. Unless told otherwise it belongs to PROJECT. */
type Remembered = {
  display: string
  project?: string
  /** How long ago it was typed. By default each prompt is a few minutes older than the next. */
  ago?: number
  /** An absolute timestamp, for when two prompts must share one. */
  at?: number
  pastedContents?: Record<number, object>
}

/** Writes history.jsonl the way the app appends it: oldest first, one JSON object per line. */
function rememberPrompts(prompts: Remembered[]): void {
  const now = Date.now()
  const lines = prompts.map((prompt, index) => {
    const age = prompt.ago ?? (prompts.length - index) * 7 * MINUTE + 30_000
    const record = {
      display: prompt.display,
      pastedContents: prompt.pastedContents ?? {},
      timestamp: prompt.at ?? now - age,
      project: prompt.project ?? PROJECT,
      sessionId: 'b7e3c9d0-1111-4222-8333-944455556666',
    }
    return `${JSON.stringify(record)}\n`
  })
  writeFileSync(join(configHome, 'history.jsonl'), lines.join(''))
}

/** A large paste lives in the paste store, named after the hash its history entry points to. */
function storePaste(hash: string, body: string): void {
  mkdirSync(join(configHome, 'paste-cache'), { recursive: true })
  writeFileSync(join(configHome, 'paste-cache', `${hash}.txt`), body)
}

/** The history and paste store a real session wrote (see the fixture's origin in the spec). */
function useRecordedSession(): void {
  cpSync(FIXTURE, configHome, { recursive: true })
  setProjectRoot(FIXTURE_PROJECT)
}

/** Three pastes on one prompt: one inline, one in the paste store, one whose stored copy is gone. */
const PASTES_ON_DISK = {
  1: { id: 1, type: 'text', content: 'small paste\nsecond row' },
  2: { id: 2, type: 'text', contentHash: '00aa11bb22cc33dd' },
  3: { id: 3, type: 'text', contentHash: 'ffffffffffffffff' },
}
const PASTES_RESOLVED = {
  1: { id: 1, type: 'text', content: 'small paste\nsecond row' },
  2: { id: 2, type: 'text', content: 'large paste\nfrom the store' },
}

// --- waiting on a live tree ----------------------------------------------------------

async function waitUntil(check: () => boolean, what: string, describeState: () => string): Promise<void> {
  const deadline = Date.now() + 4_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.\n${describeState()}`)
    await Bun.sleep(10)
  }
}

/** Long enough for a key that does something to have done it. */
const quietPeriod = () => Bun.sleep(300)

type Mounted = { terminal: FakeTerminal; render: (node: React.ReactNode) => void; close: () => void }

async function mountInTerminal(node: React.ReactNode, columns: number): Promise<Mounted> {
  const terminal = createFakeTerminal({ columns })
  const root = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, patchConsole: false, exitOnCtrlC: false })
  // Only the overlay registry of the app state is involved here, so a bare store stands in for it.
  const store = createStore({ activeOverlays: new Set<string>() } as unknown as AppState)
  const render = (inner: React.ReactNode) =>
    root.render(
      <AppStoreContext.Provider value={store}>
        <KeybindingSetup>{inner}</KeybindingSetup>
      </AppStoreContext.Provider>,
    )
  render(node)
  return {
    terminal,
    render,
    close: () => {
      root.unmount()
      terminal.close()
    },
  }
}

/** Rendered after the component under test: its effect runs once that component's own effects (key handlers included) have. */
function AfterMount({ onMounted }: { onMounted: () => void }): React.ReactNode {
  useEffect(onMounted, [onMounted])
  return null
}

// =====================================================================================
// useHistorySearch: the inline search
// =====================================================================================

type PromptStart = {
  input?: string
  cursor?: number
  mode?: PromptInputMode
  pasted?: HistoryEntry['pastedContents']
}

/** What the prompt looks like, and what the hook reports, after the latest render. */
type PromptState = {
  input: string
  cursor: number
  mode: PromptInputMode
  pasted: HistoryEntry['pastedContents']
  searching: boolean
  query: string
  match: HistoryEntry | undefined
  failed: boolean
  handleKeyDown: (event: KeyboardEvent) => void
}

type PromptProbe = { latest?: PromptState; submitted: HistoryEntry[] }

function SearchablePrompt({ start, probe }: { start: PromptStart; probe: PromptProbe }): React.ReactNode {
  const [input, setInput] = useState(start.input ?? '')
  const [cursor, setCursor] = useState(start.cursor ?? (start.input ?? '').length)
  const [mode, setMode] = useState<PromptInputMode>(start.mode ?? 'prompt')
  const [pasted, setPasted] = useState<HistoryEntry['pastedContents']>(start.pasted ?? {})
  const [searching, setSearching] = useState(false)
  const search = useHistorySearch(
    entry => {
      probe.submitted.push(entry)
    },
    input,
    setInput,
    setCursor,
    cursor,
    setMode,
    mode,
    searching,
    setSearching,
    setPasted,
    pasted,
  )
  // The footer's query box. While a search runs, typed or pasted text is added
  // to the query, Backspace takes off one character, and Ctrl+U clears it.
  useInput((text, key) => {
    if (!searching) return
    if (key.backspace) {
      search.setHistoryQuery(search.historyQuery.slice(0, -1))
    } else if (key.ctrl && text === 'u') {
      search.setHistoryQuery('')
    } else if (!key.ctrl && !key.meta && !key.return && !key.tab && text !== '') {
      search.setHistoryQuery(search.historyQuery + text)
    }
  })
  probe.latest = {
    input,
    cursor,
    mode,
    pasted,
    searching,
    query: search.historyQuery,
    match: search.historyMatch,
    failed: search.historyFailedMatch,
    handleKeyDown: search.handleKeyDown,
  }
  return <Text>{`${searching ? `searching "${search.historyQuery}"` : 'idle'} | ${mode} | ${input}`}</Text>
}

type PromptSession = {
  now: () => PromptState
  submitted: HistoryEntry[]
  press: (keys: string) => void
  until: (check: (state: PromptState) => boolean, what: string) => Promise<void>
  close: () => void
}

async function openPrompt(start: PromptStart = {}): Promise<PromptSession> {
  const probe: PromptProbe = { submitted: [] }
  let mounted = false
  const markMounted = () => {
    mounted = true
  }
  const ink = await mountInTerminal(
    <>
      <SearchablePrompt start={start} probe={probe} />
      <AfterMount onMounted={markMounted} />
    </>,
    80,
  )
  const now = (): PromptState => {
    if (!probe.latest) throw new Error('the prompt never rendered')
    return probe.latest
  }
  const describeState = () => JSON.stringify({ ...probe.latest, handleKeyDown: undefined, submitted: probe.submitted })
  await waitUntil(() => mounted && probe.latest !== undefined, 'the prompt to mount', describeState)
  return {
    now,
    submitted: probe.submitted,
    press: keys => ink.terminal.type(keys),
    until: (check, what) => waitUntil(() => check(now()), what, describeState),
    close: ink.close,
  }
}

async function withPrompt(start: PromptStart, check: (prompt: PromptSession) => Promise<void>): Promise<void> {
  const prompt = await openPrompt(start)
  try {
    await check(prompt)
  } finally {
    prompt.close()
  }
}

async function startSearch(prompt: PromptSession): Promise<void> {
  prompt.press(CTRL_R)
  await prompt.until(state => state.searching, 'Ctrl+R to start a search')
}

/**
 * Adds `text` to the query in one change, the way a paste reaches the query
 * box. Typed characters arrive one key at a time, and each one starts a search
 * of its own (see the spec's findings on overlapping searches).
 */
function pasteQuery(prompt: PromptSession, text: string): void {
  prompt.press(`\x1b[200~${text}\x1b[201~`)
}

/** Pastes into the query and waits for the search to land on `display`. */
async function searchFor(prompt: PromptSession, text: string, display: string): Promise<void> {
  pasteQuery(prompt, text)
  await prompt.until(state => state.match?.display === display && !state.failed, `"${text}" to find ${JSON.stringify(display)}`)
}

async function clearQuery(prompt: PromptSession): Promise<void> {
  prompt.press(CTRL_U)
  await prompt.until(state => state.query === '', 'the query to be cleared')
}

async function backspaceOnce(prompt: PromptSession): Promise<void> {
  const shorter = prompt.now().query.slice(0, -1)
  prompt.press(BACKSPACE)
  await prompt.until(state => state.query === shorter, `the query to shrink to "${shorter}"`)
}

function keyDown(name: string, sequence: string): KeyboardEvent {
  return new KeyboardEvent({
    kind: 'key',
    name,
    sequence,
    raw: sequence,
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    isPasted: false,
  })
}

/** Oldest first. One prompt is from another project, one is in bash mode, one repeats. */
const BUILD_HISTORY: Remembered[] = [
  { display: 'npm run build' },
  { display: 'git log --oneline' },
  { display: '!git status' },
  { display: 'deploy to staging', project: OTHER_PROJECT },
  { display: 'Run the Build twice' },
  { display: 'npm run build' },
  { display: 'npm run build -- --watch' },
]

describe('useHistorySearch: starting a search', () => {
  test(
    'Ctrl+R starts a search and leaves the prompt exactly as it was',
    async () => {
      rememberPrompts(BUILD_HISTORY)
      await withPrompt({ input: 'draft', cursor: 2, pasted: { 1: { id: 1, type: 'text', content: 'mine' } } }, async prompt => {
        await startSearch(prompt)
        await quietPeriod()
        expect(prompt.now()).toMatchObject({
          input: 'draft',
          cursor: 2,
          mode: 'prompt',
          pasted: { 1: { id: 1, type: 'text', content: 'mine' } },
          query: '',
          match: undefined,
          failed: false,
        })
      })
    },
    SLOW,
  )

  test(
    'while no search runs, its keys do nothing: Esc, Tab, Enter, Ctrl+C, Backspace',
    async () => {
      rememberPrompts(BUILD_HISTORY)
      await withPrompt({ input: 'untouched', cursor: 4 }, async prompt => {
        for (const key of [ESC, TAB, ENTER, CTRL_C, BACKSPACE]) {
          prompt.press(key)
          // A bare ESC is only an Esc once the parser has waited for more bytes.
          await Bun.sleep(100)
        }
        await quietPeriod()
        expect(prompt.submitted).toEqual([])
        expect(prompt.now()).toMatchObject({ searching: false, input: 'untouched', cursor: 4, mode: 'prompt' })
      })
    },
    SLOW,
  )
})

describe('useHistorySearch: what a query finds', () => {
  test(
    'the newest prompt holding the query fills the prompt box, with the cursor where the query starts',
    async () => {
      rememberPrompts(BUILD_HISTORY)
      await withPrompt({ input: 'draft' }, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'build', 'npm run build -- --watch')
        expect(prompt.now()).toMatchObject({
          input: 'npm run build -- --watch',
          cursor: 8,
          mode: 'prompt',
          pasted: {},
          match: { display: 'npm run build -- --watch', pastedContents: {} },
          failed: false,
          searching: true,
        })
      })
    },
    SLOW,
  )

  test(
    'the cursor goes to the last place the query occurs',
    async () => {
      rememberPrompts([{ display: 'echo hi && echo hi' }, { display: 'unrelated' }])
      await withPrompt({}, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'echo', 'echo hi && echo hi')
        expect(prompt.now().cursor).toBe(11)
      })
    },
    SLOW,
  )

  test(
    'matching is case-sensitive',
    async () => {
      rememberPrompts(BUILD_HISTORY)
      await withPrompt({}, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'Build', 'Run the Build twice')
        expect(prompt.now().cursor).toBe(8)
      })
    },
    SLOW,
  )

  test(
    'prompts typed in other projects are found too',
    async () => {
      rememberPrompts(BUILD_HISTORY)
      await withPrompt({}, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'deploy', 'deploy to staging')
      })
    },
    SLOW,
  )

  test(
    'a prompt is found by any of its lines, and the cursor counts across them',
    async () => {
      rememberPrompts([{ display: 'first line\nthen the second thing' }])
      await withPrompt({}, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'thing', 'first line\nthen the second thing')
        expect(prompt.now()).toMatchObject({ input: 'first line\nthen the second thing', cursor: 27 })
      })
    },
    SLOW,
  )

  test(
    "a bash-mode prompt ('!' first) switches the prompt to bash mode; the cursor counts from after the '!'",
    async () => {
      rememberPrompts(BUILD_HISTORY)
      await withPrompt({ input: 'draft' }, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'status', '!git status')
        expect(prompt.now()).toMatchObject({ input: '!git status', mode: 'bash', cursor: 4 })
      })
    },
    SLOW,
  )

  test(
    "a query that takes in the '!' puts the cursor where it sits in the stored prompt",
    async () => {
      rememberPrompts(BUILD_HISTORY)
      await withPrompt({}, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, '!git', '!git status')
        expect(prompt.now()).toMatchObject({ mode: 'bash', cursor: 0 })
      })
    },
    SLOW,
  )

  test(
    'the whole file is searched, however old the prompt',
    async () => {
      const hay = Array.from({ length: 149 }, (_, i) => ({ display: `hay bale ${i}` }))
      rememberPrompts([{ display: 'the needle' }, ...hay])
      await withPrompt({}, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'needle', 'the needle')
      })
    },
    SLOW,
  )

  test(
    'pastes come with the match: inline ones, and large ones from the paste store; one whose stored copy is gone is left out',
    async () => {
      storePaste('00aa11bb22cc33dd', 'large paste\nfrom the store')
      rememberPrompts([{ display: 'compare [Pasted text #1 +1 lines] [Pasted text #2 +1 lines] [Pasted text #3]', pastedContents: PASTES_ON_DISK }])
      await withPrompt({}, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'compare', 'compare [Pasted text #1 +1 lines] [Pasted text #2 +1 lines] [Pasted text #3]')
        expect(prompt.now().match?.pastedContents).toEqual(PASTES_RESOLVED as HistoryEntry['pastedContents'])
        expect(prompt.now().pasted).toEqual(PASTES_RESOLVED as HistoryEntry['pastedContents'])
      })
    },
    SLOW,
  )

  test(
    'lines that are not valid entries are skipped, and the good ones around them still match',
    async () => {
      const good = (display: string) => JSON.stringify({ display, pastedContents: {}, timestamp: Date.now() - HOUR, project: PROJECT })
      writeFileSync(join(configHome, 'history.jsonl'), [good('alpha one'), '{this is not json', '', good('alpha two'), ''].join('\n'))
      await withPrompt({}, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'alpha', 'alpha two')
        prompt.press(CTRL_R)
        await prompt.until(state => state.match?.display === 'alpha one', 'Ctrl+R to reach the older good line')
      })
    },
    SLOW,
  )

  test(
    'with no history file at all, every query fails',
    async () => {
      await withPrompt({ input: 'as typed' }, async prompt => {
        await startSearch(prompt)
        prompt.press('a')
        await prompt.until(state => state.failed, 'the search to fail')
        expect(prompt.now()).toMatchObject({ match: undefined, input: 'as typed' })
      })
    },
    SLOW,
  )

  test(
    'the prompts a real session wrote: found across projects, with a stored paste restored',
    async () => {
      useRecordedSession()
      const storedPaste = readFileSync(join(FIXTURE, 'paste-cache', '202210f25fae3b65.txt'), 'utf8')
      await withPrompt({}, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'deploy', 'what changed in the deploy script?')
        await clearQuery(prompt)
        await searchFor(prompt, 'review', 'review [Pasted text #1 +39 lines]')
        expect(prompt.now().pasted).toEqual({ 1: { id: 1, type: 'text', content: storedPaste } })
      })
    },
    SLOW,
  )
})

describe('useHistorySearch: moving through matches', () => {
  test(
    'Ctrl+R steps to older matches, each distinct prompt once, then reports that none is left and keeps the last one',
    async () => {
      rememberPrompts(BUILD_HISTORY)
      await withPrompt({}, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'build', 'npm run build -- --watch')
        prompt.press(CTRL_R)
        await prompt.until(state => state.match?.display === 'npm run build' && state.input === 'npm run build', 'the next older match')
        expect(prompt.now().cursor).toBe(8)
        prompt.press(CTRL_R)
        await prompt.until(state => state.failed, 'the search to run out')
        expect(prompt.now()).toMatchObject({ match: { display: 'npm run build' }, input: 'npm run build', searching: true })
        prompt.press(CTRL_R)
        await quietPeriod()
        expect(prompt.now()).toMatchObject({ failed: true, match: { display: 'npm run build' } })
      })
    },
    SLOW,
  )

  test(
    'each change to the query starts over from the newest prompt',
    async () => {
      rememberPrompts(BUILD_HISTORY)
      await withPrompt({}, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'npm', 'npm run build -- --watch')
        prompt.press(CTRL_R)
        await prompt.until(state => state.match?.display === 'npm run build', 'the next older match')
        await searchFor(prompt, ' run', 'npm run build -- --watch')
      })
    },
    SLOW,
  )

  test(
    'typing past the last match fails the search but leaves that match in the prompt',
    async () => {
      rememberPrompts(BUILD_HISTORY)
      await withPrompt({ input: 'draft' }, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'npm', 'npm run build -- --watch')
        prompt.press('x')
        await prompt.until(state => state.query === 'npmx' && state.failed, 'the longer query to fail')
        expect(prompt.now()).toMatchObject({ match: { display: 'npm run build -- --watch' }, input: 'npm run build -- --watch' })
      })
    },
    SLOW,
  )

  test(
    'a query nothing matches fails and leaves the prompt as it was',
    async () => {
      rememberPrompts(BUILD_HISTORY)
      await withPrompt({ input: 'draft', cursor: 1 }, async prompt => {
        await startSearch(prompt)
        pasteQuery(prompt, 'kubectl')
        await prompt.until(state => state.query === 'kubectl' && state.failed, 'the search to fail')
        expect(prompt.now()).toMatchObject({ match: undefined, input: 'draft', cursor: 1, mode: 'prompt' })
      })
    },
    SLOW,
  )

  test(
    'emptying the query puts back the prompt from before the search, and the search goes on',
    async () => {
      rememberPrompts(BUILD_HISTORY)
      const mine = { 1: { id: 1, type: 'text' as const, content: 'kept paste' } }
      await withPrompt({ input: 'half-typed', cursor: 4, mode: 'bash', pasted: mine }, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'log', 'git log --oneline')
        expect(prompt.now().mode).toBe('prompt')
        await clearQuery(prompt)
        await prompt.until(state => state.match === undefined && state.input === 'half-typed', 'the prompt to come back')
        expect(prompt.now()).toMatchObject({ input: 'half-typed', cursor: 4, mode: 'bash', pasted: mine, failed: false, searching: true })
      })
    },
    SLOW,
  )

  test(
    'typed one key at a time, each key searches again from the newest prompt',
    async () => {
      rememberPrompts([{ display: 'abc match' }, { display: 'ab only' }, { display: 'a single' }])
      await withPrompt({}, async prompt => {
        await startSearch(prompt)
        const steps: Array<[string, string]> = [
          ['a', 'a single'],
          ['b', 'ab only'],
          ['c', 'abc match'],
        ]
        for (const [key, display] of steps) {
          prompt.press(key)
          await prompt.until(state => state.match?.display === display && !state.failed, `"${key}" to move the match to "${display}"`)
        }
        expect(prompt.now()).toMatchObject({ query: 'abc', input: 'abc match', cursor: 0 })
      })
    },
    SLOW,
  )
})

describe('useHistorySearch: ending a search', () => {
  test(
    "Esc accepts the match: its text without the '!', its mode, the cursor where the search put it; the search ends",
    async () => {
      rememberPrompts(BUILD_HISTORY)
      await withPrompt({ input: 'draft' }, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'status', '!git status')
        prompt.press(ESC)
        await prompt.until(state => !state.searching, 'Esc to end the search')
        expect(prompt.now()).toMatchObject({ input: 'git status', mode: 'bash', cursor: 4, query: '', match: undefined, failed: false })
        expect(prompt.submitted).toEqual([])
      })
    },
    SLOW,
  )

  test(
    'Tab accepts the match the same way',
    async () => {
      rememberPrompts(BUILD_HISTORY)
      await withPrompt({ input: 'draft', mode: 'bash' }, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'log', 'git log --oneline')
        prompt.press(TAB)
        await prompt.until(state => !state.searching, 'Tab to end the search')
        expect(prompt.now()).toMatchObject({ input: 'git log --oneline', mode: 'prompt', cursor: 4, query: '' })
      })
    },
    SLOW,
  )

  test(
    'accepting after the search ran past its last match keeps that match',
    async () => {
      rememberPrompts(BUILD_HISTORY)
      await withPrompt({ input: 'draft' }, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'npm', 'npm run build -- --watch')
        prompt.press('x')
        await prompt.until(state => state.failed, 'the longer query to fail')
        prompt.press(ESC)
        await prompt.until(state => !state.searching, 'Esc to end the search')
        expect(prompt.now()).toMatchObject({ input: 'npm run build -- --watch', failed: false, match: undefined })
      })
    },
    SLOW,
  )

  test(
    'accepting when nothing matched leaves the prompt and its pastes as they were',
    async () => {
      rememberPrompts(BUILD_HISTORY)
      const mine = { 7: { id: 7, type: 'text' as const, content: 'still mine' } }
      await withPrompt({ input: 'draft', cursor: 3, pasted: mine }, async prompt => {
        await startSearch(prompt)
        pasteQuery(prompt, 'kubectl')
        await prompt.until(state => state.query === 'kubectl' && state.failed, 'the search to fail')
        prompt.press(ESC)
        await prompt.until(state => !state.searching, 'Esc to end the search')
        expect(prompt.now()).toMatchObject({ input: 'draft', cursor: 3, pasted: mine, query: '' })
      })
    },
    SLOW,
  )

  test(
    'Ctrl+C gives back the prompt as it was before the search, pastes included',
    async () => {
      storePaste('00aa11bb22cc33dd', 'large paste\nfrom the store')
      rememberPrompts([...BUILD_HISTORY, { display: 'with pastes [Pasted text #1]', pastedContents: PASTES_ON_DISK }])
      const mine = { 1: { id: 1, type: 'text' as const, content: 'mine' } }
      await withPrompt({ input: 'draft', cursor: 3, pasted: mine }, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'pastes', 'with pastes [Pasted text #1]')
        expect(prompt.now().pasted).toEqual(PASTES_RESOLVED as HistoryEntry['pastedContents'])
        prompt.press(CTRL_C)
        await prompt.until(state => !state.searching, 'Ctrl+C to end the search')
        expect(prompt.now()).toMatchObject({ input: 'draft', cursor: 3, pasted: mine, query: '', match: undefined, failed: false })
        expect(prompt.submitted).toEqual([])
      })
    },
    SLOW,
  )

  test(
    'Backspace on an empty query cancels like Ctrl+C; on a non-empty one it only edits the query',
    async () => {
      rememberPrompts(BUILD_HISTORY)
      await withPrompt({ input: 'draft', cursor: 5 }, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'g', 'deploy to staging')
        await backspaceOnce(prompt)
        await prompt.until(state => state.input === 'draft', 'the prompt to come back')
        await quietPeriod()
        expect(prompt.now().searching).toBe(true)
        prompt.press(BACKSPACE)
        await prompt.until(state => !state.searching, 'Backspace to cancel the search')
        expect(prompt.now()).toMatchObject({ input: 'draft', cursor: 5, query: '' })
      })
    },
    SLOW,
  )

  test(
    "Enter submits the match in its mode, without the '!', with its pastes; the search ends",
    async () => {
      storePaste('00aa11bb22cc33dd', 'large paste\nfrom the store')
      rememberPrompts([...BUILD_HISTORY, { display: '!cat [Pasted text #1]', pastedContents: PASTES_ON_DISK }])
      await withPrompt({ input: 'draft' }, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'cat', '!cat [Pasted text #1]')
        prompt.press(ENTER)
        await prompt.until(state => !state.searching, 'Enter to end the search')
        expect(prompt.submitted).toEqual([{ display: 'cat [Pasted text #1]', pastedContents: PASTES_RESOLVED as HistoryEntry['pastedContents'] }])
        expect(prompt.now()).toMatchObject({ mode: 'bash', query: '', match: undefined })
      })
    },
    SLOW,
  )

  test(
    'Enter with an empty query submits the prompt as it was, in the mode it was in',
    async () => {
      rememberPrompts(BUILD_HISTORY)
      const mine = { 2: { id: 2, type: 'text' as const, content: 'attached' } }
      await withPrompt({ input: 'ls -la', mode: 'bash', pasted: mine }, async prompt => {
        await startSearch(prompt)
        prompt.press(ENTER)
        await prompt.until(state => !state.searching, 'Enter to end the search')
        expect(prompt.submitted).toEqual([{ display: 'ls -la', pastedContents: mine }])
        expect(prompt.now().mode).toBe('bash')
      })
    },
    SLOW,
  )

  test(
    'Enter when the query matched nothing submits nothing, and still ends the search',
    async () => {
      rememberPrompts(BUILD_HISTORY)
      await withPrompt({ input: 'draft' }, async prompt => {
        await startSearch(prompt)
        pasteQuery(prompt, 'kubectl')
        await prompt.until(state => state.query === 'kubectl' && state.failed, 'the search to fail')
        prompt.press(ENTER)
        await prompt.until(state => !state.searching, 'Enter to end the search')
        await quietPeriod()
        expect(prompt.submitted).toEqual([])
        expect(prompt.now().input).toBe('draft')
      })
    },
    SLOW,
  )

  test(
    'a new search after one ended starts from the newest prompt again, with the prompt as it now is',
    async () => {
      rememberPrompts(BUILD_HISTORY)
      await withPrompt({ input: 'draft' }, async prompt => {
        await startSearch(prompt)
        await searchFor(prompt, 'build', 'npm run build -- --watch')
        prompt.press(CTRL_R)
        await prompt.until(state => state.match?.display === 'npm run build', 'the next older match')
        prompt.press(ESC)
        await prompt.until(state => !state.searching && state.input === 'npm run build', 'Esc to accept')
        await startSearch(prompt)
        await searchFor(prompt, 'build', 'npm run build -- --watch')
        await clearQuery(prompt)
        await prompt.until(state => state.input === 'npm run build' && state.match === undefined, 'the accepted prompt to come back')
      })
    },
    SLOW,
  )
})

describe('useHistorySearch: the handleKeyDown it returns', () => {
  test(
    'cancels and consumes a Backspace only while searching with an empty query',
    async () => {
      rememberPrompts(BUILD_HISTORY)
      await withPrompt({ input: 'draft', cursor: 2 }, async prompt => {
        const idle = keyDown('backspace', BACKSPACE)
        prompt.now().handleKeyDown(idle)
        expect(idle.defaultPrevented).toBe(false)
        expect(prompt.now().searching).toBe(false)

        await startSearch(prompt)
        await searchFor(prompt, 'g', 'deploy to staging')
        const editing = keyDown('backspace', BACKSPACE)
        prompt.now().handleKeyDown(editing)
        expect(editing.defaultPrevented).toBe(false)
        expect(prompt.now().searching).toBe(true)

        await backspaceOnce(prompt)
        const letter = keyDown('x', 'x')
        prompt.now().handleKeyDown(letter)
        expect(letter.defaultPrevented).toBe(false)
        expect(prompt.now().searching).toBe(true)

        const cancel = keyDown('backspace', BACKSPACE)
        prompt.now().handleKeyDown(cancel)
        expect(cancel.defaultPrevented).toBe(true)
        await prompt.until(state => !state.searching, 'the search to end')
        expect(prompt.now()).toMatchObject({ input: 'draft', cursor: 2 })
      })
    },
    SLOW,
  )
})

// =====================================================================================
// HistorySearchDialog: the picker
// =====================================================================================

/** The picker as a user reads it off the screen. */
type PickerView = {
  title: boolean
  /** Top to bottom: the age column (padded to 8), one space, then the prompt's first line. */
  rows: string[]
  /** The mark left of each row: ❯ on the focused one, ↑ or ↓ where more rows are hidden. */
  marks: string[]
  focused: string | undefined
  preview: string[]
  /** What the query box holds; the placeholder when it is empty. */
  box: string
  notice: string | undefined
  hint: string
  /** The preview sits beside the list rather than under it. */
  previewBeside: boolean
}

const ROW_RE = /^ {2}([❯↑↓ ]) ((?:\d+(?:s|mo|m|h|d|w|y) ago|in \d+(?:s|mo|m|h|d|w|y)) *) (.*)$/
const NOTICES = new Set(['Loading…', 'No history yet', 'No matching prompts'])

function readPicker(frame: string): PickerView {
  const lines = frame.split('\n')
  const boxLine = lines.findIndex(line => line.includes('⌕'))
  const aboveBox = boxLine === -1 ? lines : lines.slice(0, boxLine - 1)
  const rows: string[] = []
  const marks: string[] = []
  let previewBeside = false
  for (const line of aboveBox) {
    const row = ROW_RE.exec(line)
    if (!row) continue
    const [, mark = '', age = '', rest = ''] = row
    const text = rest.replace(/ {2,}[│╭╰].*$/, '').trimEnd()
    if (text !== rest.trimEnd()) previewBeside = true
    rows.push(`${age} ${text}`)
    marks.push(mark)
  }
  const preview = aboveBox
    .filter(line => line.includes('│'))
    .map(line => line.slice(line.indexOf('│') + 1, line.lastIndexOf('│')).trim())
    .filter(text => text !== '')
  const boxText = boxLine === -1 ? '' : (/⌕ (.*?)\s*│\s*$/.exec(lines[boxLine] ?? '')?.[1] ?? '')
  const trimmed = lines.map(line => line.trim())
  return {
    title: trimmed.includes('Search prompts'),
    rows,
    marks,
    focused: rows[marks.indexOf('❯')],
    preview,
    box: boxText,
    notice: trimmed.find(line => NOTICES.has(line)),
    hint: trimmed.filter(line => line !== '').at(-1) ?? '',
    previewBeside,
  }
}

/** A row as the dialog prints it. */
const row = (age: string, text: string) => `${age.padEnd(8)} ${text}`
/** Only the prompt part of each row. */
const texts = (view: PickerView) => view.rows.map(line => line.slice(9))

type DialogSession = {
  view: () => PickerView
  picked: HistoryEntry[]
  cancels: () => number
  modal: () => boolean | undefined
  transcript: () => string
  press: (keys: string) => void
  until: (check: (view: PickerView) => boolean, what: string) => Promise<void>
  /** Takes the dialog out of the tree, the way the prompt hides it. */
  dismount: () => void
  close: () => void
}

type Watch = { modal?: boolean }

function OverlayWatch({ watch }: { watch: Watch }): React.ReactNode {
  watch.modal = useIsModalOverlayActive()
  return null
}

async function openDialog(options: { columns?: number; initialQuery?: string } = {}): Promise<DialogSession> {
  const picked: HistoryEntry[] = []
  let cancels = 0
  let mounted = false
  const watch: Watch = {}
  const markMounted = () => {
    mounted = true
  }
  const tree = (withDialog: boolean) => (
    <>
      {withDialog && (
        <HistorySearchDialog
          initialQuery={options.initialQuery}
          onSelect={entry => {
            picked.push(entry)
          }}
          onCancel={() => {
            cancels++
          }}
        />
      )}
      <AfterMount onMounted={markMounted} />
      <OverlayWatch watch={watch} />
    </>
  )
  const ink = await mountInTerminal(tree(true), options.columns ?? 120)
  const view = () => readPicker(ink.terminal.screen())
  const describeScreen = () => `Screen:\n${ink.terminal.screen()}`
  // Right after the history arrives there is one frame in which no row has the
  // focus yet; a list is settled once one does.
  const settled = () => {
    const shown = view()
    return shown.title && shown.notice !== 'Loading…' && (shown.rows.length === 0 || shown.focused !== undefined)
  }
  await waitUntil(() => mounted && settled(), 'the dialog to load the history', describeScreen)
  return {
    view,
    picked,
    cancels: () => cancels,
    modal: () => watch.modal,
    transcript: () => stripAnsi(ink.terminal.transcript()),
    press: keys => ink.terminal.type(keys),
    until: (check, what) => waitUntil(() => check(view()), what, describeScreen),
    dismount: () => ink.render(tree(false)),
    close: ink.close,
  }
}

async function withDialog(
  options: { columns?: number; initialQuery?: string },
  check: (dialog: DialogSession) => Promise<void>,
): Promise<void> {
  const dialog = await openDialog(options)
  try {
    await check(dialog)
  } finally {
    dialog.close()
  }
}

describe('HistorySearchDialog: what it lists', () => {
  test(
    "it says Loading… until the history is read, then lists this project's prompts, newest at the bottom by the query box",
    async () => {
      rememberPrompts([
        { display: 'first prompt', ago: 3.5 * DAY },
        { display: 'second prompt', ago: 2.5 * HOUR },
        { display: 'from another project', project: OTHER_PROJECT, ago: 20 * MINUTE },
        { display: 'third prompt', ago: 5.5 * MINUTE },
      ])
      await withDialog({}, async dialog => {
        const view = dialog.view()
        expect(dialog.transcript()).toContain('Loading…')
        expect(view.notice).toBeUndefined()
        expect(view.rows).toEqual([row('3d ago', 'first prompt'), row('2h ago', 'second prompt'), row('5m ago', 'third prompt')])
        expect(view.focused).toBe(row('5m ago', 'third prompt'))
        expect(view.box).toBe('Filter history…')
        expect(view.hint).toBe('↑/↓ to navigate · Enter to use · Esc to cancel')
      })
    },
    SLOW,
  )

  test(
    'ages are relative, in short units, padded to eight columns',
    async () => {
      rememberPrompts([
        { display: 'a year', ago: 400 * DAY },
        { display: 'eleven months', ago: 330.5 * DAY },
        { display: 'a month', ago: 45 * DAY },
        { display: 'two weeks', ago: 17.5 * DAY },
        { display: 'three days', ago: 3.5 * DAY },
        { display: 'two hours', ago: 2.5 * HOUR },
        { display: 'five minutes', ago: 5.5 * MINUTE },
      ])
      await withDialog({}, async dialog => {
        expect(dialog.view().rows).toEqual([
          '1y ago   a year',
          '11mo ago eleven months',
          '1mo ago  a month',
          '2w ago   two weeks',
          '3d ago   three days',
          '2h ago   two hours',
          '5m ago   five minutes',
        ])
      })
    },
    SLOW,
  )

  test(
    'each distinct prompt is listed once, where and when it was last typed',
    async () => {
      rememberPrompts([
        { display: 'lint the code', ago: 3.5 * DAY },
        { display: 'lint the code', project: OTHER_PROJECT, ago: 2 * DAY },
        { display: 'format files', ago: 2.5 * HOUR },
        { display: 'lint the code', ago: 5.5 * MINUTE },
      ])
      await withDialog({}, async dialog => {
        expect(dialog.view().rows).toEqual([row('2h ago', 'format files'), row('5m ago', 'lint the code')])
      })
    },
    SLOW,
  )

  test(
    'the order is the order prompts were written in, not their timestamps',
    async () => {
      rememberPrompts([
        { display: 'written first', ago: 5.5 * MINUTE },
        { display: 'written second', ago: 2.5 * HOUR },
      ])
      await withDialog({}, async dialog => {
        expect(dialog.view().rows).toEqual([row('5m ago', 'written first'), row('2h ago', 'written second')])
        expect(dialog.view().focused).toBe(row('2h ago', 'written second'))
      })
    },
    SLOW,
  )

  test(
    'two different prompts written in the same millisecond are both listed',
    async () => {
      const at = Date.now() - 5.5 * MINUTE
      rememberPrompts([{ display: 'twin one', at }, { display: 'twin two', at }])
      await withDialog({}, async dialog => {
        expect(texts(dialog.view())).toEqual(['twin one', 'twin two'])
      })
    },
    SLOW,
  )

  test(
    'lines that are not entries are skipped: bad JSON, JSON that is not an object, entries without a project',
    async () => {
      const entry = (display: string, extra: object = { project: PROJECT }) =>
        JSON.stringify({ display, pastedContents: {}, timestamp: Date.now() - HOUR, ...extra })
      const lines = [entry('kept older'), '{"display": broken', 'null', '42', entry('no project', {}), '', entry('kept newer')]
      writeFileSync(join(configHome, 'history.jsonl'), `${lines.join('\n')}\n`)
      await withDialog({}, async dialog => {
        expect(texts(dialog.view())).toEqual(['kept older', 'kept newer'])
      })
    },
    SLOW,
  )

  test(
    "it offers at most the hundred newest distinct prompts of this project",
    async () => {
      const vintage = Array.from({ length: 5 }, (_, i) => ({ display: `vintage ${i}` }))
      const fresh = Array.from({ length: 100 }, (_, i) => ({ display: `fresh ${i}` }))
      rememberPrompts([...vintage, ...fresh])
      await withDialog({}, async dialog => {
        dialog.press('vintage')
        await dialog.until(view => view.notice === 'No matching prompts', 'the old prompts to be out of reach')
      })
    },
    SLOW,
  )

  test(
    "the hundred counts distinct prompts of this project only: repeats and other projects' prompts do not use it up",
    async () => {
      const vintage = Array.from({ length: 3 }, (_, i) => ({ display: `vintage ${i}` }))
      const elsewhere = Array.from({ length: 60 }, (_, i) => ({ display: `noise ${i}`, project: OTHER_PROJECT }))
      const fresh = Array.from({ length: 97 }, (_, i) => ({ display: `fresh ${i}` }))
      const repeats = Array.from({ length: 30 }, () => ({ display: 'fresh 5' }))
      rememberPrompts([...vintage, ...elsewhere, ...fresh, ...repeats])
      await withDialog({}, async dialog => {
        dialog.press('vintage')
        await dialog.until(view => view.rows.length === 3, 'the three old prompts')
        expect(texts(dialog.view())).toEqual(['vintage 0', 'vintage 1', 'vintage 2'])
      })
    },
    SLOW,
  )

  test(
    'with no history file, or none from this project, it says so',
    async () => {
      await withDialog({}, async dialog => {
        expect(dialog.view()).toMatchObject({ notice: 'No history yet', rows: [], preview: [] })
      })
      rememberPrompts([{ display: 'not here', project: OTHER_PROJECT }])
      await withDialog({}, async dialog => {
        expect(dialog.view()).toMatchObject({ notice: 'No history yet', rows: [] })
      })
    },
    SLOW,
  )

  test(
    'the prompts a real session wrote',
    async () => {
      useRecordedSession()
      await withDialog({}, async dialog => {
        expect(texts(dialog.view())).toEqual([
          '!git status --short',
          'summarize [Pasted text #1 +2 lines]',
          'review [Pasted text #1 +39 lines]',
          'describe [Image #1]',
          'explain the retry logic in src/net/client.ts',
          'write a test for',
        ])
      })
    },
    SLOW,
  )

  test(
    'history read after it opened does not show until it is opened again',
    async () => {
      rememberPrompts([{ display: 'already there' }])
      await withDialog({}, async dialog => {
        const late = { display: 'brand new prompt', pastedContents: {}, timestamp: Date.now(), project: PROJECT }
        appendFileSync(join(configHome, 'history.jsonl'), `${JSON.stringify(late)}\n`)
        dialog.press('brand')
        await dialog.until(view => view.notice === 'No matching prompts', 'the late prompt to stay unlisted')
      })
      await withDialog({ initialQuery: 'brand' }, async dialog => {
        expect(texts(dialog.view())).toEqual(['brand new prompt'])
      })
    },
    SLOW,
  )
})

describe('HistorySearchDialog: rows and preview', () => {
  test(
    "a row shows the prompt's first line, cut with … to fit; the preview shows every line",
    async () => {
      rememberPrompts([{ display: 'x'.repeat(60) }, { display: 'summary line\n\nmore detail' }])
      await withDialog({ columns: 120 }, async dialog => {
        const view = dialog.view()
        expect(texts(view)).toEqual([`${'x'.repeat(47)}…`, 'summary line'])
        expect(view.preview).toEqual(['summary line', 'more detail'])
        expect(view.previewBeside).toBe(true)
      })
    },
    SLOW,
  )

  test(
    'from 100 columns the preview sits beside the list, which takes half the width; below that it goes underneath',
    async () => {
      rememberPrompts([{ display: 'w'.repeat(100) }])
      await withDialog({ columns: 100 }, async dialog => {
        expect(texts(dialog.view())).toEqual([`${'w'.repeat(37)}…`])
        expect(dialog.view().previewBeside).toBe(true)
      })
      await withDialog({ columns: 99 }, async dialog => {
        expect(texts(dialog.view())).toEqual([`${'w'.repeat(83)}…`])
        expect(dialog.view().previewBeside).toBe(false)
        expect(dialog.view().hint).toBe('↑/↓ to nav · Enter to use · Esc to cancel')
      })
    },
    SLOW,
  )

  test(
    'the preview wraps long lines hard to its width',
    async () => {
      rememberPrompts([{ display: 'z'.repeat(120) }])
      await withDialog({ columns: 120 }, async dialog => {
        expect(dialog.view().preview).toEqual(['z'.repeat(51), 'z'.repeat(51), 'z'.repeat(18)])
      })
      await withDialog({ columns: 80 }, async dialog => {
        expect(dialog.view().preview).toEqual(['z'.repeat(70), 'z'.repeat(50)])
      })
    },
    SLOW,
  )

  test(
    'the preview drops blank lines and shows at most six rows, counting the rest',
    async () => {
      const eight = ['l1', '', 'l2', '   ', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8'].join('\n')
      const six = ['s1', 's2', 's3', 's4', 's5', 's6'].join('\n')
      rememberPrompts([{ display: six }, { display: eight }])
      await withDialog({}, async dialog => {
        expect(dialog.view().preview).toEqual(['l1', 'l2', 'l3', 'l4', 'l5', '… +3 more lines'])
        dialog.press(UP)
        await dialog.until(view => view.focused?.endsWith('s1') === true, 'the six-line prompt to take the focus')
        expect(dialog.view().preview).toEqual(['s1', 's2', 's3', 's4', 's5', 's6'])
      })
    },
    SLOW,
  )

  test(
    'a long history shows eight rows at a time, marking the edge where more are hidden, and scrolls with the focus',
    async () => {
      rememberPrompts(Array.from({ length: 12 }, (_, i) => ({ display: `entry ${String(i).padStart(2, '0')}` })))
      await withDialog({ columns: 80 }, async dialog => {
        const first = dialog.view()
        expect(texts(first)).toEqual(['entry 04', 'entry 05', 'entry 06', 'entry 07', 'entry 08', 'entry 09', 'entry 10', 'entry 11'])
        expect(first.marks[0]).toBe('↑')
        expect(first.marks.at(-1)).toBe('❯')
        dialog.press(UP.repeat(9))
        await dialog.until(view => view.focused?.endsWith('entry 02') === true, 'the focus to reach entry 02')
        const scrolled = dialog.view()
        expect(texts(scrolled)).toEqual(['entry 02', 'entry 03', 'entry 04', 'entry 05', 'entry 06', 'entry 07', 'entry 08', 'entry 09'])
        expect(scrolled.marks[0]).toBe('❯')
        expect(scrolled.marks.at(-1)).toBe('↓')
      })
    },
    SLOW,
  )
})

describe('HistorySearchDialog: the query', () => {
  const GIT_HISTORY: Remembered[] = [
    { display: 'git commit -m wip' },
    { display: 'grep todo' },
    { display: 'go into tmp' },
    { display: 'print git log' },
    { display: 'GIT push' },
  ]

  test(
    'matching ignores case; prompts containing the query come first, then prompts holding its letters in order, each group newest first',
    async () => {
      rememberPrompts(GIT_HISTORY)
      await withDialog({}, async dialog => {
        dialog.press('git')
        await dialog.until(view => view.box === 'git' && view.rows.length === 4, 'the list to narrow')
        expect(texts(dialog.view())).toEqual(['go into tmp', 'git commit -m wip', 'print git log', 'GIT push'])
        expect(dialog.view().focused?.endsWith('GIT push')).toBe(true)
      })
    },
    SLOW,
  )

  test(
    'spaces around the query are ignored',
    async () => {
      rememberPrompts(GIT_HISTORY)
      await withDialog({ initialQuery: '  GIT ' }, async dialog => {
        expect(texts(dialog.view())).toEqual(['go into tmp', 'git commit -m wip', 'print git log', 'GIT push'])
      })
    },
    SLOW,
  )

  test(
    'a prompt is found by any of its lines, not only the first one shown',
    async () => {
      rememberPrompts([{ display: 'refactor\nthe tokenizer module' }, { display: 'something else' }])
      await withDialog({}, async dialog => {
        dialog.press('tokenizer')
        await dialog.until(view => view.rows.length === 1, 'one row')
        expect(texts(dialog.view())).toEqual(['refactor'])
        expect(dialog.view().preview).toEqual(['refactor', 'the tokenizer module'])
      })
    },
    SLOW,
  )

  test(
    'a query nothing matches empties the list and says so',
    async () => {
      rememberPrompts(GIT_HISTORY)
      await withDialog({}, async dialog => {
        dialog.press('kubectl')
        await dialog.until(view => view.notice === 'No matching prompts', 'the no-match notice')
        expect(dialog.view()).toMatchObject({ rows: [], preview: [], box: 'kubectl' })
      })
    },
    SLOW,
  )

  test(
    'typing narrows the list and puts the focus back on the newest match; Backspace widens it again',
    async () => {
      rememberPrompts([{ display: 'alpha' }, { display: 'beta' }, { display: 'alphabet soup' }])
      await withDialog({}, async dialog => {
        dialog.press(UP)
        await dialog.until(view => view.focused?.endsWith(' beta') === true, 'the focus to move up')
        dialog.press('alp')
        await dialog.until(view => view.rows.length === 2, 'the list to narrow')
        expect(dialog.view().focused?.endsWith('alphabet soup')).toBe(true)
        dialog.press(UP)
        await dialog.until(view => view.focused?.endsWith(' alpha') === true, 'the focus to move up')
        // One at a time: the query box edits from what it last rendered.
        for (const left of ['al', 'a', 'Filter history…']) {
          dialog.press(BACKSPACE)
          await dialog.until(view => view.box === left, `the query to become "${left}"`)
        }
        await dialog.until(view => view.rows.length === 3, 'the list to widen')
        expect(dialog.view().focused?.endsWith('alphabet soup')).toBe(true)
      })
    },
    SLOW,
  )

  test(
    'initialQuery fills the query box and filters from the start; typing carries on after it',
    async () => {
      rememberPrompts([{ display: 'deploy staging' }, { display: 'build' }, { display: 'deploy prod' }])
      await withDialog({ initialQuery: 'DEP' }, async dialog => {
        expect(dialog.view().box).toBe('DEP')
        expect(texts(dialog.view())).toEqual(['deploy staging', 'deploy prod'])
        dialog.press('loy s')
        await dialog.until(view => view.box === 'DEPloy s', 'the typed text to follow the initial query')
        expect(texts(dialog.view())).toEqual(['deploy staging'])
      })
    },
    SLOW,
  )
})

describe('HistorySearchDialog: keys', () => {
  test(
    '↑ and Ctrl+P move to older prompts, ↓ and Ctrl+N to newer ones, stopping at both ends; the preview follows',
    async () => {
      rememberPrompts([{ display: 'one' }, { display: 'two' }, { display: 'three' }])
      await withDialog({}, async dialog => {
        const focusedText = () => dialog.view().focused?.slice(9)
        const step = async (key: string, expected: string) => {
          dialog.press(key)
          await dialog.until(view => view.focused?.slice(9) === expected, `the focus to be on "${expected}"`)
          expect(dialog.view().preview).toEqual([expected])
        }
        expect(focusedText()).toBe('three')
        await step(UP, 'two')
        await step(CTRL_P, 'one')
        dialog.press(UP)
        await quietPeriod()
        expect(focusedText()).toBe('one')
        await step(DOWN, 'two')
        await step(CTRL_N, 'three')
        dialog.press(DOWN)
        await quietPeriod()
        expect(focusedText()).toBe('three')
      })
    },
    SLOW,
  )

  test(
    'Enter, Tab and Shift+Tab hand the focused prompt, as stored, to onSelect; the dialog stays up for the caller to close',
    async () => {
      rememberPrompts([{ display: 'plain prompt' }, { display: '!ls -la' }])
      await withDialog({}, async dialog => {
        dialog.press(ENTER)
        await dialog.until(() => dialog.picked.length === 1, 'Enter to pick')
        dialog.press(UP)
        await dialog.until(view => view.focused?.endsWith('plain prompt') === true, 'the focus to move up')
        dialog.press(TAB)
        await dialog.until(() => dialog.picked.length === 2, 'Tab to pick')
        dialog.press(SHIFT_TAB)
        await dialog.until(() => dialog.picked.length === 3, 'Shift+Tab to pick')
        expect(dialog.picked).toEqual([
          { display: '!ls -la', pastedContents: {} },
          { display: 'plain prompt', pastedContents: {} },
          { display: 'plain prompt', pastedContents: {} },
        ])
        expect(dialog.cancels()).toBe(0)
        expect(dialog.view().title).toBe(true)
      })
    },
    SLOW,
  )

  test(
    'the picked prompt carries its pastes: inline ones, and large ones from the paste store; one whose stored copy is gone is left out',
    async () => {
      storePaste('00aa11bb22cc33dd', 'large paste\nfrom the store')
      rememberPrompts([{ display: 'compare the pastes', pastedContents: PASTES_ON_DISK }])
      await withDialog({}, async dialog => {
        dialog.press(ENTER)
        await dialog.until(() => dialog.picked.length === 1, 'Enter to pick')
        expect(dialog.picked[0]).toEqual({ display: 'compare the pastes', pastedContents: PASTES_RESOLVED as HistoryEntry['pastedContents'] })
      })
    },
    SLOW,
  )

  test(
    'picking from the history a real session wrote: pastes come back from the store, images were never kept',
    async () => {
      useRecordedSession()
      const storedPaste = readFileSync(join(FIXTURE, 'paste-cache', '202210f25fae3b65.txt'), 'utf8')
      await withDialog({}, async dialog => {
        const pick = async (steps: number, shown: string) => {
          dialog.press(UP.repeat(steps))
          await dialog.until(view => view.focused?.endsWith(shown) === true, `the focus to reach "${shown}"`)
          const before = dialog.picked.length
          dialog.press(ENTER)
          await dialog.until(() => dialog.picked.length === before + 1, `Enter to pick "${shown}"`)
        }
        await pick(2, 'describe [Image #1]')
        await pick(1, 'review [Pasted text #1 +39 lines]')
        await pick(1, 'summarize [Pasted text #1 +2 lines]')
        expect(dialog.picked).toEqual([
          { display: 'describe [Image #1]', pastedContents: {} },
          { display: 'review [Pasted text #1 +39 lines]', pastedContents: { 1: { id: 1, type: 'text', content: storedPaste } } },
          { display: 'summarize [Pasted text #1 +2 lines]', pastedContents: { 1: { id: 1, type: 'text', content: 'alpha\nbeta\ngamma' } } },
        ])
      })
    },
    SLOW,
  )

  test(
    'with nothing listed, Enter and Tab do nothing',
    async () => {
      await withDialog({}, async dialog => {
        dialog.press(ENTER)
        dialog.press(TAB)
        await quietPeriod()
        expect(dialog.picked).toEqual([])
        expect(dialog.cancels()).toBe(0)
      })
    },
    SLOW,
  )

  test(
    'Esc, Ctrl+C, Ctrl+G, and Ctrl+D on an empty query each cancel once; Backspace on an empty query does not',
    async () => {
      rememberPrompts([{ display: 'something' }])
      await withDialog({}, async dialog => {
        dialog.press(BACKSPACE)
        await quietPeriod()
        expect(dialog.cancels()).toBe(0)
        let expected = 0
        for (const key of [ESC, CTRL_C, CTRL_G, CTRL_D]) {
          dialog.press(key)
          expected++
          await dialog.until(() => dialog.cancels() === expected, `${JSON.stringify(key)} to cancel`)
        }
        await quietPeriod()
        expect(dialog.cancels()).toBe(4)
        expect(dialog.picked).toEqual([])
        expect(dialog.view().title).toBe(true)
      })
    },
    SLOW,
  )

  test(
    'Ctrl+D with text in the query does not cancel',
    async () => {
      rememberPrompts([{ display: 'something' }])
      await withDialog({}, async dialog => {
        dialog.press('so')
        await dialog.until(view => view.box === 'so', 'the query to show')
        dialog.press(CTRL_D)
        await quietPeriod()
        expect(dialog.cancels()).toBe(0)
        expect(dialog.view().box).toBe('so')
      })
    },
    SLOW,
  )
})

describe('HistorySearchDialog: as an overlay', () => {
  test(
    'while it is up a modal overlay is active, and it stops being when the dialog goes',
    async () => {
      rememberPrompts([{ display: 'something' }])
      await withDialog({}, async dialog => {
        expect(dialog.modal()).toBe(true)
        dialog.dismount()
        await waitUntil(() => dialog.modal() === false, 'the overlay to clear', () => `modal: ${dialog.modal()}`)
      })
    },
    SLOW,
  )
})
