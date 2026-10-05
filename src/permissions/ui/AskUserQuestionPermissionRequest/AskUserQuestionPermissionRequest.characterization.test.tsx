/**
 * Characterization of the AskUserQuestion dialog, written before the
 * clean-base rewrite of permissions/askUserQuestion. The spec is
 * docs/tech/rewrite/permissions/askUserQuestion.md.
 *
 * The dialog is reached the way the REPL reaches it: the request goes to
 * `PermissionRequest`, which routes AskUserQuestionTool here. Every callback
 * the dialog makes is written to one ordered log, so each test states what an
 * answer reported to the caller and to the request, in order, and nothing else.
 * What the model reads is the first argument of the request's allow (the tool
 * input with the user's answers) or the text of its reject.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as React from 'react'
import { PermissionRequest } from 'src/permissions/ui/PermissionRequest.js'
import { isolatedWorld, KEYS, mount, type Screen, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { callerProps, type Ledger, ONE_PIXEL_PNG, pasted, planRequest, pngOnDisk } from 'src/permissions/ui/__testutils__/modeDialogsRig.js'
import { shown } from 'src/permissions/ui/__testutils__/toolDialogRig.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { getExternalEditor } from 'src/shared/editor.js'
import { getCliHighlightPromise } from 'src/shared/text/cliHighlight.js'
import { TerminalSizeContext } from 'src/terminal/ink/components/TerminalSizeContext.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import { AskUserQuestionTool } from 'src/tools/AskUserQuestionTool/AskUserQuestionTool.js'
import type { Tool } from 'src/tools/Tool.js'

const world = isolatedWorld()
const { enter, esc, down, up, tab, ctrlC } = KEYS
const right = '\x1B[C'
const left = '\x1B[D'
const shiftTab = '\x1B[Z'
const space = ' '
const backspace = '\x7f'
const typed = (text: string) => [...text]

// --- requests ------------------------------------------------------------------

type Choice = { label: string; preview?: string }
type Asked = { question: string; header: string; multiSelect?: boolean; choices: (string | Choice)[] }

/** A question as the model sends it; every option gets a description. */
function question({ question, header, multiSelect = false, choices }: Asked) {
  return {
    question,
    header,
    multiSelect,
    options: choices.map(choice => {
      const { label, preview } = typeof choice === 'string' ? { label: choice, preview: undefined } : choice
      return { label, description: `means ${label}`, ...(preview === undefined ? {} : { preview }) }
    }),
  }
}

const DB = question({ question: 'Which database?', header: 'DB', choices: ['Postgres', 'SQLite'] })
const CACHE = question({ question: 'Which cache?', header: 'Cache', choices: ['Redis', 'None'] })
const LANGS = question({ question: 'Which languages?', header: 'Langs', multiSelect: true, choices: ['TS', 'Go', 'Rust'] })

// --- the log -------------------------------------------------------------------

/** What the dialog told its two parties, in order. `allow` and `reject` are the request's. */
type Logged = ['allow', ...unknown[]] | ['reject', ...unknown[]] | 'caller.done' | 'caller.reject'

type Opened = { screen: Screen; log: Logged[]; input: Record<string, unknown> }

type OpenOptions = { mode?: 'plan' | 'default'; rows?: number; columns?: number }

/**
 * Mounts `PermissionRequest` for an AskUserQuestion request. The request
 * skeleton is the mode-dialog rig's; its two answer callbacks are replaced so
 * that every argument, the image blocks included, lands in the log.
 */
async function open(input: Record<string, unknown>, options: OpenOptions = {}): Promise<Opened> {
  const log: Logged[] = []
  const unused: Ledger = []
  const confirm = {
    ...planRequest(unused, { tool: AskUserQuestionTool as unknown as Tool, input }),
    onAllow: (...args: unknown[]) => log.push(['allow', ...args]),
    onReject: (...args: unknown[]) => log.push(['reject', ...args]),
  }
  const props = {
    ...callerProps(unused, confirm as never),
    onDone: () => log.push('caller.done'),
    onReject: () => log.push('caller.reject'),
  }
  const columns = options.columns ?? 100
  let node: React.ReactNode = <PermissionRequest {...props} />
  if (options.rows !== undefined) node = <TerminalSizeContext.Provider value={{ columns, rows: options.rows }}>{node}</TerminalSizeContext.Provider>
  const appState = options.mode === 'plan' ? ({ toolPermissionContext: { mode: 'plan' } } as unknown as Partial<AppState>) : undefined
  const screen = await mount(node, { columns, appState })
  // The highlighter swaps the dialog in once it has loaded; keys sent before that are lost.
  await Bun.sleep(250)
  return { screen, log, input }
}

