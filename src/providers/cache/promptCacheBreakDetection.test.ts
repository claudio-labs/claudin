import { describe, expect, test } from 'bun:test'
import {
  buildCacheBreakReason,
  summarizeAppliedContextEdits,
} from 'src/providers/cache/promptCacheBreakDetection.js'

// Minimal PendingChanges — everything false/empty except what a test flips.
function changes(
  overrides: Partial<Parameters<typeof buildCacheBreakReason>[0] & object>,
): NonNullable<Parameters<typeof buildCacheBreakReason>[0]> {
  return {
    systemPromptChanged: false,
    toolSchemasChanged: false,
    modelChanged: false,
    fastModeChanged: false,
    cacheControlChanged: false,
    globalCacheStrategyChanged: false,
    betasChanged: false,
    autoModeChanged: false,
    overageChanged: false,
    effortChanged: false,
    extraBodyChanged: false,
    addedToolCount: 0,
    removedToolCount: 0,
    systemCharDelta: 0,
    addedTools: [],
    removedTools: [],
    changedToolSchemas: [],
    previousModel: 'm',
    newModel: 'm',
    prevGlobalCacheStrategy: '',
    newGlobalCacheStrategy: '',
    addedBetas: [],
    removedBetas: [],
    prevEffortValue: '',
    newEffortValue: '',
    buildPrevDiffableContent: () => '',
    ...overrides,
  }
}

describe('summarizeAppliedContextEdits', () => {
  test('undefined for no envelope, an empty edit list, or zero-token edits', () => {
    expect(summarizeAppliedContextEdits(undefined)).toBeUndefined()
    expect(summarizeAppliedContextEdits(null)).toBeUndefined()
    expect(summarizeAppliedContextEdits({ applied_edits: [] })).toBeUndefined()
    expect(
      summarizeAppliedContextEdits({
        applied_edits: [
          {
            type: 'clear_tool_uses_20250919',
            cleared_input_tokens: 0,
            cleared_tool_uses: 0,
          },
        ],
      }),
    ).toBeUndefined()
  })

  test('sums tokens and tool uses across edits', () => {
    expect(
      summarizeAppliedContextEdits({
        applied_edits: [
          {
            type: 'clear_tool_uses_20250919',
            cleared_input_tokens: 41_000,
            cleared_tool_uses: 14,
          },
          {
            type: 'clear_thinking_20251015',
            cleared_input_tokens: 2_000,
            cleared_thinking_turns: 1,
          },
        ],
      }),
    ).toEqual({ clearedInputTokens: 43_000, clearedToolUses: 14 })
  })
})

describe('buildCacheBreakReason', () => {
  test('a deferred tool entering the array is named, not "server-side"', () => {
    // The discovery-driven break: before this change the deferred tools were
    // dropped from the hash, so this case read as
    // "likely server-side (prompt unchanged, <5min gap)".
    const reason = buildCacheBreakReason(
      changes({
        toolSchemasChanged: true,
        addedToolCount: 2,
        addedTools: ['EnterPlanMode', 'ExitPlanMode'],
      }),
      undefined,
      30_000,
    )
    expect(reason).toBe(
      'tools changed (+2/-0 tools: +EnterPlanMode,+ExitPlanMode)',
    )
  })

  test('caps the named tools at four', () => {
    const reason = buildCacheBreakReason(
      changes({
        toolSchemasChanged: true,
        addedToolCount: 5,
        addedTools: ['A', 'B', 'C', 'D', 'E'],
      }),
      undefined,
      30_000,
    )
    expect(reason).toBe('tools changed (+5/-0 tools: +A,+B,+C,+D,…)')
  })

  test('a server clear is labeled as such and wins over TTL guesses', () => {
    const reason = buildCacheBreakReason(
      null,
      { clearedInputTokens: 41_500, clearedToolUses: 14 },
      30_000,
    )
    expect(reason).toBe(
      'server clear_tool_uses (cleared 14 tool uses, -42k tokens, expected)',
    )
  })

  test('a server clear that coincides with a client change lists both', () => {
    const reason = buildCacheBreakReason(
      changes({ effortChanged: true, prevEffortValue: 'low', newEffortValue: 'max' }),
      { clearedInputTokens: 10_000, clearedToolUses: 3 },
      30_000,
    )
    expect(reason).toBe(
      'server clear_tool_uses (cleared 3 tool uses, -10k tokens, expected), also: effort changed (low → max)',
    )
  })

  test('unchanged prompt falls through to the TTL / server-side labels', () => {
    expect(buildCacheBreakReason(null, undefined, 30_000)).toBe(
      'likely server-side (prompt unchanged, <5min gap)',
    )
    expect(buildCacheBreakReason(null, undefined, 6 * 60_000)).toBe(
      'possible 5min TTL expiry (prompt unchanged)',
    )
    expect(buildCacheBreakReason(null, undefined, 61 * 60_000)).toBe(
      'possible 1h TTL expiry (prompt unchanged)',
    )
    expect(buildCacheBreakReason(null, undefined, null)).toBe('unknown cause')
  })
})
