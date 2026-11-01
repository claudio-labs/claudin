import { describe, expect, test } from 'bun:test'

import {
  KEY,
  mountAskDialog,
  question,
  waitForAllow,
} from 'src/permissions/ui/AskUserQuestionPermissionRequest/__testutils__/askDialogHarness.js'
import { waitForCondition } from 'src/providers/ui/__testutils__/inkHookHarness.js'

const SECOND = question({
  question: 'Which two?',
  header: 'Second',
  options: [
    { label: 'Gamma', description: 'third choice' },
    { label: 'Delta', description: 'fourth choice' },
  ],
})

const MULTI = question({ question: 'Which ones?', header: 'Many', multiSelect: true })

const PREVIEWED = question({
  question: 'Which layout?',
  header: 'Layout',
  options: [
    { label: 'Grid', description: 'a grid', preview: 'GRID-PREVIEW' },
    { label: 'List', description: 'a list', preview: 'LIST-PREVIEW' },
  ],
})

describe('AskUserQuestion dialog — single-select', () => {
  test('renders the options, the Other input and the footer', async () => {
    const dialog = await mountAskDialog([question()])
    try {
      const frame = dialog.frame()
      expect(frame).toContain('Which one?')
      expect(frame).toContain('1. Alpha')
      expect(frame).toContain('first choice')
      expect(frame).toContain('2. Beta')
      expect(frame).toContain('Type something.')
      expect(frame).toContain('4. Chat about this')
      expect(frame).toContain('Esc to cancel')
      expect(frame).not.toContain('Skip interview')
    } finally {
      await dialog.cleanup()
    }
  })

  test('Enter on the focused option submits a single question at once', async () => {
    const dialog = await mountAskDialog([question()])
    try {
      await dialog.press(KEY.enter)
      const call = await waitForAllow(dialog)
      expect(call.answers).toEqual({ 'Which one?': 'Alpha' })
      expect(call.annotations).toBeUndefined()
      expect(dialog.doneCount()).toBe(1)
    } finally {
      await dialog.cleanup()
    }
  })

  test('a digit picks that option', async () => {
    const dialog = await mountAskDialog([question()])
    try {
      await dialog.press('2')
      const call = await waitForAllow(dialog)
      expect(call.answers).toEqual({ 'Which one?': 'Beta' })
    } finally {
      await dialog.cleanup()
    }
  })

  test('text typed in Other becomes the answer', async () => {
    const dialog = await mountAskDialog([question()])
    try {
      await dialog.press(KEY.down, KEY.down, 'f', 'o', 'o')
      await dialog.waitForText('foo')
      await dialog.press(KEY.enter)
      const call = await waitForAllow(dialog)
      expect(call.answers).toEqual({ 'Which one?': 'foo' })
    } finally {
      await dialog.cleanup()
    }
  })

  test('Escape cancels the dialog', async () => {
    const dialog = await mountAskDialog([question()])
    try {
      await dialog.pressEscape()
      await waitForCondition(() => dialog.rejected.length === 1, { label: 'onReject' })
      expect(dialog.rejected).toEqual([undefined])
      expect(dialog.allowed).toEqual([])
      expect(dialog.doneCount()).toBe(1)
    } finally {
      await dialog.cleanup()
    }
  })

  test('"Chat about this" rejects with the questions asked so far', async () => {
    const dialog = await mountAskDialog([question()])
    try {
      await dialog.press(KEY.down, KEY.down, KEY.down)
      await dialog.waitForText('❯ 4. Chat about this')
      await dialog.press(KEY.up)
      await dialog.press(KEY.down, KEY.enter)
      await waitForCondition(() => dialog.rejected.length === 1, { label: 'onReject' })
      expect(dialog.rejected[0]).toContain('The user wants to clarify these questions.')
      expect(dialog.rejected[0]).toContain('- "Which one?"\n  (No answer provided)')
    } finally {
      await dialog.cleanup()
    }
  })

  test('Escape on the footer cancels', async () => {
    const dialog = await mountAskDialog([question()])
    try {
      await dialog.press(KEY.down, KEY.down, KEY.down)
      await dialog.waitForText('❯ 4. Chat about this')
      await dialog.pressEscape()
      await waitForCondition(() => dialog.rejected.length === 1, { label: 'onReject' })
      expect(dialog.rejected).toEqual([undefined])
    } finally {
      await dialog.cleanup()
    }
  })

  test('plan mode offers to skip the interview', async () => {
    const dialog = await mountAskDialog([question()], { mode: 'plan' })
    try {
      expect(dialog.frame()).toContain('5. Skip interview and plan immediately')
      await dialog.press(KEY.down, KEY.down, KEY.down, KEY.down)
      await dialog.waitForText('❯ 5. Skip interview')
      await dialog.press(KEY.enter)
      await waitForCondition(() => dialog.rejected.length === 1, { label: 'onReject' })
      expect(dialog.rejected[0]).toContain('provided enough answers for the plan interview')
    } finally {
      await dialog.cleanup()
    }
  })
})