/** Opens the dialog, presses the keys, and gives the last answer time to land. */
async function answer(input: Record<string, unknown>, keys: string[], options: OpenOptions = {}): Promise<Opened> {
  const opened = await open(input, options)
  await opened.screen.press(...keys)
  await Bun.sleep(150)
  return opened
}

/** The tool input the model gets back on an allow, with the user's answers. */
const answered = (input: Record<string, unknown>, answers: Record<string, string>, annotations?: Record<string, { preview?: string; notes?: string }>) => ({
  ...input,
  answers,
  ...(annotations ? { annotations } : {}),
})

/** An allow as the dialog reports it: the caller hears first, then the request. */
const allowedWith = (updatedInput: unknown, blocks?: unknown): Logged[] => ['caller.done', ['allow', updatedInput, [], undefined, blocks]]

/** Every way out that is not an answer: the caller is told first, then the request with no arguments. */
const CANCELLED: Logged[] = ['caller.done', 'caller.reject', ['reject']]

const pngBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ONE_PIXEL_PNG } }

/** The text of the request's reject, which is what the model reads. */
function rejectText(log: Logged[]): string {
  const entry = log.find((item): item is ['reject', ...unknown[]] => Array.isArray(item) && item[0] === 'reject')
  if (!entry || typeof entry[1] !== 'string') throw new Error(`no reject with a message in ${JSON.stringify(log)}`)
  return entry[1]
}

/** The allow's tool input with the annotations left out, for findings that are not pinned. */
function answersOnly(log: Logged[]): Logged[] {
  return log.map(item => {
    if (!Array.isArray(item) || item[0] !== 'allow') return item
    const { annotations: _dropped, ...rest } = item[1] as Record<string, unknown>
    return ['allow', rest, ...item.slice(2)] as Logged
  })
}

beforeAll(async () => {
  // A fixed editor, so the hint the "Other" field shows does not depend on the machine.
  process.env.VISUAL = 'vi'
  getExternalEditor.cache.clear?.()
  await getCliHighlightPromise()
})
afterAll(() => {
  delete process.env.VISUAL
  getExternalEditor.cache.clear?.()
})

// --- what is shown ---------------------------------------------------------------

describe('AskUserQuestion: what it shows', () => {
  test(
    'one single-choice question: one tab and no arrows or Submit tab, the options, Other, and the chat line',
    async () => {
      const { screen } = await open({ questions: [DB] })
      expect(shown(screen.text())).toEqual([
        '☐ DB',
        'Which database?',
        '❯ 1. Postgres',
        'means Postgres',
        '2. SQLite',
        'means SQLite',
        '3. Type something.',
        '─'.repeat(100),
        '4. Chat about this',
        'Enter to select · ↑/↓ to navigate · Esc to cancel',
      ])
    },
    SLOW,
  )

  test(
    'several questions: arrows on both ends, one tab per header, and a Submit tab',
    async () => {
      const { screen } = await open({ questions: [DB, CACHE] })
      const lines = shown(screen.text())
      expect(lines[0]).toBe('←  ☐ DB  ☐ Cache  ✔ Submit  →')
      expect(lines[1]).toBe('Which database?')
      expect(lines.at(-1)).toBe('Enter to select · Tab/Arrow keys to navigate · Esc to cancel')
    },
    SLOW,
  )

  test(
    'one multi-choice question still gets the arrows and the Submit tab',
    async () => {
      const { screen } = await open({ questions: [LANGS] })
      expect(shown(screen.text())[0]).toBe('←  ☐ Langs  ✔ Submit  →')
    },
    SLOW,
  )

  test(
    'an answered question gets a ticked box in its tab',
    async () => {
      const { screen } = await answer({ questions: [DB, CACHE] }, [enter])
      expect(shown(screen.text())[0]).toBe('←  ☒ DB  ☐ Cache  ✔ Submit  →')
      expect(shown(screen.text())[1]).toBe('Which cache?')
    },
    SLOW,
  )
})

// --- one question, one choice --------------------------------------------------------

