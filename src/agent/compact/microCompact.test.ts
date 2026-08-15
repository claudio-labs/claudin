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
const realModel = { ...(await import('src/utils/model/model.js')) }

mock.module('./autoCompact.js', () => ({
  ...realAutoCompact,
  getEffectiveContextWindowSize: () => mockSizeState.effectiveWindow,
}))

mock.module('src/utils/model/model.js', () => ({
  ...realModel,
  getMainLoopModel: () => 'claude-sonnet-4',
}))

describe('size-driven stable-stub trigger', () => {
  beforeEach(async () => {
    const { resetClippedIds } = await import('src/agent/compact/stableStubState.js')
    resetClippedIds()
    mockSizeState.effectiveWindow = 100_000
  })

  afterEach(async () => {
    const { resetClippedIds } = await import('src/agent/compact/stableStubState.js')
    resetClippedIds()
  })

  function buildHeavyHistory(numExchanges: number, perResultChars: number): Message[] {
    const out: Message[] = []
    for (let i = 0; i < numExchanges; i++) {
      out.push(assistantWithToolUse('Read', `toolu_${i}`))
      out.push(userWithToolResult(`toolu_${i}`, 'A'.repeat(perResultChars)))
    }
    return out
  }

  test('below threshold: no new clipped ids', async () => {
    const { microcompactMessages } = await import('src/agent/compact/microCompact.js')
    const { getClippedIds } = await import('src/agent/compact/stableStubState.js')
    // Tiny conversation, far below 50% of 100k tokens
    const messages = buildHeavyHistory(2, 100)
    await microcompactMessages(messages)
    expect(getClippedIds().size).toBe(0)
  })

  test('above threshold: clips all but the last 2 compactable ids', async () => {
    const { microcompactMessages } = await import('src/agent/compact/microCompact.js')
    const { getClippedIds } = await import('src/agent/compact/stableStubState.js')
    // 10 exchanges × ~5k chars each → ~12k tokens (×4/3 padding ≈ 16k).
    // Drop the window so we cross the 50% threshold easily.
    mockSizeState.effectiveWindow = 20_000
    const messages = buildHeavyHistory(10, 5_000)
    await microcompactMessages(messages)
    const clipped = getClippedIds()
    // 10 ids total minus the last 2 kept-recent
    expect(clipped.size).toBe(8)
    for (let i = 0; i < 8; i++) {
      expect(clipped.has(`toolu_${i}`)).toBe(true)
    }
    expect(clipped.has('toolu_8')).toBe(false)
    expect(clipped.has('toolu_9')).toBe(false)
  })

  test('threshold met but everything already clipped: no change', async () => {
    const { microcompactMessages } = await import('src/agent/compact/microCompact.js')
    const { addClippedIds, getClippedIds } = await import('src/agent/compact/stableStubState.js')
    mockSizeState.effectiveWindow = 20_000
    const messages = buildHeavyHistory(10, 5_000)
    // Pre-populate: keep-recent leaves out the last 2, so the candidate set is 0..7.
    const preClipped = ['toolu_0', 'toolu_1', 'toolu_2', 'toolu_3', 'toolu_4', 'toolu_5', 'toolu_6', 'toolu_7']
    addClippedIds(preClipped)
    const before = getClippedIds().size
    await microcompactMessages(messages)
    expect(getClippedIds().size).toBe(before)
  })

  test('small-history dead zone: 3 compactable ids → clips 1, keeps 2', async () => {
    const { microcompactMessages } = await import('src/agent/compact/microCompact.js')
    const { getClippedIds } = await import('src/agent/compact/stableStubState.js')
    // 3 huge results, threshold breached. Without the fix, candidateIds
    // would be empty (3 > 2 → slice(0,-2) leaves [0]), so it actually clips
    // 1. Test the EDGE case where ids count == keepRecent: 2 results.
    mockSizeState.effectiveWindow = 5_000
    const messages = buildHeavyHistory(2, 5_000)
    await microcompactMessages(messages)
    const clipped = getClippedIds()
    // 2 ids → keepRecent collapses to 1, candidate = [toolu_0]
    expect(clipped.size).toBe(1)
    expect(clipped.has('toolu_0')).toBe(true)
    expect(clipped.has('toolu_1')).toBe(false)
  })

  test('single compactable id below dead zone: no clipping', async () => {
    const { microcompactMessages } = await import('src/agent/compact/microCompact.js')
    const { getClippedIds } = await import('src/agent/compact/stableStubState.js')
    // Only 1 compactable id — keep at least 1 most-recent → 0 candidates.
    mockSizeState.effectiveWindow = 5_000
    const messages = buildHeavyHistory(1, 10_000)
    await microcompactMessages(messages)
    expect(getClippedIds().size).toBe(0)
  })

  test('effective window 0: no clipping (degrades gracefully)', async () => {
    const { microcompactMessages } = await import('src/agent/compact/microCompact.js')
    const { getClippedIds } = await import('src/agent/compact/stableStubState.js')
    // Provider returns 0 / unknown context window — the size-driven
    // trigger is gated behind `effectiveWindow > 0` so we should not
    // clip even with a heavy history that would otherwise breach the
    // threshold under any reasonable window.
    mockSizeState.effectiveWindow = 0
    const messages = buildHeavyHistory(20, 10_000)
    await microcompactMessages(messages)
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
  mock.module('src/utils/model/model.js', () => realModel)
})
