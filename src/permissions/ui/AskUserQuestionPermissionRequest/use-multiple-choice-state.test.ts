import { describe, expect, test } from 'bun:test'

import {
  INITIAL_STATE,
  reducer,
} from 'src/permissions/ui/AskUserQuestionPermissionRequest/use-multiple-choice-state.js'

describe('multiple-choice reducer', () => {
  test('next and prev move the index and leave text-input mode', () => {
    const inInput = { ...INITIAL_STATE, isInTextInput: true }
    const next = reducer(inInput, { type: 'next-question' })
    expect(next.currentQuestionIndex).toBe(1)
    expect(next.isInTextInput).toBe(false)

    const back = reducer({ ...next, isInTextInput: true }, { type: 'prev-question' })
    expect(back.currentQuestionIndex).toBe(0)
    expect(back.isInTextInput).toBe(false)
  })

  test('prev never goes below the first question', () => {
    expect(reducer(INITIAL_STATE, { type: 'prev-question' }).currentQuestionIndex).toBe(0)
  })

  test('update-question-state seeds an empty multi-select and keeps earlier fields', () => {
    const multi = reducer(INITIAL_STATE, {
      type: 'update-question-state',
      questionText: 'Q?',
      updates: {},
      isMultiSelect: true,
    })
    expect(multi.questionStates['Q?']).toEqual({ selectedValue: [], textInputValue: '' })

    const typed = reducer(multi, {
      type: 'update-question-state',
      questionText: 'Q?',
      updates: { textInputValue: 'foo' },
      isMultiSelect: true,
    })
    expect(typed.questionStates['Q?']).toEqual({ selectedValue: [], textInputValue: 'foo' })

    const picked = reducer(typed, {
      type: 'update-question-state',
      questionText: 'Q?',
      updates: { selectedValue: ['A'] },
      isMultiSelect: true,
    })
    expect(picked.questionStates['Q?']).toEqual({ selectedValue: ['A'], textInputValue: 'foo' })
  })

  test('update-question-state leaves a single-select unselected', () => {
    const single = reducer(INITIAL_STATE, {
      type: 'update-question-state',
      questionText: 'Q?',
      updates: {},
      isMultiSelect: false,
    })
    expect(single.questionStates['Q?']).toEqual({ selectedValue: undefined, textInputValue: '' })
  })

  test('set-answer records the answer and advances only when asked', () => {
    const stay = reducer(INITIAL_STATE, {
      type: 'set-answer',
      questionText: 'Q?',
      answer: 'A',
      shouldAdvance: false,
    })
    expect(stay.answers).toEqual({ 'Q?': 'A' })
    expect(stay.currentQuestionIndex).toBe(0)

    const advance = reducer(
      { ...stay, isInTextInput: true },
      { type: 'set-answer', questionText: 'R?', answer: 'B', shouldAdvance: true },
    )
    expect(advance.answers).toEqual({ 'Q?': 'A', 'R?': 'B' })
    expect(advance.currentQuestionIndex).toBe(1)
    expect(advance.isInTextInput).toBe(false)
  })

  test('set-text-input-mode toggles the flag', () => {
    const on = reducer(INITIAL_STATE, { type: 'set-text-input-mode', isInInput: true })
    expect(on.isInTextInput).toBe(true)
    expect(reducer(on, { type: 'set-text-input-mode', isInInput: false }).isInTextInput).toBe(
      false,
    )
  })
})