describe('AskUserQuestion: one single-choice question answers at once', () => {
  type Row = { name: string; keys: string[]; answer: string }
  const rows: Row[] = [
    { name: 'Enter on the first option', keys: [enter], answer: 'Postgres' },
    { name: 'the digit of the second option', keys: ['2'], answer: 'SQLite' },
    { name: 'Down, then Enter', keys: [down, enter], answer: 'SQLite' },
    { name: 'Down twice wraps no further than Other; Up back to an option', keys: [down, down, up, enter], answer: 'SQLite' },
  ]
  for (const row of rows) {
    test(
      `${row.name}: the answer is the option's label, and nothing else is added`,
      async () => {
        const { log, input } = await answer({ questions: [DB] }, row.keys)
        expect(log).toEqual(allowedWith(answered(input, { 'Which database?': row.answer })))
      },
      SLOW,
    )
  }

  test(
    'Other with text: the text, as typed, is the answer',
    async () => {
      const { log, input } = await answer({ questions: [DB] }, [down, down, ...typed('  MariaDB 11 '), enter])
      expect(answersOnly(log)).toEqual(allowedWith(answered(input, { 'Which database?': '  MariaDB 11 ' })))
    },
    SLOW,
  )

  test(
    'digits typed into Other are text, not option numbers',
    async () => {
      const { log, input } = await answer({ questions: [DB] }, [down, down, ...typed('12'), enter])
      expect(answersOnly(log)).toEqual(allowedWith(answered(input, { 'Which database?': '12' })))
    },
    SLOW,
  )

  test(
    'the digit of an empty Other only moves the pointer there',
    async () => {
      const { log, screen } = await answer({ questions: [DB] }, ['3'])
      expect(log).toEqual([])
      expect(shown(screen.text())).toContain('❯ 3. Type something.')
    },
    SLOW,
  )

  const empty: { name: string; keys: string[] }[] = [
    { name: 'Enter on an empty Other', keys: [down, down, enter] },
    { name: 'Enter on a blank Other', keys: [down, down, ...typed('   '), enter] },
    { name: 'the digit of an empty Other, then Enter', keys: ['3', enter] },
  ]
  for (const row of empty) {
    test(
      `${row.name} cancels the whole request`,
      async () => {
        const { log } = await answer({ questions: [DB] }, row.keys)
        expect(log).toEqual(CANCELLED)
      },
      SLOW,
    )
  }

  for (const [name, key] of [['Tab', tab], ['Right', right], ['Shift+Tab', shiftTab], ['Left', left]] as const) {
    test(
      `${name} does nothing when there is only one tab: Enter still answers the first option`,
      async () => {
        const { log, input, screen } = await answer({ questions: [DB] }, [key])
        expect(log).toEqual([])
        expect(shown(screen.text())[0]).toBe('☐ DB')
        await screen.press(enter)
        await Bun.sleep(150)
        expect(log).toEqual(allowedWith(answered(input, { 'Which database?': 'Postgres' })))
      },
      SLOW,
    )
  }
})

describe('AskUserQuestion: the ways out', () => {
  const ways: { name: string; keys: string[] }[] = [
    { name: 'Esc on an option', keys: [esc] },
    { name: 'Esc while typing in Other', keys: [down, down, ...typed('maybe'), esc] },
    { name: 'Ctrl+C', keys: [ctrlC] },
    { name: 'Esc on the chat line', keys: [down, down, down, esc] },
  ]
  for (const way of ways) {
    test(
      `${way.name}: a plain reject, never an allow`,
      async () => {
        const { log } = await answer({ questions: [DB] }, way.keys)
        expect(log).toEqual(CANCELLED)
      },
      SLOW,
    )
  }

  test(
    'Esc after some questions were answered still sends no answers',
    async () => {
      const { log } = await answer({ questions: [DB, CACHE] }, [enter, esc])
      expect(log).toEqual(CANCELLED)
    },
    SLOW,
  )
})

// --- what goes back with the answers ---------------------------------------------------

describe('AskUserQuestion: the tool input that goes back', () => {
  test(
    'every field the model sent is kept, and its own answers are replaced by the user\'s',
    async () => {
      const input = {
        questions: [DB, CACHE],
        answers: { 'Which database?': 'SQLite', 'Something else?': 'yes' },
        metadata: { source: 'remember' },
      }
      const { log } = await answer(input, [enter, enter, enter])
      expect(log).toEqual(allowedWith({ ...input, answers: { 'Which database?': 'Postgres', 'Which cache?': 'Redis' } }))
    },
    SLOW,
  )

  test(
    'the allow carries no permission updates and no feedback text',
    async () => {
      const { log } = await answer({ questions: [DB] }, [enter])
      const allow = log.find(item => Array.isArray(item) && item[0] === 'allow') as unknown[]
      expect(allow.slice(2)).toEqual([[], undefined, undefined])
    },
    SLOW,
  )
})

