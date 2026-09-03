import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import type { Message } from 'src/shared/types/message.js'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'

// We test the exported collectCompactableToolIds behavior indirectly via
// the public microcompactMessages + time-based path. But first we need to
// verify the core predicate: MCP tools (prefixed 'mcp__') should be
// compactable alongside the built-in tool set.

// Import internals we can test
import { evaluateTimeBasedTrigger } from 'src/agent/compact/microCompact.js'

/**
 * Helper: build a minimal assistant message with a tool_use block.
 */
function assistantWithToolUse(toolName: string, toolId: string): Message {
  return createAssistantMessage({
    content: [
      {
        type: 'tool_use' as const,
        id: toolId,
        name: toolName,
        input: {},
      },
    ],
  })
}

/**
 * Helper: build a user message with a tool_result block.
 */
function userWithToolResult(toolId: string, output: string): Message {
  return createUserMessage({
    content: [
      {
        type: 'tool_result' as const,
        tool_use_id: toolId,
        content: output,
      },
    ],
  })
}

describe('microCompact MCP tool compaction', () => {
  // We can't easily unit-test the private isCompactableTool directly,
  // but we can test the full time-based microcompact path which exercises
  // collectCompactableToolIds → isCompactableTool under the hood.
  // The time-based path is the simplest to trigger: it content-clears
  // old tool results when the gap since last assistant message exceeds
  // the threshold.

  // However, evaluateTimeBasedTrigger depends on config (GrowthBook).
  // So instead, let's test the observable behavior by importing the
  // microcompactMessages function and checking that MCP tool_use blocks
  // are collected.

  // Since collectCompactableToolIds is not exported, we test the predicate
  // behavior by verifying that the module loads without error and that
  // built-in and MCP tools are treated consistently.

  test('module exports load correctly', async () => {
    const mod = await import('src/agent/compact/microCompact.js')
    expect(mod.microcompactMessages).toBeFunction()
    expect(mod.estimateMessageTokens).toBeFunction()
    expect(mod.evaluateTimeBasedTrigger).toBeFunction()
  })

  test('estimateMessageTokens counts MCP tool_use blocks', async () => {
    const { estimateMessageTokens } = await import('src/agent/compact/microCompact.js')

    const builtinMessages: Message[] = [
      assistantWithToolUse('Read', 'tool-builtin-1'),
      userWithToolResult('tool-builtin-1', 'file contents here'),
    ]

    const mcpMessages: Message[] = [
      assistantWithToolUse('mcp__github__get_file_contents', 'tool-mcp-1'),
      userWithToolResult('tool-mcp-1', 'file contents here'),
    ]

    const builtinTokens = estimateMessageTokens(builtinMessages)
    const mcpTokens = estimateMessageTokens(mcpMessages)

    // Both should produce non-zero estimates
    expect(builtinTokens).toBeGreaterThan(0)
    expect(mcpTokens).toBeGreaterThan(0)

    // The tool_result content is identical, so token estimates should be
    // similar (tool_use name differs slightly, so not exactly equal)
    expect(Math.abs(builtinTokens - mcpTokens)).toBeLessThan(50)
  })

  test('microcompactMessages processes MCP tools without error', async () => {
    const { microcompactMessages } = await import('src/agent/compact/microCompact.js')

    const messages: Message[] = [
      assistantWithToolUse('mcp__slack__send_message', 'tool-mcp-2'),
      userWithToolResult('tool-mcp-2', 'Message sent successfully'),
      assistantWithToolUse('mcp__github__create_pull_request', 'tool-mcp-3'),
      userWithToolResult('tool-mcp-3', JSON.stringify({ number: 42, url: 'https://github.com/org/repo/pull/42' })),
    ]

    // Should not throw — MCP tools should be handled gracefully
    const result = await microcompactMessages(messages)
    expect(result).toBeDefined()
    expect(result.messages).toBeDefined()
    expect(result.messages.length).toBe(messages.length)
  })

  test('microcompactMessages processes mixed built-in and MCP tools', async () => {
    const { microcompactMessages } = await import('src/agent/compact/microCompact.js')

    const messages: Message[] = [
      assistantWithToolUse('Read', 'tool-read-1'),
      userWithToolResult('tool-read-1', 'some file content'),
      assistantWithToolUse('mcp__playwright__screenshot', 'tool-mcp-4'),
      userWithToolResult('tool-mcp-4', 'base64-encoded-screenshot-data'.repeat(100)),
      assistantWithToolUse('Bash', 'tool-bash-1'),
      userWithToolResult('tool-bash-1', 'command output'),
    ]

    const result = await microcompactMessages(messages)
    expect(result).toBeDefined()
    expect(result.messages.length).toBe(messages.length)
  })
})

