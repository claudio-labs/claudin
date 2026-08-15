import { afterAll, describe, expect, mock, test } from 'bun:test'
import * as realDiscovery from 'src/providers/model/openaiModelDiscovery.ts'

// Control the value getOpenAIContextWindow reads from the provider's /models
// discovery. Spreading the real module keeps every other export intact so this
// mock is leak-safe across the suite; resetting to undefined in afterAll makes
// the leaked getter behave exactly like the real default (nothing discovered).
let mockDiscovered: number | undefined
mock.module('./openaiModelDiscovery.js', () => ({
  ...realDiscovery,
  getDiscoveredContextWindow: (_model: string) => mockDiscovered,
}))

afterAll(() => {
  mockDiscovered = undefined
})

// Imported after the mock is registered. getOpenAIContextWindow only requires
// the discovery module lazily, so the mock is in place before the first call.
import { getOpenAIContextWindow } from 'src/providers/model/openaiContextWindows.ts'

describe('getOpenAIContextWindow — discovery precedence', () => {
  test('prefers the provider-reported window over the hardcoded table', () => {
    // gpt-4o is 128k in the hardcoded table. A router serving a truncated
    // 32k variant under the same id must win via its own /models report.
    mockDiscovered = 32_000
    expect(getOpenAIContextWindow('gpt-4o')).toBe(32_000)
  })

  test('falls back to the hardcoded table when the provider reports nothing', () => {
    mockDiscovered = undefined
    // gpt-4o's curated 128k entry still resolves (regression guard for the
    // real-OpenAI case, whose /models endpoint omits context_length).
    expect(getOpenAIContextWindow('gpt-4o')).toBe(128_000)
  })
})