// --- several questions -------------------------------------------------------------------

describe('AskUserQuestion: several questions', () => {
  test(
    'each answer moves to the next question, and the last one to the review',
    async () => {
      const { screen, log } = await answer({ questions: [DB, CACHE] }, [enter, down, enter])
      expect(log).toEqual([])
      expect(shown(screen.text())).toEqual([
        '─'.repeat(100),
        '←  ☒ DB  ☒ Cache  ✔ Submit  →',
        'Review your answers',
        '● Which database?',
        '→ Postgres',
        '● Which cache?',
        '→ None',
        'Ready to submit your answers?',
        '❯ 1. Submit answers',
        '2. Cancel',
      ])
    },
    SLOW,
  )

  test(
    'Submit answers sends every answer, in one allow',
    async () => {
      const { log, input } = await answer({ questions: [DB, CACHE] }, [enter, down, enter, enter])
      expect(log).toEqual(allowedWith(answered(input, { 'Which database?': 'Postgres', 'Which cache?': 'None' })))
    },
    SLOW,
  )

  test(
    'Cancel and Esc on the review are a plain reject',
    async () => {
      for (const keys of [[down, enter], ['2'], [esc]]) {
        const { log, screen } = await answer({ questions: [DB, CACHE] }, [enter, enter, ...keys])
        expect(log).toEqual(CANCELLED)
        await screen.close()
      }
    },
    SLOW,
  )

  type Move = { name: string; keys: string[]; title: string; tab: string }
  const moves: Move[] = [
    { name: 'Tab moves to the next question', keys: [tab], title: 'Which cache?', tab: '←  ☐ DB  ☐ Cache  ✔ Submit  →' },
    { name: 'Right moves to the next question', keys: [right], title: 'Which cache?', tab: '←  ☐ DB  ☐ Cache  ✔ Submit  →' },
    { name: 'Left on the first question stays', keys: [left], title: 'Which database?', tab: '←  ☐ DB  ☐ Cache  ✔ Submit  →' },
    { name: 'Shift+Tab goes back', keys: [right, shiftTab], title: 'Which database?', tab: '←  ☐ DB  ☐ Cache  ✔ Submit  →' },
    { name: 'Right past the last question reaches the review', keys: [right, right], title: 'Review your answers', tab: '←  ☐ DB  ☐ Cache  ✔ Submit  →' },
    { name: 'Right on the review stays there', keys: [right, right, right, right], title: 'Review your answers', tab: '←  ☐ DB  ☐ Cache  ✔ Submit  →' },
    { name: 'Left from the review goes back to the last question', keys: [right, right, left], title: 'Which cache?', tab: '←  ☐ DB  ☐ Cache  ✔ Submit  →' },
  ]
  test(
    'Right on the review keeps it there: its Submit still answers',
    async () => {
      const { screen, log, input } = await answer({ questions: [DB, CACHE] }, [enter, right, right, right])
      expect(log).toEqual([])
      await screen.press(enter)
      await Bun.sleep(150)
      // The screen keeps the last frame even when nothing is drawn, so the answer is the check.
      expect(log).toEqual(allowedWith(answered(input, { 'Which database?': 'Postgres' })))
    },
    SLOW,
  )

  for (const move of moves) {
    test(
      `${move.name}, and nothing is reported`,
      async () => {
        const { screen, log } = await answer({ questions: [DB, CACHE] }, move.keys)
        expect(log).toEqual([])
        const lines = shown(screen.text()).filter(line => !/^─+$/.test(line))
        expect(lines.slice(0, 2)).toEqual([move.tab, move.title])
      },
      SLOW,
    )
  }

  test(
    'skipped questions: the review warns, lists only what was answered, and Submit sends only those',
    async () => {
      const { screen, log, input } = await answer({ questions: [DB, CACHE] }, [right, enter])
      const lines = shown(screen.text())
      expect(lines).toContain('⚠ You have not answered all questions')
      expect(lines).toContain('→ Redis')
      expect(lines).not.toContain('● Which database?')
      await screen.press(enter)
      await Bun.sleep(150)
      expect(log).toEqual(allowedWith(answered(input, { 'Which cache?': 'Redis' })))
    },
    SLOW,
  )

  test(
    'nothing answered: the review warns and lists nothing, and Submit sends an empty answer set',
    async () => {
      const { screen, log, input } = await answer({ questions: [DB, CACHE] }, [right, right])
      const lines = shown(screen.text())
      expect(lines).toContain('⚠ You have not answered all questions')
      expect(lines.some(line => line.startsWith('●'))).toBe(false)
      await screen.press(enter)
      await Bun.sleep(150)
      expect(log).toEqual(allowedWith(answered(input, {})))
    },
    SLOW,
  )

  test(
    'going back and choosing again replaces the earlier answer',
    async () => {
      const { log, input } = await answer({ questions: [DB, CACHE] }, [enter, enter, left, left, down, enter, right, enter])
      expect(log).toEqual(allowedWith(answered(input, { 'Which database?': 'SQLite', 'Which cache?': 'Redis' })))
    },
    SLOW,
  )

  test(
    'Other answers a question among several and moves on',
    async () => {
      const { log, input } = await answer({ questions: [DB, CACHE] }, [down, down, ...typed('DuckDB'), enter, enter, enter])
      expect(answersOnly(log)).toEqual(allowedWith(answered(input, { 'Which database?': 'DuckDB', 'Which cache?': 'Redis' })))
    },
    SLOW,
  )

  test(
    'while typing in Other, Tab and the side arrows do not change question',
    async () => {
      const { screen, log } = await answer({ questions: [DB, CACHE] }, [down, down, ...typed('ab'), tab, right, left])
      expect(log).toEqual([])
      expect(shown(screen.text())[1]).toBe('Which database?')
    },
    SLOW,
  )
})