// ============================================================================
// Size-driven stable-stub trigger
// ============================================================================

const mockSizeState = {
  effectiveWindow: 100_000,
}

const realAutoCompact = { ...(await import('src/agent/compact/autoCompact.js')) }
const realModel = { ...(await import('src/providers/model/model.js')) }

mock.module('./autoCompact.js', () => ({
  ...realAutoCompact,
  getEffectiveContextWindowSize: () => mockSizeState.effectiveWindow,
}))

mock.module('src/providers/model/model.js', () => ({
  ...realModel,
  getMainLoopModel: () => 'claude-sonnet-4',
}))

describe('relief policy — window lane via microcompactMessages', () => {
  const MAIN = 'repl_main_thread' as never
  const savedKill = process.env.CLAUDIN_DISABLE_RELIEF_POLICY
  const savedProfile = process.env.CLAUDIN_CACHE_PROFILE

  beforeEach(async () => {
    const { resetClippedIds } = await import('src/agent/compact/stableStubState.js')
    const { _resetCacheProfileForTesting } = await import('src/agent/cache/cacheProfile.js')
    resetClippedIds()
    mockSizeState.effectiveWindow = 100_000
    delete process.env.CLAUDIN_DISABLE_RELIEF_POLICY
    // Pin the profile: `auto` resolves through the machine's active provider.
    process.env.CLAUDIN_CACHE_PROFILE = 'retain'
    _resetCacheProfileForTesting()
  })

  afterEach(async () => {
    const { resetClippedIds } = await import('src/agent/compact/stableStubState.js')
    const { _resetCacheProfileForTesting } = await import('src/agent/cache/cacheProfile.js')
    resetClippedIds()
    if (savedKill === undefined) delete process.env.CLAUDIN_DISABLE_RELIEF_POLICY
    else process.env.CLAUDIN_DISABLE_RELIEF_POLICY = savedKill
    if (savedProfile === undefined) delete process.env.CLAUDIN_CACHE_PROFILE
    else process.env.CLAUDIN_CACHE_PROFILE = savedProfile
    _resetCacheProfileForTesting()
  })

  // No assistant carries usage here, so tokenCountWithEstimation falls back
  // to the estimate of the (stubbed) history — the same number the policy
  // sees on the first request of a resumed session.
  function buildHeavyHistory(numExchanges: number, perResultChars: number): Message[] {
    const out: Message[] = []
    for (let i = 0; i < numExchanges; i++) {
      out.push(assistantWithToolUse('Read', `toolu_${i}`))
      out.push(userWithToolResult(`toolu_${i}`, 'A'.repeat(perResultChars)))
    }
    return out
  }

  function clippedInOrder(clipped: ReadonlySet<string>, total: number): string[] {
    const ids: string[] = []
    for (let i = 0; i < total; i++) if (clipped.has(`toolu_${i}`)) ids.push(`toolu_${i}`)
    return ids
  }

  test('below the trigger: no new clipped ids', async () => {
    const { microcompactMessages } = await import('src/agent/compact/microCompact.js')
    const { getClippedIds } = await import('src/agent/compact/stableStubState.js')
    // Tiny conversation, far below 75% of 100k tokens
    const messages = buildHeavyHistory(2, 100)
    await microcompactMessages(messages, undefined, MAIN)
    expect(getClippedIds().size).toBe(0)
  })

  test('no querySource (analysis callers): never mutates the clipped set', async () => {
    const { microcompactMessages } = await import('src/agent/compact/microCompact.js')
    const { getClippedIds } = await import('src/agent/compact/stableStubState.js')
    mockSizeState.effectiveWindow = 20_000
    await microcompactMessages(buildHeavyHistory(20, 5_000))
    expect(getClippedIds().size).toBe(0)
  })

  test('above the trigger: clips OLDEST first, only as much as the band asks, keeps the last 2 turns', async () => {
    const { microcompactMessages } = await import('src/agent/compact/microCompact.js')
    const { getClippedIds } = await import('src/agent/compact/stableStubState.js')
    // 20 exchanges × 5k chars ≈ 25-30k estimated tokens against a 40k
    // window: trigger 30k (0.75 × 40k, below the autocompact cap), band
    // min(60k, 30% × 30k) = 9k → target 21k → free a handful of results,
    // each worth ~1.2k minus the retained 2k-char head.
    mockSizeState.effectiveWindow = 40_000
    const messages = buildHeavyHistory(24, 5_000)
    await microcompactMessages(messages, undefined, MAIN)
    const clipped = getClippedIds()
    const ids = clippedInOrder(clipped, 24)
    // A contiguous oldest-first prefix, not everything: the band bounds it.
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.length).toBeLessThan(22)
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => `toolu_${i}`))
    expect(clipped.has('toolu_22')).toBe(false)
    expect(clipped.has('toolu_23')).toBe(false)
  })

  test('a second request in the same state does not clip again (usage is measured over the stubbed view)', async () => {
    const { microcompactMessages } = await import('src/agent/compact/microCompact.js')
    const { getClippedIds } = await import('src/agent/compact/stableStubState.js')
    // Same partial-clip setup as above: the first pass leaves clearable
    // results behind, so a second clip would be observable.
    mockSizeState.effectiveWindow = 40_000
    const messages = buildHeavyHistory(24, 5_000)
    await microcompactMessages(messages, undefined, MAIN)
    const after = getClippedIds().size
    expect(after).toBeGreaterThan(0)
    expect(after).toBeLessThan(22)
    await microcompactMessages(messages, undefined, MAIN)
    expect(getClippedIds().size).toBe(after)
  })

  test('candidates already in the clipped set are not counted or re-selected', async () => {
    const { microcompactMessages } = await import('src/agent/compact/microCompact.js')
    const { addClippedIds, getClippedIds } = await import('src/agent/compact/stableStubState.js')
    mockSizeState.effectiveWindow = 20_000
    const messages = buildHeavyHistory(20, 5_000)
    // Everything clearable is already clipped → the stubbed view sits under
    // the trigger → no new ids.
    addClippedIds(Array.from({ length: 18 }, (_, i) => `toolu_${i}`))
    const before = getClippedIds().size
    await microcompactMessages(messages, undefined, MAIN)
    expect(getClippedIds().size).toBe(before)
  })

  test('the protected window is never clipped even under pressure', async () => {
    const { microcompactMessages } = await import('src/agent/compact/microCompact.js')
    const { getClippedIds } = await import('src/agent/compact/stableStubState.js')
    // Two huge results, both inside the last 2 user-role messages.
    mockSizeState.effectiveWindow = 5_000
    await microcompactMessages(buildHeavyHistory(2, 20_000), undefined, MAIN)
    expect(getClippedIds().size).toBe(0)
  })

  test('effective window 0: no clipping (degrades gracefully)', async () => {
    const { microcompactMessages } = await import('src/agent/compact/microCompact.js')
    const { getClippedIds } = await import('src/agent/compact/stableStubState.js')
    mockSizeState.effectiveWindow = 0
    await microcompactMessages(buildHeavyHistory(20, 10_000), undefined, MAIN)
    expect(getClippedIds().size).toBe(0)
  })

  test('CLAUDIN_DISABLE_RELIEF_POLICY=1 turns the window lane off', async () => {
    const { microcompactMessages } = await import('src/agent/compact/microCompact.js')
    const { getClippedIds } = await import('src/agent/compact/stableStubState.js')
    process.env.CLAUDIN_DISABLE_RELIEF_POLICY = '1'
    mockSizeState.effectiveWindow = 20_000
    await microcompactMessages(buildHeavyHistory(20, 5_000), undefined, MAIN)
    expect(getClippedIds().size).toBe(0)
  })

  test('resetMicrocompactState clears the clipped set', async () => {
    const { resetMicrocompactState } = await import('src/agent/compact/microCompact.js')
    const { addClippedIds, getClippedIds } = await import('src/agent/compact/stableStubState.js')
    addClippedIds(['toolu_x', 'toolu_y'])
    expect(getClippedIds().size).toBe(2)
    resetMicrocompactState()
    expect(getClippedIds().size).toBe(0)
  })
})

afterAll(() => {
  mock.module('./autoCompact.js', () => realAutoCompact)
  mock.module('src/providers/model/model.js', () => realModel)
})
