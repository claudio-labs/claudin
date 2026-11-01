import { describe, expect, test } from 'bun:test'

import {
  formatOptionNotes,
  normalizeNote,
  noteLines,
} from 'src/tools/AskUserQuestionTool/optionNotes.js'

const QUESTION = {
  question: 'Which levels?',
  header: 'Tests',
  options: [
    { label: 'Handler', description: 'h' },
    { label: 'Unit', description: 'u' },
    { label: 'Live', description: 'l' },
  ],
  multiSelect: true,
}

describe('normalizeNote', () => {
  test('collapses line breaks and whitespace runs, and trims', () => {
    expect(normalizeNote('  only if\n\nit   fits\tin CI  ')).toBe('only if it fits in CI')
  })
})

describe('formatOptionNotes', () => {
  test('no notes at all is undefined', () => {
    expect(formatOptionNotes(QUESTION, undefined)).toBeUndefined()
    expect(formatOptionNotes(QUESTION, {})).toBeUndefined()
  })

  test('one line per commented option, in option order, not entry order', () => {
    expect(
      formatOptionNotes(QUESTION, { Live: 'only if it fits in CI', Handler: 'reuse the upstream' }),
    ).toBe('"Handler": reuse the upstream\n"Live": only if it fits in CI')
  })

  test('blank notes and labels the question does not have are dropped', () => {
    expect(formatOptionNotes(QUESTION, { Unit: '   ', Gone: 'stale' })).toBeUndefined()
    expect(formatOptionNotes(QUESTION, { Unit: ' fast \n one ', Gone: 'stale' })).toBe(
      '"Unit": fast one',
    )
  })
})

describe('noteLines', () => {
  test('splits a formatted string and skips blank lines', () => {
    expect(noteLines('"Handler": a\n\n"Live": b')).toEqual(['"Handler": a', '"Live": b'])
  })

  test('a free-text note from an older transcript is one line', () => {
    expect(noteLines('preferred')).toEqual(['preferred'])
  })

  test('nothing gives no lines', () => {
    expect(noteLines(undefined)).toEqual([])
    expect(noteLines('')).toEqual([])
  })
})