// --- many choices ------------------------------------------------------------------------------

describe('AskUserQuestion: multi-choice questions', () => {
  test(
    'the answer is the chosen labels joined by ", ", in the order they were chosen',
    async () => {
      const { screen, log, input } = await answer({ questions: [LANGS] }, [down, down, space, up, up, space, down, down, down, down, enter])
      expect(shown(screen.text())).toContain('→ Rust, TS')
      expect(log).toEqual([])
      await screen.press(enter)
      await Bun.sleep(150)
      expect(log).toEqual(allowedWith(answered(input, { 'Which languages?': 'Rust, TS' })))
    },
    SLOW,
  )

  test(
    'choosing does not move on: the tab is ticked and the question stays',
    async () => {
      const { screen, log } = await answer({ questions: [LANGS, DB] }, [space, '2'])
      expect(log).toEqual([])
      expect(shown(screen.text()).slice(0, 2)).toEqual(['←  ☒ Langs  ☐ DB  ✔ Submit  →', 'Which languages?'])
    },
    SLOW,
  )

  test(
    'the button reads Next before the last question and moves on; on the last question it reads Submit',
    async () => {
      const opened = await answer({ questions: [LANGS, DB] }, [space])
      expect(shown(opened.screen.text())).toContain('Next')
      await opened.screen.press(down, down, down, down, enter)
      await Bun.sleep(150)
      expect(shown(opened.screen.text())[1]).toBe('Which database?')
      await opened.screen.press(enter, enter)
      await Bun.sleep(150)
      expect(opened.log).toEqual(allowedWith(answered(opened.input, { 'Which languages?': 'TS', 'Which database?': 'Postgres' })))

      const last = await open({ questions: [DB, LANGS] })
      await last.screen.press(enter)
      expect(shown(last.screen.text())).toContain('Submit')
    },
    SLOW,
  )

  test(
    'text typed into Other is added after the chosen labels once another choice is made',
    async () => {
      const { log, input } = await answer({ questions: [LANGS] }, [space, down, down, down, ...typed('Zig'), up, space, down, down, enter, enter])
      expect(answersOnly(log)).toEqual(allowedWith(answered(input, { 'Which languages?': 'TS, Rust, Zig' })))
    },
    SLOW,
  )

  test(
    'unchecking everything leaves the question unanswered on the review',
    async () => {
      const { screen } = await answer({ questions: [LANGS] }, [space, space, down, down, down, down, enter])
      const lines = shown(screen.text())
      expect(lines[1]).toBe('←  ☐ Langs  ✔ Submit  →')
      expect(lines).toContain('⚠ You have not answered all questions')
      expect(lines.some(line => line.startsWith('●'))).toBe(false)
    },
    SLOW,
  )
})

// --- "Chat about this" and the plan interview ---------------------------------------------------