describe('AskUserQuestion dialog — several questions', () => {
  test('answering each question leads to the review, which submits all answers', async () => {
    const dialog = await mountAskDialog([question(), SECOND])
    try {
      expect(dialog.frame()).toContain('Pick')
      expect(dialog.frame()).toContain('Second')
      await dialog.press(KEY.enter)
      await dialog.waitForText('Which two?')
      await dialog.press(KEY.down, KEY.enter)
      await dialog.waitForText('Review your answers')
      expect(dialog.frame()).toContain('Which one?')
      expect(dialog.frame()).toContain('→ Alpha')
      expect(dialog.frame()).toContain('→ Delta')
      expect(dialog.frame()).not.toContain('You have not answered all questions')
      await dialog.press(KEY.enter)
      const call = await waitForAllow(dialog)
      expect(call.answers).toEqual({ 'Which one?': 'Alpha', 'Which two?': 'Delta' })
    } finally {
      await dialog.cleanup()
    }
  })

  test('Tab and the arrows move between questions without answering', async () => {
    const dialog = await mountAskDialog([question(), SECOND])
    try {
      await dialog.press(KEY.tab)
      await dialog.waitForText('Which two?')
      await dialog.press(KEY.right)
      await dialog.waitForText('Review your answers')
      expect(dialog.frame()).toContain('You have not answered all questions')
      await dialog.press(KEY.left)
      await dialog.waitForText('Which two?')
      await dialog.press(KEY.left)
      await dialog.waitForText('Which one?')
    } finally {
      await dialog.cleanup()
    }
  })

  test('the review can cancel', async () => {
    const dialog = await mountAskDialog([question(), SECOND])
    try {
      await dialog.press(KEY.tab, KEY.tab)
      await dialog.waitForText('Review your answers')
      await dialog.press(KEY.down, KEY.enter)
      await waitForCondition(() => dialog.rejected.length === 1, { label: 'onReject' })
      expect(dialog.rejected).toEqual([undefined])
    } finally {
      await dialog.cleanup()
    }
  })
})

describe('AskUserQuestion dialog — multi-select', () => {
  test('toggled options are joined, and the review submits them', async () => {
    const dialog = await mountAskDialog([MULTI])
    try {
      expect(dialog.frame()).toContain('[ ] Alpha')
      expect(dialog.frame()).toContain('Type something')
      await dialog.press(KEY.space, KEY.down, KEY.enter)
      await dialog.waitForText('[✔] Beta')
      expect(dialog.frame()).toContain('[✔] Alpha')
      await dialog.press(KEY.down, KEY.down)
      await dialog.waitForText('❯    Submit')
      await dialog.press(KEY.enter)
      await dialog.waitForText('Review your answers')
      expect(dialog.frame()).toContain('→ Alpha, Beta')
      await dialog.press(KEY.enter)
      const call = await waitForAllow(dialog)
      expect(call.answers).toEqual({ 'Which ones?': 'Alpha, Beta' })
    } finally {
      await dialog.cleanup()
    }
  })

  test('a digit toggles that option', async () => {
    const dialog = await mountAskDialog([MULTI])
    try {
      await dialog.press('2')
      await dialog.waitForText('[✔] Beta')
      await dialog.press('2')
      await dialog.waitForText('[ ] Beta')
    } finally {
      await dialog.cleanup()
    }
  })
})

