/**
 * Characterization of the side-by-side question screen AskUserQuestion uses
 * when a single-choice question carries previews: the options on the left,
 * the focused option's preview on the right, a notes line under it, and the
 * "chat about this" footer. Written before the clean-base rewrite of
 * permissions/askUserQuestionViews; the spec is
 * docs/tech/rewrite/permissions/askUserQuestionViews.md.
 *
 * The screen is pinned on static frames at a few widths; the keys are
 * pressed on a fake terminal under a stand-in parent that records what the
 * view asks it to keep, and every call the view makes is checked in order.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as React from 'react'
import { PreviewQuestionView } from 'src/permissions/ui/AskUserQuestionPermissionRequest/PreviewQuestionView.js'
import { type Log, questionOf, respec, show, stillView, type ViewSpec } from 'src/permissions/ui/__testutils__/askUserQuestionViewsRig.js'
import { fakeEditor, lendTerminalToEditor } from 'src/permissions/ui/__testutils__/modeDialogsRig.js'
import { isolatedWorld, KEYS, mount, SLOW, styleBefore, withTruecolor } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { getExternalEditor } from 'src/shared/editor.js'
import { Text } from 'src/terminal/ink.js'

isolatedWorld()
withTruecolor()
const { enter, esc, tab, up, down } = KEYS
const CTRL_N = '\x0e'
const CTRL_P = '\x10'
const SHIFT_TAB = '\x1B[Z'
const LEFT = '\x1B[D'
const RIGHT = '\x1B[C'
const EXTERNAL_EDITOR = ['\x18', '\x05'] // ctrl+x ctrl+e

// The editor the hint names and ctrl+x ctrl+e opens: a script in a temp dir.
const saved = process.env.VISUAL
let editorDir = ''
const useEditor = (body: string) => {
  process.env.VISUAL = fakeEditor(editorDir, body)
  getExternalEditor.cache.clear?.()
}
beforeAll(() => {
  editorDir = mkdtempSync(join(tmpdir(), 'preview-editor-'))
  useEditor('printf "from the editor" > "$1"')
})
afterAll(() => {
  if (saved === undefined) delete process.env.VISUAL
  else process.env.VISUAL = saved
  getExternalEditor.cache.clear?.()
  rmSync(editorDir, { recursive: true, force: true })
})

const DESIGN = questionOf('Pick a design', [
  { label: 'Alpha', description: 'the first', preview: 'alpha body\nsecond line' },
  { label: 'Beta', description: 'the second', preview: 'beta body' },
  { label: 'Gamma', description: 'the third' },
])
const COLOUR = questionOf('Pick a colour', [
  { label: 'Red', preview: 'red swatch' },
  { label: 'Blue', preview: 'blue swatch' },
  { label: 'Green', preview: 'green swatch' },
])
const one: ViewSpec = { questions: [DESIGN] }

/** The option the pointer is on, in the left column. */
const focused = (frame: string) => /^❯ \d\. (\S+)/m.exec(frame)?.[1]
/** The first text row inside the preview box. */
const previewTop = (frame: string) => /│ (.*?)\s+│/.exec(frame)?.[1]
/** The footer row the pointer is on, if any. */
const footerFocus = (frame: string) => /^❯ (Chat about this|Skip interview and plan immediately)$/m.exec(frame.split('\n').map(l => l.trimEnd()).join('\n'))?.[1]
const trimmed = (frame: string) => frame.split('\n').map(line => line.trimEnd())

/** The rows of a box `width` wide, starting at column 34, beside the option rows. */
function sideBySide(width: number, options: string[], body: string[]): string[] {
  const box = [`┌${'─'.repeat(width - 2)}┐`, ...body.map(text => `│ ${text.padEnd(width - 4)} │`), `└${'─'.repeat(width - 2)}┘`]
  return Array.from({ length: Math.max(options.length, box.length) }, (_, i) => `${(options[i] ?? '').padEnd(34)}${box[i] ?? ''}`.trimEnd())
}