describe('AskUserQuestion: answering with a message instead', () => {
  test(
    'Chat about this rejects with a message that asks to clarify and lists every question with its answer so far',
    async () => {
      const { log } = await answer({ questions: [DB, CACHE] }, [enter, down, down, down, enter])
      expect(log).toEqual(['caller.done', ['reject', expect.any(String), undefined]])
      const text = rejectText(log)
      expect(text).toMatch(/clarify/)
      expect(text).toMatch(/reformulate the questions/)
      expect(text.endsWith('- "Which database?"\n  Answer: Postgres\n- "Which cache?"\n  (No answer provided)')).toBe(true)
    },
    SLOW,
  )

  test(
    'with one question and no answer, the list says so',
    async () => {
      const { log } = await answer({ questions: [DB] }, [down, down, down, enter])
      expect(rejectText(log).endsWith('\n- "Which database?"\n  (No answer provided)')).toBe(true)
    },
    SLOW,
  )

  test(
    'outside plan mode the chat line is the last one: Down stays on it, Up leaves it',
    async () => {
      const { screen, log, input } = await answer({ questions: [DB] }, [down, down, down, down])
      expect(screen.text()).not.toContain('Skip interview')
      expect(shown(screen.text())).toContain('❯ 4. Chat about this')
      await screen.press(up, up, enter)
      await Bun.sleep(150)
      expect(log).toEqual(allowedWith(answered(input, { 'Which database?': 'SQLite' })))
    },
    SLOW,
  )

  test(
    'in plan mode a second line skips the interview: its message says to stop asking and finish the plan, with the answers so far',
    async () => {
      const { screen, log } = await answer({ questions: [DB, CACHE] }, [enter, down, down, down, down], { mode: 'plan' })
      expect(shown(screen.text())).toContain('❯ 5. Skip interview and plan immediately')
      await screen.press(enter)
      await Bun.sleep(150)
      expect(log).toEqual(['caller.done', ['reject', expect.any(String), undefined]])
      const text = rejectText(log)
      expect(text).toMatch(/plan interview/)
      expect(text).toMatch(/Stop asking clarifying questions/)
      expect(text).toMatch(/finish the plan/)
      expect(text.endsWith('- "Which database?"\n  Answer: Postgres\n- "Which cache?"\n  (No answer provided)')).toBe(true)
    },
    SLOW,
  )

  test(
    'in plan mode the chat line still asks to clarify',
    async () => {
      const { log } = await answer({ questions: [DB] }, [down, down, down, enter], { mode: 'plan' })
      expect(rejectText(log)).toMatch(/clarify/)
    },
    SLOW,
  )
})

// --- previews and notes ---------------------------------------------------------------------------

describe('AskUserQuestion: previews and notes', () => {
  const GRID = '## Grid\n- three columns'
  const LAYOUT = question({ question: 'Which layout?', header: 'Layout', choices: [{ label: 'Grid', preview: GRID }, 'List'] })

  test(
    'choosing an option with a preview sends the preview back as an annotation',
    async () => {
      const { log, input } = await answer({ questions: [LAYOUT] }, [enter])
      expect(log).toEqual(allowedWith(answered(input, { 'Which layout?': 'Grid' }, { 'Which layout?': { preview: GRID } })))
    },
    SLOW,
  )

  test(
    'choosing an option without one sends no annotations at all',
    async () => {
      const { log, input } = await answer({ questions: [LAYOUT] }, [down, enter])
      expect(log).toEqual(allowedWith(answered(input, { 'Which layout?': 'List' })))
    },
    SLOW,
  )

  type NoteRow = { name: string; note: string; choose: string[]; annotation: { preview?: string; notes?: string } | undefined; answer: string }
  const notes: NoteRow[] = [
    { name: 'a note on a preview option', note: 'wider gutters', choose: [enter], annotation: { preview: GRID, notes: 'wider gutters' }, answer: 'Grid' },
    { name: 'a note is trimmed', note: '  wider gutters  ', choose: [enter], annotation: { preview: GRID, notes: 'wider gutters' }, answer: 'Grid' },
    { name: 'a blank note is dropped', note: '   ', choose: [enter], annotation: { preview: GRID }, answer: 'Grid' },
    { name: 'a note on an option without a preview', note: 'keep it short', choose: [down, enter], annotation: { notes: 'keep it short' }, answer: 'List' },
    { name: 'a blank note on an option without a preview leaves no annotations', note: '  ', choose: [down, enter], annotation: undefined, answer: 'List' },
  ]
  for (const row of notes) {
    test(
      `${row.name}: the annotation of that question`,
      async () => {
        const { log, input } = await answer({ questions: [LAYOUT] }, ['n', ...typed(row.note), enter, ...row.choose])
        const annotations = row.annotation ? { 'Which layout?': row.annotation } : undefined
        expect(log).toEqual(allowedWith(answered(input, { 'Which layout?': row.answer }, annotations)))
      },
      SLOW,
    )
  }

  test(
    'annotations are keyed by question, and a question without one is left out',
    async () => {
      const { log, input } = await answer({ questions: [LAYOUT, DB] }, [enter, enter, enter])
      expect(log).toEqual(allowedWith(answered(input, { 'Which layout?': 'Grid', 'Which database?': 'Postgres' }, { 'Which layout?': { preview: GRID } })))
    },
    SLOW,
  )

  test(
    'a preview question is answered with Enter only: a digit just moves the pointer',
    async () => {
      const { log, input, screen } = await answer({ questions: [LAYOUT] }, ['2'])
      expect(log).toEqual([])
      await screen.press(enter)
      await Bun.sleep(150)
      expect(log).toEqual(allowedWith(answered(input, { 'Which layout?': 'List' })))
    },
    SLOW,
  )

  test(
    'Esc on a preview question is a plain reject',
    async () => {
      const { log } = await answer({ questions: [LAYOUT] }, [esc])
      expect(log).toEqual(CANCELLED)
    },
    SLOW,
  )
})