describe('AskUserQuestion dialog — the Other text is sent once', () => {
  test('a single-select Other answer is not repeated as user notes', async () => {
    const dialog = await mountAskDialog([question()])
    try {
      await dialog.press(KEY.down, KEY.down, 'f', 'o', 'o')
      await dialog.waitForText('foo')
      await dialog.press(KEY.enter)
      const call = await waitForAllow(dialog)
      expect(call.answers).toEqual({ 'Which one?': 'foo' })
      expect(call.annotations).toBeUndefined()
    } finally {
      await dialog.cleanup()
    }
  })

  test('Other text left behind for an option does not become a hidden note', async () => {
    const dialog = await mountAskDialog([question()])
    try {
      await dialog.press(KEY.down, KEY.down, 'f', 'o', 'o')
      await dialog.waitForText('foo')
      await dialog.press(KEY.up)
      await dialog.waitForText('❯ 2. Beta')
      await dialog.press(KEY.enter)
      const call = await waitForAllow(dialog)
      expect(call.answers).toEqual({ 'Which one?': 'Beta' })
      expect(call.annotations).toBeUndefined()
    } finally {
      await dialog.cleanup()
    }
  })

  test('a multi-select Other answer is not repeated as user notes', async () => {
    const dialog = await mountAskDialog([MULTI])
    try {
      await dialog.press(KEY.space, KEY.down, KEY.down, 'f', 'o', 'o')
      await dialog.waitForText('foo')
      await dialog.press(KEY.down)
      await dialog.waitForText('❯    Submit')
      await dialog.press(KEY.enter)
      await dialog.waitForText('Review your answers')
      await dialog.press(KEY.enter)
      const call = await waitForAllow(dialog)
      expect(call.annotations).toBeUndefined()
    } finally {
      await dialog.cleanup()
    }
  })
})

describe('AskUserQuestion dialog — the multi-select Other answer keeps every keystroke', () => {
  test('the last character typed reaches the answer and the review', async () => {
    const dialog = await mountAskDialog([MULTI])
    try {
      await dialog.press(KEY.space, KEY.down, KEY.down, 'f', 'o', 'o')
      await dialog.waitForText('foo')
      await dialog.press(KEY.down)
      await dialog.waitForText('❯    Submit')
      await dialog.press(KEY.enter)
      await dialog.waitForText('Review your answers')
      expect(dialog.frame()).toContain('→ Alpha, foo')
      await dialog.press(KEY.enter)
      const call = await waitForAllow(dialog)
      expect(call.answers).toEqual({ 'Which ones?': 'Alpha, foo' })
    } finally {
      await dialog.cleanup()
    }
  })
})

