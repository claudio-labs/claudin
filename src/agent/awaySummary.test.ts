import { afterEach, describe, expect, test } from 'bun:test'

import {
  generateAwaySummary,
  isAwaySummaryEnabled,
  sanitizeAwaySummary,
} from 'src/agent/awaySummary.ts'

describe('isAwaySummaryEnabled', () => {
  const ENV = 'CLAUDIN_AWAY_SUMMARY'
  const saved = process.env[ENV]
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV]
    else process.env[ENV] = saved
  })

  test('on by default, CLAUDIN_AWAY_SUMMARY=0 turns it off', () => {
    delete process.env[ENV]
    expect(isAwaySummaryEnabled()).toBe(true)
    process.env[ENV] = '0'
    expect(isAwaySummaryEnabled()).toBe(false)
  })
})

test('generateAwaySummary has nothing to recap in an empty transcript', async () => {
  expect(await generateAwaySummary([], new AbortController().signal)).toBeNull()
})

describe('sanitizeAwaySummary', () => {
  test('passes a clean recap through untouched', () => {
    const recap = "You're evaluating fork vs named agents. Next step: decide."
    expect(sanitizeAwaySummary(recap)).toBe(recap)
  })

  test('drops a leading <thinking> block and keeps the recap', () => {
    const leaked = `<thinking>
The user is asking me to write a brief summary of what we've been discussing.
Let me write 1-3 short sentences.
</thinking>

You're evaluating fork vs named agents. Next step: decide.`
    expect(sanitizeAwaySummary(leaked)).toBe(
      "You're evaluating fork vs named agents. Next step: decide.",
    )
  })

  test('returns null when the response is nothing but reasoning', () => {
    expect(sanitizeAwaySummary('<thinking>only reasoning</thinking>')).toBeNull()
  })

  test('returns null when an unterminated block eats the whole body', () => {
    expect(sanitizeAwaySummary('<think>\nreasoning that never closed')).toBeNull()
  })

  test('passes null through', () => {
    expect(sanitizeAwaySummary(null)).toBeNull()
  })
})