// --- pasted images ---------------------------------------------------------------------------------

describe('AskUserQuestion: images pasted into Other', () => {
  /** A step of a key script: keys to press, or an image to paste and wait for. */
  type Step = string | { paste: number }
  const PASTE_1 = { paste: 1 }
  const PASTE_2 = { paste: 2 }

  /** Like `answer`, but an image paste waits until the dialog shows the attachment. */
  async function script(input: Record<string, unknown>, steps: Step[], options: OpenOptions = {}): Promise<Opened> {
    const opened = await open(input, options)
    for (const step of steps) {
      if (typeof step === 'string') {
        await opened.screen.press(step)
        continue
      }
      await opened.screen.press(pasted(pngOnDisk(world().home)))
      await opened.screen.until(frame => frame.includes(`[Image #${step.paste}]`), `image ${step.paste}`)
      await Bun.sleep(300)
    }
    await Bun.sleep(300)
    return opened
  }

  test(
    'an image with no text: the answer says an image is attached, and the image goes along as a block',
    async () => {
      const { log, input } = await script({ questions: [DB] }, [down, down, PASTE_1, enter])
      expect(answersOnly(log)).toEqual(allowedWith(answered(input, { 'Which database?': '(Image attached)' }), [pngBlock]))
    },
    SLOW,
  )

  test(
    'an image with text: the text, marked as having an image',
    async () => {
      const { log, input } = await script({ questions: [DB] }, [down, down, PASTE_1, ...typed('like this'), enter])
      expect(answersOnly(log)).toEqual(allowedWith(answered(input, { 'Which database?': 'like this (Image attached)' }), [pngBlock]))
    },
    SLOW,
  )

  test(
    'an image removed before answering is neither mentioned nor sent',
    async () => {
      const { log, input } = await script({ questions: [DB] }, [down, down, PASTE_1, ...typed('abc'), down, backspace, enter])
      expect(answersOnly(log)).toEqual(allowedWith(answered(input, { 'Which database?': 'abc' })))
    },
    SLOW,
  )

  test(
    'Chat about this sends the pasted images with its message',
    async () => {
      const { log } = await script({ questions: [DB, CACHE] }, [down, down, PASTE_1, ...typed('x'), up, up, enter, down, down, down, enter])
      expect(log).toEqual(['caller.done', ['reject', expect.any(String), [pngBlock]]])
    },
    SLOW,
  )

  test(
    'skipping the plan interview sends them too',
    async () => {
      const { log } = await script({ questions: [DB, CACHE] }, [down, down, PASTE_1, ...typed('x'), up, up, enter, down, down, down, down, enter], { mode: 'plan' })
      expect(log).toEqual(['caller.done', ['reject', expect.any(String), [pngBlock]]])
      expect(rejectText(log)).toMatch(/finish the plan/)
    },
    SLOW,
  )

  test(
    'images pasted on several questions all go along',
    async () => {
      const { log, input } = await script({ questions: [DB, CACHE] }, [down, down, PASTE_1, enter, down, down, PASTE_2, enter, enter])
      expect(answersOnly(log)).toEqual(allowedWith(answered(input, { 'Which database?': '(Image attached)', 'Which cache?': '(Image attached)' }), [pngBlock, pngBlock]))
    },
    SLOW,
  )

  test(
    'an image pasted on a question that was then answered with an option still goes along',
    async () => {
      const { log, input } = await script({ questions: [DB] }, [down, down, PASTE_1, up, up, enter])
      expect(answersOnly(log)).toEqual(allowedWith(answered(input, { 'Which database?': 'Postgres' }), [pngBlock]))
    },
    SLOW,
  )
})

