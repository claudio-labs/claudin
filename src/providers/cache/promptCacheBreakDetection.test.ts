import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  _getPendingMessageMutationForTesting,
  buildCacheBreakReason,
  checkResponseForCacheBreak,
  recordPromptState,
  recordRenderedMessages,
  resetPromptCacheBreakDetection,
  summarizeAppliedContextEdits,
} from 'src/providers/cache/promptCacheBreakDetection.js'
import {
  getCurrentTurnCacheBreaks,
  resetSessionCacheStats,
} from 'src/providers/cache/cacheStatsTracker.js'

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

  test('a mutated message is named instead of falling through to "server-side"', () => {
    const reason = buildCacheBreakReason(null, undefined, 30_000, {
      index: 17,
      total: 230,
      role: 'user',
      blockTypes: 'tool_result',
      prevJson: '',
      newJson: '',
    })
    expect(reason).toBe(
      'messages mutated at 17/230 (user: tool_result) — client-side prefix rewrite',
    )
  })

  test('a server clear still wins over a message mutation', () => {
    const reason = buildCacheBreakReason(
      null,
      { clearedInputTokens: 10_000, clearedToolUses: 3 },
      30_000,
      { index: 1, total: 5, role: 'user', blockTypes: 'tool_result', prevJson: '', newJson: '' },
    )
    expect(reason).toBe(
      'server clear_tool_uses (cleared 3 tool uses, -10k tokens, expected)',
    )
  })
})

const SOURCE = 'repl_main_thread' as const

function user(text: string, cacheControl = false): BetaMessageParam {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text,
        ...(cacheControl ? { cache_control: { type: 'ephemeral' as const } } : {}),
      },
    ],
  }
}

function toolResult(id: string, text: string): BetaMessageParam {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: text }],
  }
}

function assistant(text: string): BetaMessageParam {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

function prime(): void {
  recordPromptState({
    system: [{ type: 'text', text: 'sys' }],
    toolSchemas: [],
    querySource: SOURCE,
    model: 'claude-opus-5',
  })
}

describe('recordRenderedMessages', () => {
  beforeEach(() => {
    resetPromptCacheBreakDetection()
    resetSessionCacheStats()
  })

  test('a pure append is not a mutation', () => {
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('a'), assistant('b')])
    recordRenderedMessages(SOURCE, undefined, [
      user('a'),
      assistant('b'),
      user('c'),
    ])
    expect(_getPendingMessageMutationForTesting(SOURCE)).toBeNull()
  })

  test('a cache_control marker moving between turns is not a mutation', () => {
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('a', true), assistant('b')])
    recordRenderedMessages(SOURCE, undefined, [
      user('a'),
      assistant('b'),
      user('c', true),
    ])
    expect(_getPendingMessageMutationForTesting(SOURCE)).toBeNull()
  })

  test('the first message whose bytes changed is named with role and block types', () => {
    prime()
    const history = [
      user('ask'),
      assistant('reading'),
      toolResult('t1', 'full result'),
      assistant('done'),
    ]
    recordRenderedMessages(SOURCE, undefined, history)
    recordRenderedMessages(SOURCE, undefined, [
      history[0]!,
      history[1]!,
      toolResult('t1', '[clipped]'),
      history[3]!,
      user('next'),
    ])
    const mutation = _getPendingMessageMutationForTesting(SOURCE)
    expect(mutation).toMatchObject({
      index: 2,
      total: 4,
      role: 'user',
      blockTypes: 'tool_result',
    })
    expect(mutation?.prevJson).toContain('full result')
    expect(mutation?.newJson).toContain('[clipped]')
  })

  test('an untracked source records nothing', () => {
    recordRenderedMessages('speculation', undefined, [user('a')])
    recordRenderedMessages('speculation', undefined, [user('b')])
    expect(_getPendingMessageMutationForTesting('speculation')).toBeNull()
  })

  test('a read drop after a mutation lands on the turn line with the message named', async () => {
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('a'), toolResult('t1', 'x')])
    // First response establishes the baseline read.
    await checkResponseForCacheBreak(SOURCE, 205_000, 0, [])
    prime()
    recordRenderedMessages(SOURCE, undefined, [
      user('a'),
      toolResult('t1', 'y'),
      user('b'),
    ])
    await checkResponseForCacheBreak(SOURCE, 25_853, 182_825, [])
    expect(getCurrentTurnCacheBreaks()).toEqual([
      'messages mutated at 1/2 (user: tool_result) — client-side prefix rewrite — read 205k→25.9k, rewrote 182.8k',
    ])
    // The mutation is consumed: a healthy next response records nothing more.
    await checkResponseForCacheBreak(SOURCE, 208_678, 3_728, [])
    expect(getCurrentTurnCacheBreaks()).toHaveLength(1)
  })

  test('a small drop stays below the threshold and records no break', async () => {
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('a')])
    await checkResponseForCacheBreak(SOURCE, 100_000, 0, [])
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('a'), user('b')])
    await checkResponseForCacheBreak(SOURCE, 99_000, 1_000, [])
    expect(getCurrentTurnCacheBreaks()).toEqual([])
  })
})
