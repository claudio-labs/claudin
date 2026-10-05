/**
 * Characterization of the screen AskUserQuestion shows for one question: the
 * question, its options and a free-text "Other" row, then a footer to chat
 * about the question instead (and, in plan mode, to skip the interview).
 * Written before the clean-base rewrite of permissions/askUserQuestionViews;
 * the spec is docs/tech/rewrite/permissions/askUserQuestionViews.md.
 *
 * A single-choice question with any preview is handed to the side-by-side
 * view (its own suite); everything else is drawn here. Layout is pinned on
 * static frames; keys are pressed on a fake terminal under a stand-in parent
 * that keeps the per-question state the view asks it to record.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { type Log, questionOf, show, stillView, type Told, type ViewSpec } from 'src/permissions/ui/__testutils__/askUserQuestionViewsRig.js'
import { fakeEditor, lendTerminalToEditor } from 'src/permissions/ui/__testutils__/modeDialogsRig.js'
import { isolatedWorld, KEYS, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { getExternalEditor } from 'src/shared/editor.js'

isolatedWorld()
const { enter, esc, up, down } = KEYS
const CTRL_N = '\x0e'
const CTRL_P = '\x10'
const EXTERNAL_EDITOR = ['\x18', '\x05'] // ctrl+x ctrl+e

const saved = process.env.VISUAL
let editorDir = ''
const useEditor = (body: string) => {
  process.env.VISUAL = fakeEditor(editorDir, body)
  getExternalEditor.cache.clear?.()
}
beforeAll(() => {
  editorDir = mkdtempSync(join(tmpdir(), 'question-editor-'))
  useEditor('printf "from the editor" > "$1"')
})
afterAll(() => {
  if (saved === undefined) delete process.env.VISUAL
  else process.env.VISUAL = saved
  getExternalEditor.cache.clear?.()
  rmSync(editorDir, { recursive: true, force: true })
})

const LAYOUT = questionOf('Which layout?', [
  { label: 'Grid', description: 'cards in a grid' },
  { label: 'List', description: 'one per row' },
])
const PARTS = questionOf('Which parts?', [{ label: 'Header' }, { label: 'Footer' }], { multiSelect: true })
const one: ViewSpec = { questions: [LAYOUT] }
const Q = 'Which layout?'
const M = 'Which parts?'

const trimmed = (frame: string) => frame.split('\n').map(line => line.trimEnd())
/** The row the pointer is on, without the pointer. */
const pointed = (frame: string) =>
  trimmed(frame)
    .find(line => line.startsWith('❯'))
    ?.slice(2)
const withoutTyping = (log: Log): Log => log.filter(entry => entry.to !== 'typing')
const lastTyping = (log: Log) => (log.filter(entry => entry.to === 'typing').at(-1) as Extract<Told, { to: 'typing' }> | undefined)?.on