describe('PreviewQuestionView: the screen at a few widths', () => {
  test(
    'one question at 80 and 120 columns, a narrow box at 60',
    async () => {
      const [at60, at80, at120] = await Promise.all([60, 80, 120].map(columns => stillView('preview', one, columns)))
      const options = ['❯ 1. Alpha', '  2. Beta', '  3. Gamma']
      for (const [frame, columns] of [[at80, 80], [at120, 120]] as const) {
        expect(trimmed(frame)).toEqual([
          '',
          '─'.repeat(columns),
          '←  ☐ Pick  ✔ Submit  →',
          '',
          'Pick a design',
          '',
          ...sideBySide(44, options, ['alpha body', 'second line']),
          '',
          `${' '.repeat(34)}Notes: press n to add notes`,
          '',
          '─'.repeat(columns),
          '  Chat about this',
          '',
          'Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel',
        ])
      }
      // At 60 the box gives way: 60 minus the 30-column list and the 4-column gap.
      const boxOnly = (line: string) => line.slice(Math.max(0, line.search(/[┌│└]/)))
      expect(trimmed(at60).slice(6, 10).map(boxOnly)).toEqual(sideBySide(26, [], ['alpha body', 'second line']).map(boxOnly))
      expect(trimmed(at60).slice(6, 9).map(line => line.split(/\s{2,}[┌│]/)[0])).toEqual(options)
    },
    SLOW,
  )

  test(
    'two questions in plan mode: a Tab hint, and the skip line under the chat line',
    async () => {
      const frame = await stillView('preview', { questions: [DESIGN, COLOUR], answers: { 'Pick a colour': 'Red' } }, 100, 'plan')
      const lines = trimmed(frame)
      expect(lines[2]).toBe('←  ☐ Pick  ☒ Pick  ✔ Submit  →')
      expect(lines.slice(-5)).toEqual([
        '─'.repeat(100),
        '  Chat about this',
        '  Skip interview and plan immediately',
        '',
        'Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel',
      ])
    },
    SLOW,
  )

  test(
    'the box width: minContentWidth widens it, the terminal still caps it',
    async () => {
      const wide = { questions: [DESIGN], minContentWidth: 60 }
      const [at120, at80] = await Promise.all([stillView('preview', wide, 120), stillView('preview', wide, 80)])
      expect(trimmed(at120)[6]).toBe(`❯ 1. Alpha${' '.repeat(24)}┌${'─'.repeat(62)}┐`)
      expect(trimmed(at80)[6]).toBe(`❯ 1. Alpha${' '.repeat(24)}┌${'─'.repeat(44)}┐`)
    },
    SLOW,
  )

  test(
    'the box height: minContentHeight less 11 rows, never below one; unset, 20',
    async () => {
      const tall = questionOf('Pick a size', [
        { label: 'Tall', preview: Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n') },
        { label: 'Short', preview: 'one' },
      ])
      const heights = [14, 12, 5, undefined]
      const frames = await Promise.all(heights.map(minContentHeight => stillView('preview', { questions: [tall], minContentHeight }, 100)))
      const boxRows = (frame: string) => trimmed(frame).filter(line => /[│├]/.test(line)).map(line => line.slice(34))
      const shown = (count: number, hidden: number) => [
        ...Array.from({ length: count }, (_, i) => `│ ${`line ${i + 1}`.padEnd(40)} │`),
        `├─── ✂ ─── ${hidden} lines hidden ${'─'.repeat(18 - String(hidden).length)}┤`,
      ]
      expect(frames.map(boxRows)).toEqual([shown(3, 22), shown(1, 24), shown(1, 24), shown(20, 5)])
    },
    SLOW,
  )
})

describe('PreviewQuestionView: moving between options', () => {
  // [keys, the option then focused, the preview then shown]
  const moves: Array<[string, string[], string, string]> = [
    ['nothing pressed', [], 'Alpha', 'alpha body'],
    ['down', [down], 'Beta', 'beta body'],
    ['down twice, to an option with no preview', [down, down], 'Gamma', 'No preview available'],
    ['down then up', [down, up], 'Alpha', 'alpha body'],
    ['up at the top stays', [up], 'Alpha', 'alpha body'],
    ['ctrl+n moves down', [CTRL_N], 'Beta', 'beta body'],
    ['ctrl+n then ctrl+p', [CTRL_N, CTRL_P], 'Alpha', 'alpha body'],
    ['a digit jumps to its option', ['3'], 'Gamma', 'No preview available'],
    ['digits jump both ways', ['3', '2'], 'Beta', 'beta body'],
    ['a digit past the last option is ignored', ['2', '9'], 'Beta', 'beta body'],
    ['zero is ignored', ['2', '0'], 'Beta', 'beta body'],
    ['other letters are ignored', ['2', 'y', 'x'], 'Beta', 'beta body'],
  ]
  for (const [what, keys, option, preview] of moves) {
    test(
      `${what}: focus moves, nothing is answered`,
      async () => {
        const { screen, log } = await show('preview', one)
        await screen.press(...keys)
        expect([focused(screen.text()), previewTop(screen.text())]).toEqual([option, preview])
        expect(log).toEqual([])
      },
      SLOW,
    )
  }

  test(
    'coming to a question puts the focus on its recorded choice, or on the first option',
    async () => {
      const shown = await show('preview', { questions: [DESIGN, COLOUR], states: { 'Pick a colour': { selectedValue: 'Green', textInputValue: '' } } })
      await shown.screen.press(down)
      await respec(shown, 'preview', { questions: [DESIGN, COLOUR], index: 1 })
      expect([focused(shown.screen.text()), previewTop(shown.screen.text())]).toEqual(['Green', 'green swatch'])
      await respec(shown, 'preview', { questions: [DESIGN, COLOUR], index: 0 })
      expect([focused(shown.screen.text()), previewTop(shown.screen.text())]).toEqual(['Alpha', 'alpha body'])
      expect(shown.log).toEqual([])
    },
    SLOW,
  )

  test(
    'a recorded choice that is no longer an option leaves the focus on the first',
    async () => {
      const shown = await show('preview', { questions: [DESIGN, COLOUR], states: { 'Pick a colour': { selectedValue: 'Purple', textInputValue: '' } } })
      await shown.screen.press(down)
      await respec(shown, 'preview', { questions: [DESIGN, COLOUR], index: 1 })
      expect(focused(shown.screen.text())).toBe('Red')
    },
    SLOW,
  )
})

describe('PreviewQuestionView: answering', () => {
  const picked = (label: string): Log => [
    { to: 'record', question: 'Pick a design', updates: { selectedValue: label }, multi: false },
    { to: 'answer', question: 'Pick a design', picked: label, typed: undefined, advance: undefined, argc: 2 },
  ]
  const answers: Array<[string, string[], string]> = [
    ['Enter takes the focused option', [enter], 'Alpha'],
    ['a digit then Enter', ['2', enter], 'Beta'],
    ['an option with no preview can be chosen', [down, down, enter], 'Gamma'],
  ]
  for (const [what, keys, label] of answers) {
    test(
      what,
      async () => {
        const { screen, log } = await show('preview', one)
        await screen.press(...keys)
        expect(log).toEqual(picked(label))
        expect(screen.text()).toContain(`❯ ${['Alpha', 'Beta', 'Gamma'].indexOf(label) + 1}. ${label} ✔`)
      },
      SLOW,
    )
  }

  test(
    'the recorded choice is ticked from the start; the focus starts on the first option all the same',
    async () => {
      const { screen } = await show('preview', { questions: [DESIGN], states: { 'Pick a design': { selectedValue: 'Beta', textInputValue: '' } } })
      expect(screen.text()).toContain('  2. Beta ✔')
      expect(focused(screen.text())).toBe('Alpha')
    },
    SLOW,
  )

  test(
    'Esc cancels and answers nothing',
    async () => {
      const { screen, log } = await show('preview', one)
      await screen.press(down, esc)
      expect(log).toEqual([{ to: 'cancel' }])
    },
    SLOW,
  )

  const tabs: Array<[string, string, Log]> = [
    ['Tab', tab, [{ to: 'tabNext' }]],
    ['Shift+Tab', SHIFT_TAB, [{ to: 'tabPrev' }]],
    ['Right', RIGHT, [{ to: 'tabNext' }]],
    ['Left', LEFT, [{ to: 'tabPrev' }]],
  ]
  for (const [name, key, expected] of tabs) {
    test(
      `${name} asks the parent to switch questions`,
      async () => {
        const { screen, log } = await show('preview', { questions: [DESIGN, COLOUR] })
        await screen.press(key)
        expect(log).toEqual(expected)
      },
      SLOW,
    )
  }

  test(
    'with no tab callbacks Tab and the arrows do nothing',
    async () => {
      const { screen, log } = await show('preview', { questions: [DESIGN], noTabCallbacks: true })
      await screen.press(tab, LEFT, RIGHT)
      expect(log).toEqual([])
      expect(focused(screen.text())).toBe('Alpha')
    },
    SLOW,
  )
})

describe('PreviewQuestionView: notes', () => {
  test(
    'n opens the notes field; what is typed is recorded key by key; Esc leaves without answering when nothing is chosen',
    async () => {
      const { screen, log } = await show('preview', one)
      expect(screen.text()).toContain('Notes: press n to add notes')
      await screen.press('n')
      expect(screen.text()).toContain('Notes: Add notes on this design…')
      await screen.press('o', 'k')
      await screen.press(esc)
      expect(log).toEqual([
        { to: 'typing', on: true },
        { to: 'record', question: 'Pick a design', updates: { textInputValue: 'o' }, multi: false },
        { to: 'record', question: 'Pick a design', updates: { textInputValue: 'ok' }, multi: false },
        { to: 'typing', on: false },
      ])
      expect(screen.text()).toContain('Notes: ok')
    },
    SLOW,
  )

  for (const [name, leave] of [['Esc', esc], ['Enter', enter]] as const) {
    test(
      `${name} leaves the notes and answers the chosen option again`,
      async () => {
        const { screen, log } = await show('preview', one)
        await screen.press('2', enter, 'n', 'x', leave)
        expect(log.slice(2)).toEqual([
          { to: 'typing', on: true },
          { to: 'record', question: 'Pick a design', updates: { textInputValue: 'x' }, multi: false },
          { to: 'typing', on: false },
          { to: 'answer', question: 'Pick a design', picked: 'Beta', typed: undefined, advance: undefined, argc: 2 },
        ])
      },
      SLOW,
    )
  }

  test(
    'while typing, digits, arrows and Tab are text or nothing: the focus stays and nothing is answered',
    async () => {
      const { screen, log } = await show('preview', { questions: [DESIGN, COLOUR] })
      await screen.press('n', '3', tab, down, RIGHT)
      expect(focused(screen.text())).toBe('Alpha')
      expect(log.filter(entry => entry.to !== 'record')).toEqual([{ to: 'typing', on: true }])
      expect(log.filter(entry => entry.to === 'record').at(-1)).toEqual({ to: 'record', question: 'Pick a design', updates: { textInputValue: '3' }, multi: false })
    },
    SLOW,
  )

  test(
    'notes already recorded are shown, and the field opens on them',
    async () => {
      const { screen, log } = await show('preview', { questions: [DESIGN], states: { 'Pick a design': { textInputValue: 'keep the logo' } } })
      expect(screen.text()).toContain('Notes: keep the logo')
      await screen.press('n', '!')
      // Where the cursor opens is Finding 4: only that the text is kept and added to is pinned.
      const last = log.at(-1) as { updates: { textInputValue: string } }
      expect(last).toMatchObject({ to: 'record', question: 'Pick a design', multi: false })
      expect([...last.updates.textInputValue].sort().join('')).toBe([...'keep the logo!'].sort().join(''))
    },
    SLOW,
  )

  test(
    'the hint names the external editor only while the notes are open',
    async () => {
      const { screen } = await show('preview', one)
      expect(screen.text()).not.toContain('edit in')
      await screen.press('n')
      expect(screen.text().replace(/\s+/g, ' ')).toMatch(/· n to add notes · \S+ to edit in Plan-editor · Esc to cancel/)
    },
    SLOW,
  )

  test(
    'ctrl+x ctrl+e in the notes hands them to the editor and records what comes back',
    async () => {
      const { screen, log } = await show('preview', { questions: [DESIGN], states: { 'Pick a design': { textInputValue: 'draft' } } })
      await screen.press('n')
      const giveBack = lendTerminalToEditor()
      try {
        await screen.press(...EXTERNAL_EDITOR)
        await screen.until(frame => frame.includes('from the editor'), 'the edited notes')
      } finally {
        giveBack()
      }
      expect(log).toEqual([
        { to: 'typing', on: true },
        { to: 'record', question: 'Pick a design', updates: { textInputValue: 'from the editor' }, multi: false },
      ])
    },
    SLOW,
  )

  test(
    'an editor that changes nothing records nothing',
    async () => {
      useEditor(':')
      try {
        const { screen, log } = await show('preview', { questions: [DESIGN], states: { 'Pick a design': { textInputValue: 'draft' } } })
        const giveBack = lendTerminalToEditor()
        try {
          await screen.press('n', ...EXTERNAL_EDITOR)
          await Bun.sleep(300)
        } finally {
          giveBack()
        }
        expect(log).toEqual([{ to: 'typing', on: true }])
      } finally {
        useEditor('printf "from the editor" > "$1"')
      }
    },
    SLOW,
  )

  test(
    'outside the notes the editor keys open nothing',
    async () => {
      const { screen, log } = await show('preview', { questions: [DESIGN], states: { 'Pick a design': { textInputValue: 'draft' } } })
      const giveBack = lendTerminalToEditor()
      try {
        await screen.press(...EXTERNAL_EDITOR)
        await Bun.sleep(300)
      } finally {
        giveBack()
      }
      expect(log).toEqual([])
      expect(screen.text()).toContain('Notes: draft')
    },
    SLOW,
  )
})

describe('PreviewQuestionView: the footer', () => {
  test(
    'down from the last option reaches "Chat about this"; Enter there asks to respond in chat',
    async () => {
      const { screen, log } = await show('preview', one)
      await screen.press(down, down, down)
      expect([focused(screen.text()), footerFocus(screen.text())]).toEqual(['Gamma', 'Chat about this'])
      await screen.press(enter)
      expect(log).toEqual([{ to: 'chat' }])
    },
    SLOW,
  )

  // [mode, keys after reaching the footer, footer row then focused, log]
  const walks: Array<[string, 'default' | 'plan', string[], string | undefined, Log]> = [
    ['up goes back to the options', 'default', [up], undefined, []],
    ['ctrl+p goes back to the options', 'default', [CTRL_P], undefined, []],
    ['outside plan mode down stays on chat', 'default', [down, CTRL_N], 'Chat about this', []],
    ['Esc cancels', 'default', [esc], 'Chat about this', [{ to: 'cancel' }]],
    ['Tab, digits and n do nothing', 'default', [tab, '1', 'n'], 'Chat about this', []],
    ['in plan mode down reaches the skip line', 'plan', [down], 'Skip interview and plan immediately', []],
    ['ctrl+n reaches it too', 'plan', [CTRL_N], 'Skip interview and plan immediately', []],
    ['Enter on the skip line ends the interview', 'plan', [down, enter], 'Skip interview and plan immediately', [{ to: 'skipInterview' }]],
    ['up from the skip line returns to chat', 'plan', [down, up, enter], 'Chat about this', [{ to: 'chat' }]],
  ]
  for (const [what, mode, keys, footer, expected] of walks) {
    test(
      `${what} (${mode} mode)`,
      async () => {
        const { screen, log } = await show('preview', one, { mode })
        await screen.press(down, down, down, ...keys)
        expect(footerFocus(screen.text())).toBe(footer as unknown as string)
        expect(log).toEqual(expected)
      },
      SLOW,
    )
  }

  test(
    'back from the footer, Enter answers the option again',
    async () => {
      const { screen, log } = await show('preview', one)
      await screen.press(down, down, down, up, enter)
      expect(log.map(entry => entry.to)).toEqual(['record', 'answer'])
      expect(log[1]).toMatchObject({ picked: 'Gamma' })
    },
    SLOW,
  )
})

describe('PreviewQuestionView: styling', () => {
  // Labels are drawn with a space in front, inside the styled run.
  const reference = async (props: React.ComponentProps<typeof Text>) => {
    const probe = await mount(<Text {...props}> SAMPLE</Text>)
    const codes = styleBefore(probe.styled(), ' SAMPLE')
    await probe.close()
    return codes
  }

  test(
    'the focused label is bold in the suggestion colour, a chosen one in the success colour, "Notes:" in the suggestion colour',
    async () => {
      const { screen } = await show('preview', { questions: [DESIGN], states: { 'Pick a design': { selectedValue: 'Beta', textInputValue: '' } } })
      const styled = screen.styled()
      expect(styleBefore(styled, ' Alpha')).toBe(await reference({ color: 'suggestion', bold: true }))
      expect(styleBefore(styled, ' Beta ✔')).toBe(await reference({ color: 'success' }))
      expect(styleBefore(styled, 'Notes:')).toBe(styleBefore(styled, '❯'))
      expect(styleBefore(styled, '❯')).toBe(await reference({ color: 'suggestion' }))
      expect(styleBefore(styled, 'press n to add notes')).toBe(await reference({ dimColor: true, italic: true }))
    },
    SLOW,
  )
})

// The parent reaches this view only through QuestionView; mounting it bare
// shows the export stands on its own.
test(
  'the export renders on its own, with the default for hideSubmitTab',
  async () => {
    const screen = await mount(
      <PreviewQuestionView
        question={DESIGN}
        questions={[DESIGN]}
        currentQuestionIndex={0}
        answers={{}}
        questionStates={{}}
        onUpdateQuestionState={() => {}}
        onAnswer={() => {}}
        onTextInputFocus={() => {}}
        onCancel={() => {}}
        onRespondToClaude={() => {}}
        onFinishPlanInterview={() => {}}
      />,
      { columns: 100, ready: frame => frame.includes('Esc to cancel') },
    )
    expect(screen.text()).toContain('✔ Submit')
  },
  SLOW,
)