describe('AskUserQuestion dialog — a note on any option', () => {
  test('n notes the focused option, shown under its description', async () => {
    const dialog = await mountAskDialog([MULTI])
    try {
      expect(dialog.frame()).toContain('n to add notes')
      await dialog.press(KEY.down, 'n')
      await dialog.waitForText('Note on "Beta":')
      expect(dialog.frame()).toContain('Enter or Esc to save the note')
      await dialog.press('o', 'n', 'l', 'y', ' ', 'i', 'f', ' ', 'f', 'a', 's', 't')
      await dialog.press(KEY.enter)
      await dialog.waitForText('⎿ only if fast')
      expect(dialog.frame()).not.toContain('Note on "Beta":')
      expect(dialog.frame()).toContain('[ ] Beta')
      expect(dialog.frame()).toMatch(/2\. \[ \] Beta\s+second choice\s+⎿ only if fast/)
    } finally {
      await dialog.cleanup()
    }
  })

  test('typing in the note neither moves nor toggles the list', async () => {
    const dialog = await mountAskDialog([MULTI])
    try {
      await dialog.press('n', 'j', 'k', ' ', '2')
      await dialog.waitForText('Note on "Alpha": jk 2')
      expect(dialog.frame()).toContain('[ ] Alpha')
      expect(dialog.frame()).toContain('[ ] Beta')
    } finally {
      await dialog.cleanup()
    }
  })

  test('Escape saves the note instead of cancelling, and Tab stays on the question', async () => {
    const dialog = await mountAskDialog([question(), SECOND])
    try {
      await dialog.press('n', 'x', KEY.tab)
      await dialog.pressEscape()
      await waitForCondition(() => !dialog.frame().includes('Note on'), { label: 'note closed' })
      expect(dialog.frame()).toContain('⎿ x')
      expect(dialog.rejected).toEqual([])
      expect(dialog.frame()).toContain('Which one?')
      await dialog.pressEscape()
      await waitForCondition(() => dialog.rejected.length === 1, { label: 'onReject' })
    } finally {
      await dialog.cleanup()
    }
  })

  test('n on the Other row types into it', async () => {
    const dialog = await mountAskDialog([question()])
    try {
      await dialog.press(KEY.down, KEY.down, 'n', 'o')
      await dialog.waitForText('no')
      expect(dialog.frame()).not.toContain('Note on')
    } finally {
      await dialog.cleanup()
    }
  })

  test('a single question still submits on Enter, carrying the note', async () => {
    const dialog = await mountAskDialog([question()])
    try {
      await dialog.press(KEY.down, 'n', 'w', 'h', 'y', KEY.enter)
      await dialog.waitForText('⎿ why')
      await dialog.press(KEY.enter)
      const call = await waitForAllow(dialog)
      expect(call.answers).toEqual({ 'Which one?': 'Beta' })
      expect(call.annotations).toEqual({ 'Which one?': { notes: '"Beta": why' } })
    } finally {
      await dialog.cleanup()
    }
  })

  test('notes on picked and unpicked options both reach the model, in option order', async () => {
    const dialog = await mountAskDialog([MULTI])
    try {
      await dialog.press(KEY.down, 'n', 'n', 'o', 't', ' ', 't', 'h', 'i', 's', KEY.enter)
      await dialog.waitForText('⎿ not this')
      await dialog.press(KEY.up, KEY.space, 'n', 'y', 'e', 's', KEY.enter)
      await dialog.waitForText('⎿ yes')
      await dialog.press(KEY.down, KEY.down, KEY.down)
      await dialog.waitForText('❯    Submit')
      await dialog.press(KEY.enter)
      await dialog.waitForText('Review your answers')
      await dialog.press(KEY.enter)
      const call = await waitForAllow(dialog)
      expect(call.answers).toEqual({ 'Which ones?': 'Alpha' })
      expect(call.annotations).toEqual({
        'Which ones?': { notes: '"Alpha": yes\n"Beta": not this' },
      })
    } finally {
      await dialog.cleanup()
    }
  })

  test('the review shows the notes, including a question left unanswered', async () => {
    const dialog = await mountAskDialog([question(), SECOND])
    try {
      await dialog.press(KEY.down, 'n', 'b', 'u', 't', KEY.enter)
      await dialog.waitForText('⎿ but')
      await dialog.press(KEY.enter)
      await dialog.waitForText('Which two?')
      await dialog.press('n', 'l', 'a', 't', 'e', 'r', KEY.enter)
      await dialog.waitForText('⎿ later')
      await dialog.press(KEY.tab)
      await dialog.waitForText('Review your answers')
      const flat = dialog.frame().replace(/\s+/g, ' ')
      expect(flat).toContain('Which one? → Beta ⎿ "Beta": but')
      expect(flat).toContain('Which two? ⎿ "Gamma": later')
      await dialog.press(KEY.enter)
      const call = await waitForAllow(dialog)
      expect(call.answers).toEqual({ 'Which one?': 'Beta' })
      expect(call.annotations).toEqual({
        'Which one?': { notes: '"Beta": but' },
        'Which two?': { notes: '"Gamma": later' },
      })
    } finally {
      await dialog.cleanup()
    }
  })

  for (const columns of [80, 50, 34]) {
    test(`a long note wraps inside its option at ${columns} columns`, async () => {
      const dialog = await mountAskDialog([MULTI], { columns })
      try {
        await dialog.press(KEY.down, 'n', ...'only if it fits in the CI budget', KEY.enter)
        await waitForCondition(() => !dialog.frame().includes('Note on'), { label: 'note closed' })
        const flat = dialog.frame().replace(/\s+/g, ' ')
        expect(flat).toContain('2. [ ] Beta second choice ⎿ only if it fits in the CI budget 3. [ ] Type something')
      } finally {
        await dialog.cleanup()
      }
    })
  }

  test('n again edits the note, and clearing it removes it', async () => {
    const dialog = await mountAskDialog([question()])
    try {
      await dialog.press('n', 'a', 'b', KEY.enter)
      await dialog.waitForText('⎿ ab')
      await dialog.press('n')
      await dialog.waitForText('Note on "Alpha": ab')
      await dialog.press('\x7F', '\x7F', KEY.enter)
      await waitForCondition(() => !dialog.frame().includes('⎿'), { label: 'note removed' })
      await dialog.press(KEY.enter)
      const call = await waitForAllow(dialog)
      expect(call.annotations).toBeUndefined()
    } finally {
      await dialog.cleanup()
    }
  })
})