// --- height, width, and input it cannot read ----------------------------------------------------------

describe('AskUserQuestion: layout', () => {
  const FOUR = question({ question: 'Which store?', header: 'Store', choices: ['Redis', 'None', 'Memcached', 'Disk'] })
  const height = (screen: Screen) => screen.text().split('\n').length

  test(
    'every question of a request takes the height of the tallest one, when the terminal allows it',
    async () => {
      const { screen } = await open({ questions: [DB, FOUR] }, { rows: 60 })
      const first = height(screen)
      await screen.press(right)
      expect(shown(screen.text())[1]).toBe('Which store?')
      expect(height(screen)).toBe(first)
      expect(first).toBe(17)
    },
    SLOW,
  )

  test(
    'a short terminal caps the height at the minimum',
    async () => {
      const { screen } = await open({ questions: [DB, FOUR] }, { rows: 24 })
      expect(height(screen)).toBe(15)
    },
    SLOW,
  )

  test(
    'questions short enough get the minimum height whatever the terminal',
    async () => {
      const { screen } = await open({ questions: [DB, CACHE] }, { rows: 60 })
      expect(height(screen)).toBe(15)
    },
    SLOW,
  )

  const boxTop = (screen: Screen) => shown(screen.text()).find(line => line.includes('┌'))!.replace(/^.*┌/, '┌')

  test(
    'a preview box is at least 40 columns of content wide, and as wide as the widest preview line of the request',
    async () => {
      const narrow = question({ question: 'Pick?', header: 'P', choices: [{ label: 'A', preview: 'short' }, 'B'] })
      const { screen } = await open({ questions: [narrow] }, { rows: 60, columns: 120 })
      expect(boxTop(screen)).toBe(`┌${'─'.repeat(42)}┐`)
      await screen.close()

      const wideLine = 'x'.repeat(50)
      const wide = question({ question: 'Pick?', header: 'P', choices: [{ label: 'A', preview: 'short' }, { label: 'B', preview: wideLine }] })
      const second = await open({ questions: [wide] }, { rows: 60, columns: 120 })
      expect(boxTop(second.screen)).toBe(`┌${'─'.repeat(52)}┐`)
    },
    SLOW,
  )

  test(
    'a tall preview is cut to what the terminal leaves for it',
    async () => {
      const tall = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
      const pick = question({ question: 'Pick?', header: 'P', choices: [{ label: 'A', preview: tall }, 'B'] })
      const short = await open({ questions: [pick] }, { rows: 24 })
      expect(shown(short.screen.text()).some(line => line.endsWith(`│ line 1${' '.repeat(35)}│`))).toBe(true)
      expect(short.screen.text()).not.toContain('line 2')
      expect(short.screen.text()).toContain('29 lines hidden')
      await short.screen.close()

      const roomy = await open({ questions: [pick] }, { rows: 60 })
      expect(roomy.screen.text()).toContain('line 30')
      expect(roomy.screen.text()).not.toContain('lines hidden')
    },
    SLOW,
  )

  test(
    'input that does not parse shows an empty review, and Submit allows with no answers',
    async () => {
      const input = { questions: [DB, DB] }
      const { screen, log } = await open(input)
      const lines = shown(screen.text())
      expect(lines).toContain('Review your answers')
      expect(lines).not.toContain('⚠ You have not answered all questions')
      await screen.press(enter)
      await Bun.sleep(150)
      expect(log).toEqual(allowedWith(answered(input, {})))
    },
    SLOW,
  )
})

describe('AskUserQuestion: with syntax highlighting turned off in the settings', () => {
  test(
    'it shows and answers the same way',
    async () => {
      const config = world().config
      mkdirSync(config, { recursive: true })
      writeFileSync(join(config, 'settings.json'), JSON.stringify({ syntaxHighlightingDisabled: true }))
      resetSettingsCache()
      const LAYOUT = question({ question: 'Which layout?', header: 'Layout', choices: [{ label: 'Grid', preview: '```ts\nconst grid = 3\n```' }, 'List'] })
      const { screen, log, input } = await open({ questions: [LAYOUT] })
      expect(screen.text()).toContain('const grid = 3')
      await screen.press(down, enter)
      await Bun.sleep(150)
      expect(log).toEqual(allowedWith(answered(input, { 'Which layout?': 'List' })))
    },
    SLOW,
  )
})
