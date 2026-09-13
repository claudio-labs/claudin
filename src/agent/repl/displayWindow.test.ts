import { describe, expect, test } from 'bun:test'

import {
  applyDisplayWindow,
  MAX_DISPLAY_MESSAGES,
} from 'src/agent/repl/displayWindow.js'

function history(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `m${i}`)
}

describe('applyDisplayWindow', () => {
  test('hands back the whole timeline when the window is off', () => {
    const messages = history(MAX_DISPLAY_MESSAGES * 10)

    // Same reference, not a copy: Messages is memoized on prop identity.
    expect(applyDisplayWindow(messages, false)).toBe(messages)
  })

  test('keeps the reference when the history fits the window', () => {
    const messages = history(MAX_DISPLAY_MESSAGES)

    expect(applyDisplayWindow(messages, true)).toBe(messages)
  })

  test('cuts to the most recent messages when the window is on', () => {
    const messages = history(MAX_DISPLAY_MESSAGES + 1)

    const windowed = applyDisplayWindow(messages, true)
    expect(windowed).toHaveLength(MAX_DISPLAY_MESSAGES)
    // The oldest is what goes; the newest must survive.
    expect(windowed[0]).toBe('m1')
    expect(windowed.at(-1)).toBe(`m${MAX_DISPLAY_MESSAGES}`)
  })
})
