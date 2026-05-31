import { describe, expect, test } from 'bun:test'
import {
  detectSerialReadPattern,
  markFiredAndCheck,
} from './serialReadNudge.js'

function asstReadWithText(text: string | null) {
  const content: Array<{ type: string; name?: string; text?: string }> = []
  if (text !== null) content.push({ type: 'text', text })
  content.push({ type: 'tool_use', name: 'Read' })
  return { type: 'assistant', message: { role: 'assistant', content } }
}

function asstReadAndOther() {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'narration' },
        { type: 'tool_use', name: 'Read' },
        { type: 'tool_use', name: 'Bash' },
      ],
    },
  }
}

const USER_MSG = { type: 'user', message: { role: 'user', content: [] } }

describe('detectSerialReadPattern', () => {
  test('triggers on 3 consecutive single-Read turns with narration', () => {
    const msgs = [
      USER_MSG,
      asstReadWithText('Looking at file A...'),
      USER_MSG,
      asstReadWithText('Now file B...'),
      USER_MSG,
      asstReadWithText('Now file C...'),
    ]
    expect(detectSerialReadPattern(msgs)).toBe(true)
  })

  test('does NOT trigger on 3 single-Read turns without any narration', () => {
    const msgs = [
      USER_MSG,
      asstReadWithText(null),
      USER_MSG,
      asstReadWithText(null),
      USER_MSG,
      asstReadWithText(null),
    ]
    expect(detectSerialReadPattern(msgs)).toBe(false)
  })

  test('does NOT trigger when a Read turn is interleaved with a non-Read tool', () => {
    const msgs = [
      USER_MSG,
      asstReadWithText('a'),
      USER_MSG,
      asstReadAndOther(), // has Read AND Bash → disqualifies that turn
      USER_MSG,
      asstReadWithText('c'),
    ]
    // Only 2 qualifying single-Read turns → below threshold
    expect(detectSerialReadPattern(msgs)).toBe(false)
  })

  test('does NOT trigger with fewer than 3 assistant messages', () => {
    const msgs = [USER_MSG, asstReadWithText('a'), USER_MSG, asstReadWithText('b')]
    expect(detectSerialReadPattern(msgs)).toBe(false)
  })

  test('respects the lookback window (older Reads do not count)', () => {
    const msgs = [
      asstReadWithText('old1'),
      asstReadWithText('old2'),
      asstReadWithText('old3'),
      // 4 newer assistant turns, none of which qualify
      asstReadAndOther(),
      asstReadAndOther(),
      asstReadAndOther(),
      asstReadAndOther(),
    ]
    expect(detectSerialReadPattern(msgs)).toBe(false)
  })
})

describe('markFiredAndCheck', () => {
  test('returns true the first time, false on subsequent calls (per-turn guard)', () => {
    const messages: unknown[] = []
    expect(markFiredAndCheck(messages)).toBe(true)
    expect(markFiredAndCheck(messages)).toBe(false)
    expect(markFiredAndCheck(messages)).toBe(false)
  })

  test('distinct messages arrays are tracked independently', () => {
    const a: unknown[] = []
    const b: unknown[] = []
    expect(markFiredAndCheck(a)).toBe(true)
    expect(markFiredAndCheck(b)).toBe(true)
    expect(markFiredAndCheck(a)).toBe(false)
    expect(markFiredAndCheck(b)).toBe(false)
  })
})