describe('AskUserQuestion dialog — previews', () => {
  test('shows the focused option preview and the notes line', async () => {
    const dialog = await mountAskDialog([PREVIEWED])
    try {
      expect(dialog.frame()).toContain('GRID-PREVIEW')
      expect(dialog.frame()).toContain('Notes:')
      expect(dialog.frame()).toContain('press n to add notes')
      await dialog.press(KEY.down)
      await dialog.waitForText('LIST-PREVIEW')
      await dialog.press(KEY.up)
      await dialog.waitForText('GRID-PREVIEW')
      await dialog.press('2')
      await dialog.waitForText('LIST-PREVIEW')
    } finally {
      await dialog.cleanup()
    }
  })

  test('Enter submits the selected preview', async () => {
    const dialog = await mountAskDialog([PREVIEWED])
    try {
      await dialog.press(KEY.down, KEY.enter)
      const call = await waitForAllow(dialog)
      expect(call.answers).toEqual({ 'Which layout?': 'List' })
      expect(call.annotations).toEqual({ 'Which layout?': { preview: 'LIST-PREVIEW' } })
    } finally {
      await dialog.cleanup()
    }
  })

  test('n opens the notes, and the notes reach the model', async () => {
    const dialog = await mountAskDialog([PREVIEWED])
    try {
      await dialog.press('n', 'h', 'i')
      await dialog.waitForText('Notes: hi')
      await dialog.pressEscape()
      expect(dialog.rejected).toEqual([])
      await dialog.press(KEY.enter)
      const call = await waitForAllow(dialog)
      expect(call.annotations).toEqual({
        'Which layout?': { preview: 'GRID-PREVIEW', notes: '"Grid": hi' },
      })
    } finally {
      await dialog.cleanup()
    }
  })

  test('each preview option keeps its own note', async () => {
    const dialog = await mountAskDialog([PREVIEWED])
    try {
      await dialog.press('n', 'a', KEY.enter)
      await dialog.waitForText('Notes: a')
      await dialog.press(KEY.down)
      await dialog.waitForText('LIST-PREVIEW')
      expect(dialog.frame()).toContain('press n to add notes')
      await dialog.press('n', 'b', KEY.enter)
      await dialog.waitForText('Notes: b')
      await dialog.press(KEY.up)
      await dialog.waitForText('Notes: a')
      await dialog.press(KEY.down, KEY.enter)
      const call = await waitForAllow(dialog)
      expect(call.answers).toEqual({ 'Which layout?': 'List' })
      expect(call.annotations).toEqual({
        'Which layout?': { preview: 'LIST-PREVIEW', notes: '"Grid": a\n"List": b' },
      })
    } finally {
      await dialog.cleanup()
    }
  })

  test('the footer chats, and Escape outside the notes cancels', async () => {
    const dialog = await mountAskDialog([PREVIEWED], { mode: 'plan' })
    try {
      await dialog.press(KEY.down, KEY.down)
      await dialog.waitForText('❯ Chat about this')
      await dialog.press(KEY.down)
      await dialog.waitForText('❯ Skip interview')
      await dialog.press(KEY.up, KEY.up)
      await dialog.waitForText('❯ 2. List')
      await dialog.pressEscape()
      await waitForCondition(() => dialog.rejected.length === 1, { label: 'onReject' })
      expect(dialog.rejected).toEqual([undefined])
    } finally {
      await dialog.cleanup()
    }
  })

  test('Enter on "Chat about this" rejects with the clarify feedback', async () => {
    const dialog = await mountAskDialog([PREVIEWED])
    try {
      await dialog.press(KEY.down, KEY.down, KEY.enter)
      await waitForCondition(() => dialog.rejected.length === 1, { label: 'onReject' })
      expect(dialog.rejected[0]).toContain('The user wants to clarify these questions.')
    } finally {
      await dialog.cleanup()
    }
  })
})
