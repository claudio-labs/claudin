import { describe, test, expect } from 'bun:test'
import { getAPIContextManagement } from './apiMicrocompact.js'

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