describe('QuestionView: the screen', () => {
  test(
    'a single-choice question at 100 and 60 columns: options with descriptions, the Other row, a numbered footer',
    async () => {
      const [at100, at60] = await Promise.all([100, 60].map(columns => stillView('question', one, columns)))
      for (const [frame, columns] of [[at100, 100], [at60, 60]] as const) {
        expect(trimmed(frame)).toEqual([
          '←  ☐ Which  ✔ Submit  →',
          '',
          'Which layout?',
          '',
          '❯ 1. Grid',
          '     cards in a grid',
          '  2. List',
          '     one per row',
          '  3. Type something.',
          '─'.repeat(columns),
          '  4. Chat about this',
          '',
          'Enter to select · ↑/↓ to navigate · Esc to cancel',
        ])
      }
    },
    SLOW,
  )

  test(
    'multiple choice over two questions: boxes, an Other row without the full stop, Next on all but the last, Tab in the hint',
    async () => {
      const [first, last] = await Promise.all([
        stillView('question', { questions: [PARTS, LAYOUT] }, 100),
        stillView('question', { questions: [LAYOUT, PARTS], index: 1, answers: { [Q]: 'Grid' } }, 100),
      ])
      const body = (button: string) => ['❯ 1. [ ] Header', '  2. [ ] Footer', '  3. [ ] Type something', `     ${button}`, '─'.repeat(100), '  4. Chat about this', '', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel']
      expect(trimmed(first)).toEqual(['←  ☐ Which  ☐ Which  ✔ Submit  →', '', 'Which parts?', '', ...body('Next')])
      expect(trimmed(last)).toEqual(['←  ☒ Which  ☐ Which  ✔ Submit  →', '', 'Which parts?', '', ...body('Submit')])
    },
    SLOW,
  )

  test(
    'plan mode adds a numbered skip line under the chat line',
    async () => {
      const [plain, withPlan] = await Promise.all([
        stillView('question', one, 100, 'plan'),
        stillView('question', { questions: [LAYOUT], planFilePath: '/work/plans/rollout.md' }, 100, 'plan'),
      ])
      for (const frame of [plain, withPlan]) {
        expect(trimmed(frame).slice(-5)).toEqual([
          '─'.repeat(100),
          '  4. Chat about this',
          '  5. Skip interview and plan immediately',
          '',
          'Enter to select · ↑/↓ to navigate · Esc to cancel',
        ])
        expect(frame).toContain('❯ 1. Grid')
      }
    },
    SLOW,
  )

  test(
    'with the submit tab hidden and one question, the bar is the header alone',
    async () => {
      const frame = await stillView('question', { questions: [LAYOUT], hideSubmitTab: true }, 100)
      expect(trimmed(frame)[0]).toBe(' ☐ Which')
    },
    SLOW,
  )

  // [what, question, drawn side by side]
  const routes: Array<[string, ReturnType<typeof questionOf>, boolean]> = [
    ['single choice, every option previewed', questionOf('Pick one', [{ label: 'A', preview: 'pa' }, { label: 'B', preview: 'pb' }]), true],
    ['single choice, one option previewed', questionOf('Pick one', [{ label: 'A' }, { label: 'B', preview: 'pb' }]), true],
    ['single choice, an empty preview counts as none', questionOf('Pick one', [{ label: 'A', preview: '' }, { label: 'B' }]), false],
    ['multiple choice ignores previews', questionOf('Pick some', [{ label: 'A', preview: 'pa' }, { label: 'B', preview: 'pb' }], { multiSelect: true }), false],
  ]
  for (const [what, question, sideBySide] of routes) {
    test(
      `${what}: ${sideBySide ? 'the side-by-side view' : 'the list'}`,
      async () => {
        const frame = await stillView('question', { questions: [question], hideSubmitTab: true }, 100)
        expect(frame.includes('n to add notes')).toBe(sideBySide)
        expect(frame.includes('┌')).toBe(sideBySide)
        expect(frame.includes('Type something')).toBe(!sideBySide)
        if (sideBySide) expect(trimmed(frame)).not.toContain('✔ Submit')
      },
      SLOW,
    )
  }
})

describe('QuestionView: single choice', () => {
  const picked = (label: string, typed?: string): Log => [
    { to: 'record', question: Q, updates: { selectedValue: label }, multi: false },
    { to: 'answer', question: Q, picked: label, typed, advance: undefined, argc: 3 },
  ]

  const answers: Array<[string, string[], Log]> = [
    ['Enter takes the focused option', [enter], picked('Grid')],
    ['down then Enter', [down, enter], picked('List')],
    ['a digit answers at once', ['2'], picked('List')],
    ['ctrl+n moves like down', [CTRL_N, enter], picked('List')],
    ['ctrl+p moves like up', [down, CTRL_P, enter], picked('Grid')],
    [
      'typing in Other records the text key by key; Enter answers with it',
      [down, down, 'h', 'i', enter],
      [
        { to: 'record', question: Q, updates: { textInputValue: 'h' }, multi: false },
        { to: 'record', question: Q, updates: { textInputValue: 'hi' }, multi: false },
        ...picked('__other__', 'hi'),
      ],
    ],
    ['Esc cancels', [down, esc], [{ to: 'cancel' }]],
    ['Enter on an empty Other cancels', [down, down, enter], [{ to: 'cancel' }]],
  ]
  for (const [what, keys, expected] of answers) {
    test(
      what,
      async () => {
        const { screen, log } = await show('question', one)
        await screen.press(...keys)
        expect(withoutTyping(log)).toEqual(expected)
      },
      SLOW,
    )
  }

  test(
    'the parent hears when the Other row takes and loses the focus',
    async () => {
      const { screen, log } = await show('question', one)
      expect(lastTyping(log)).toBe(false)
      await screen.press(down, down)
      expect(lastTyping(log)).toBe(true)
      await screen.press(up)
      expect(lastTyping(log)).toBe(false)
    },
    SLOW,
  )

  test(
    'a recorded choice is ticked; recorded Other text fills the Other row',
    async () => {
      const chosen = await show('question', { questions: [LAYOUT], states: { [Q]: { selectedValue: 'List', textInputValue: '' } } })
      expect(trimmed(chosen.screen.text())).toContain('  2. List ✔')
      const typed = await show('question', { questions: [LAYOUT], states: { [Q]: { selectedValue: '__other__', textInputValue: 'a table' } } })
      expect(trimmed(typed.screen.text())).toContain('  3. a table ✔')
    },
    SLOW,
  )
})

describe('QuestionView: multiple choice', () => {
  const toggled = (values: string[], picked: string[] = values): Log => [
    { to: 'record', question: M, updates: { selectedValue: values }, multi: true },
    { to: 'answer', question: M, picked, typed: undefined, advance: false, argc: 4 },
  ]

  const cases: Array<[string, ViewSpec, string[], Log]> = [
    ['Enter toggles the focused option and answers without moving on', { questions: [PARTS] }, [enter], toggled(['Header'])],
    ['a digit toggles its option', { questions: [PARTS] }, ['2'], toggled(['Footer'])],
    ['two toggles answer with both', { questions: [PARTS] }, [enter, down, enter], [...toggled(['Header']), ...toggled(['Header', 'Footer'])]],
    ['toggling twice clears', { questions: [PARTS] }, [enter, enter], [...toggled(['Header']), ...toggled([])]],
    [
      'a recorded selection is the starting point',
      { questions: [PARTS], states: { [M]: { selectedValue: ['Footer'], textInputValue: '' } } },
      ['1'],
      toggled(['Footer', 'Header']),
    ],
    ['the button under the options submits the question', { questions: [PARTS] }, [down, down, down, enter], [{ to: 'submit' }]],
    ['Esc cancels', { questions: [PARTS] }, [esc], [{ to: 'cancel' }]],
  ]
  for (const [what, spec, keys, expected] of cases) {
    test(
      what,
      async () => {
        const { screen, log } = await show('question', spec)
        await screen.press(...keys)
        expect(withoutTyping(log)).toEqual(expected)
      },
      SLOW,
    )
  }

  test(
    'Other text joins the answer, without the Other marker, once the selection changes after typing',
    async () => {
      const { screen, log } = await show('question', { questions: [PARTS] })
      await screen.press(down, down, 'x', 'y')
      expect(log.filter(entry => entry.to === 'record').at(-1)).toEqual({ to: 'record', question: M, updates: { textInputValue: 'xy' }, multi: true })
      await screen.press(up, up, enter)
      const answer = log.filter(entry => entry.to === 'answer').at(-1) as Extract<Told, { to: 'answer' }>
      expect([...(answer.picked as string[])].sort()).toEqual(['Header', 'xy'])
      expect(answer).toMatchObject({ typed: undefined, advance: false, argc: 4 })
    },
    SLOW,
  )
})

describe('QuestionView: the footer', () => {
  // Reached by pressing down past the Other row (single choice).
  const walks: Array<[string, 'default' | 'plan', string[], string | undefined, Log]> = [
    ['down from the last row reaches the chat line', 'default', [], '4. Chat about this', []],
    ['Enter there asks to respond in chat', 'default', [enter], '4. Chat about this', [{ to: 'chat' }]],
    ['Esc there cancels', 'default', [esc], '4. Chat about this', [{ to: 'cancel' }]],
    ['outside plan mode down stays', 'default', [down, CTRL_N], '4. Chat about this', []],
    ['up goes back to the Other row', 'default', [up], '3. Type something.', []],
    ['ctrl+p goes back too', 'default', [CTRL_P], '3. Type something.', []],
    ['the list is asleep meanwhile: digits answer nothing', 'default', ['1', '2'], '4. Chat about this', []],
    ['in plan mode down reaches the skip line', 'plan', [down], '5. Skip interview and plan immediately', []],
    ['ctrl+n reaches it too', 'plan', [CTRL_N], '5. Skip interview and plan immediately', []],
    ['Enter on the skip line ends the interview', 'plan', [down, enter], '5. Skip interview and plan immediately', [{ to: 'skipInterview' }]],
    ['up from the skip line returns to chat', 'plan', [down, up, enter], '4. Chat about this', [{ to: 'chat' }]],
  ]
  for (const [what, mode, keys, row, expected] of walks) {
    test(
      `${what} (${mode} mode)`,
      async () => {
        const { screen, log } = await show('question', one, { mode })
        await screen.press(down, down, down, ...keys)
        expect(pointed(screen.text())).toBe(row as unknown as string)
        expect(withoutTyping(log)).toEqual(expected)
      },
      SLOW,
    )
  }

  test(
    'with multiple choice, down from the button reaches the chat line',
    async () => {
      const { screen, log } = await show('question', { questions: [PARTS] })
      await screen.press(down, down, down, down)
      // The button keeps its own pointer while the footer has the focus.
      expect(trimmed(screen.text())).toContain('❯ 4. Chat about this')
      await screen.press(enter)
      expect(withoutTyping(log)).toEqual([{ to: 'chat' }])
    },
    SLOW,
  )
})

describe('QuestionView: the external editor', () => {
  test(
    'the hint names the editor only while the Other row has the focus',
    async () => {
      const { screen } = await show('question', one)
      expect(screen.text()).not.toContain('edit in')
      await screen.press(down, down)
      expect(screen.text().replace(/\s+/g, ' ')).toMatch(/↑\/↓ to navigate · \S+ to edit in Plan-editor · Esc to cancel/)
    },
    SLOW,
  )

  const editorCases: Array<[string, ViewSpec, number, boolean]> = [
    ['single choice', one, 2, false],
    ['multiple choice', { questions: [PARTS] }, 2, true],
  ]
  for (const [what, spec, row, multi] of editorCases) {
    test(
      `ctrl+x ctrl+e on the Other row records what the editor returns (${what})`,
      async () => {
        const { screen, log } = await show('question', spec)
        await screen.press(...Array<string>(row).fill(down))
        const giveBack = lendTerminalToEditor()
        try {
          await screen.press(...EXTERNAL_EDITOR)
          await screen.until(frame => frame.includes('from the editor'), 'the edited text')
        } finally {
          giveBack()
        }
        expect(log.filter(entry => entry.to === 'record')[0]).toEqual({ to: 'record', question: spec.questions[0]!.question, updates: { textInputValue: 'from the editor' }, multi })
      },
      SLOW,
    )
  }

  test(
    'an editor that changes nothing records nothing',
    async () => {
      useEditor(':')
      try {
        const { screen, log } = await show('question', { questions: [LAYOUT], states: { [Q]: { textInputValue: 'draft' } } })
        await screen.press(down, down)
        const giveBack = lendTerminalToEditor()
        try {
          await screen.press(...EXTERNAL_EDITOR)
          await Bun.sleep(300)
        } finally {
          giveBack()
        }
        expect(withoutTyping(log)).toEqual([])
      } finally {
        useEditor('printf "from the editor" > "$1"')
      }
    },
    SLOW,
  )
})

describe('QuestionView: handing over to the side-by-side view', () => {
  test(
    'with previews the keys are the side-by-side ones: n opens notes, Enter answers with the label alone',
    async () => {
      const question = questionOf('Pick one', [{ label: 'A', preview: 'pa' }, { label: 'B', preview: 'pb' }])
      const { screen, log } = await show('question', { questions: [question] }, { mode: 'plan' })
      expect(screen.text()).toContain('Skip interview and plan immediately')
      await screen.press('2', enter, 'n')
      expect(log).toEqual([
        { to: 'record', question: 'Pick one', updates: { selectedValue: 'B' }, multi: false },
        { to: 'answer', question: 'Pick one', picked: 'B', typed: undefined, advance: undefined, argc: 2 },
        { to: 'typing', on: true },
      ])
      await screen.press(esc, down, enter)
      expect(log.slice(-1)).toEqual([{ to: 'chat' }])
    },
    SLOW,
  )
})
