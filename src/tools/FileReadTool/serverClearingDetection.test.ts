import { describe, expect, test } from 'bun:test'
import { assistantWithAppliedEdits as assistantWithEdits } from './__test-helpers__/contextManagementFixtures.js'
import { hasServerClearedToolUses } from './serverClearingDetection.js'

describe('hasServerClearedToolUses', () => {
  test('empty transcript → false', () => {
    expect(hasServerClearedToolUses([])).toBe(false)
  })

  test('assistant message without context_management → false', () => {
    expect(hasServerClearedToolUses([assistantWithEdits(undefined)])).toBe(
      false,
    )
  })

  test('context_management null → false', () => {
    const m = {
      type: 'assistant',
      message: { context_management: null },
    }
    expect(hasServerClearedToolUses([m])).toBe(false)
  })

  test('applied_edits empty → false', () => {
    expect(hasServerClearedToolUses([assistantWithEdits([])])).toBe(false)
  })

  test('clear_thinking edits do not count — they leave tool_results alone', () => {
    const m = assistantWithEdits([{ type: 'clear_thinking_20251015' }])
    expect(hasServerClearedToolUses([m])).toBe(false)
  })

  test('clear_tool_uses with cleared_tool_uses: 0 → false (nothing wiped)', () => {
    const m = assistantWithEdits([
      { type: 'clear_tool_uses_20250919', cleared_tool_uses: 0 },
    ])
    expect(hasServerClearedToolUses([m])).toBe(false)
  })

  test('clear_tool_uses with a non-zero count → true', () => {
    const m = assistantWithEdits([
      { type: 'clear_tool_uses_20250919', cleared_tool_uses: 3 },
    ])
    expect(hasServerClearedToolUses([m])).toBe(true)
  })

  test('clear_tool_uses with a missing count → true (fail toward correctness)', () => {
    const m = assistantWithEdits([{ type: 'clear_tool_uses_20250919' }])
    expect(hasServerClearedToolUses([m])).toBe(true)
  })

  test('future clear_tool_uses revisions match by prefix', () => {
    const m = assistantWithEdits([
      { type: 'clear_tool_uses_20991231', cleared_tool_uses: 1 },
    ])
    expect(hasServerClearedToolUses([m])).toBe(true)
  })

  test('evidence early in the transcript is found despite later benign messages', () => {
    const messages = [
      assistantWithEdits([
        { type: 'clear_tool_uses_20250919', cleared_tool_uses: 2 },
      ]),
      ...Array.from({ length: 20 }, () => assistantWithEdits(undefined)),
      { type: 'user', message: { content: 'hi' } },
    ]
    expect(hasServerClearedToolUses(messages)).toBe(true)
  })

  test('non-assistant and malformed entries are skipped safely', () => {
    const messages = [
      null,
      undefined,
      42,
      'text',
      { type: 'user' },
      { type: 'assistant' }, // no message
      { type: 'assistant', message: {} },
      { type: 'assistant', message: { context_management: {} } },
      {
        type: 'assistant',
        message: { context_management: { applied_edits: 'not-an-array' } },
      },
      { type: 'assistant', message: { context_management: { applied_edits: [null, {}] } } },
    ]
    expect(hasServerClearedToolUses(messages)).toBe(false)
  })
})
