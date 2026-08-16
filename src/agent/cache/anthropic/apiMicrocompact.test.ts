import { afterAll, beforeAll, describe, test, expect } from 'bun:test'
import { getAPIContextManagement } from 'src/agent/cache/anthropic/apiMicrocompact.js'
import { _resetCacheProfileForTesting } from 'src/agent/cache/cacheProfile.js'

// Every assertion below is profile-gated: `clear_thinking` only appears under
// `historyRedactionEnabled`, which is true for aggressive and false for retain.
// Left unpinned, the mode is `auto`, which resolves through
// `tryGetActiveProvider()` — so these tests passed or failed depending on
// whether some EARLIER file in the run had loaded a real provider profile from
// the developer's own ~/.claudin/settings.json. Six scripts under
// scripts/bench/tokens/ do exactly that, and CI has no settings file to load,
// which is why it only ever showed up locally.
const originalProfile = process.env.CLAUDIN_CACHE_PROFILE

beforeAll(() => {
  process.env.CLAUDIN_CACHE_PROFILE = 'aggressive'
  _resetCacheProfileForTesting()
})

afterAll(() => {
  if (originalProfile === undefined) {
    delete process.env.CLAUDIN_CACHE_PROFILE
  } else {
    process.env.CLAUDIN_CACHE_PROFILE = originalProfile
  }
  _resetCacheProfileForTesting()
})

describe('getAPIContextManagement', () => {
  test('returns undefined when thinking inactive', () => {
    const result = getAPIContextManagement({ hasThinking: false })
    expect(result).toBeUndefined()
  })

  test('keep: thinking_turns value:2 when hasThinking=true and redactThinking=false', () => {
    const result = getAPIContextManagement({
      hasThinking: true,
      isRedactThinkingActive: false,
      clearAllThinking: false,
    })
    expect(result).toBeDefined()
    const thinkingEdit = result!.edits.find(
      e => e.type === 'clear_thinking_20251015',
    )
    expect(thinkingEdit).toBeDefined()
    expect(thinkingEdit).toEqual({
      type: 'clear_thinking_20251015',
      keep: { type: 'thinking_turns', value: 2 },
    })
  })

  test('keep: thinking_turns value:1 when clearAllThinking=true', () => {
    const result = getAPIContextManagement({
      hasThinking: true,
      isRedactThinkingActive: false,
      clearAllThinking: true,
    })
    expect(result).toBeDefined()
    const thinkingEdit = result!.edits.find(
      e => e.type === 'clear_thinking_20251015',
    )
    expect(thinkingEdit).toEqual({
      type: 'clear_thinking_20251015',
      keep: { type: 'thinking_turns', value: 1 },
    })
  })

  test('skips thinking strategy when isRedactThinkingActive=true', () => {
    const result = getAPIContextManagement({
      hasThinking: true,
      isRedactThinkingActive: true,
      clearAllThinking: false,
    })
    // No thinking edit should appear; result may be undefined or have no thinking edit.
    if (result !== undefined) {
      const thinkingEdit = result.edits.find(
        e => e.type === 'clear_thinking_20251015',
      )
      expect(thinkingEdit).toBeUndefined()
    } else {
      expect(result).toBeUndefined()
    }
  })
})
