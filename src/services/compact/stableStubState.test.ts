import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  _getClippedIdsMapSizeForTesting,
  _resetAllClippedIdsForTesting,
  addClippedIds,
  applyStableStubs,
  buildClipStub,
  getClippedIds,
  resetClippedIds,
} from './stableStubState.js'
import {
  getSessionId,
  regenerateSessionId,
  switchSession,
} from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'

type Block = Record<string, unknown>
type Msg = { role?: string; message?: { role?: string; content?: unknown }; content?: unknown }

beforeEach(() => {
  _resetAllClippedIdsForTesting()
})

afterEach(() => {
  _resetAllClippedIdsForTesting()
})

function userToolResult(id: string, content: unknown, extra: Block = {}): Msg {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content,
        ...extra,
      },
    ],
  }
}

function assistantToolUse(id: string, name: string, input: unknown = {}): Msg {
  return {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id,
        name,
        input,
      },
    ],
  }
}

test('applyStableStubs is a no-op when the clipped set is empty', () => {
  const messages: Msg[] = [
    assistantToolUse('toolu_a', 'Read'),
    userToolResult('toolu_a', 'big result'),
  ]
  const result = applyStableStubs(messages)
  // Returns the same reference for the fast path
  expect(result).toBe(messages)
})

test('applyStableStubs is idempotent for clipped ids (byte-stable)', () => {
  const messages: Msg[] = [
    assistantToolUse('toolu_a', 'Read'),
    userToolResult('toolu_a', 'A'.repeat(5_000)),
  ]
  addClippedIds(['toolu_a'])

  const once = applyStableStubs(messages)
  const twice = applyStableStubs(once)

  // Same string content on both passes
  const block1 = (once[1].content as Block[])[0] as { content: string }
  const block2 = (twice[1].content as Block[])[0] as { content: string }
  expect(block1.content).toBe(block2.content)
  expect(block1.content).toMatch(/^\[clipped: ~\d+ tokens from Read\]$/)
})

test('addClippedIds grows monotonically and dedupes', () => {
  addClippedIds(['a'])
  expect([...getClippedIds()]).toEqual(['a'])
  addClippedIds(['b'])
  expect(new Set(getClippedIds())).toEqual(new Set(['a', 'b']))
  // Re-adding 'a' is a no-op
  addClippedIds(['a'])
  expect(getClippedIds().size).toBe(2)
})

test('resetClippedIds empties the set', () => {
  addClippedIds(['a', 'b'])
  resetClippedIds()
  expect(getClippedIds().size).toBe(0)
})

test('preserves is_error on clipped tool_result', () => {
  const messages: Msg[] = [
    assistantToolUse('toolu_e', 'Bash'),
    userToolResult('toolu_e', 'failed', { is_error: true }),
  ]
  addClippedIds(['toolu_e'])
  const result = applyStableStubs(messages)
  const block = (result[1].content as Block[])[0] as {
    is_error?: boolean
    content: string
  }
  expect(block.is_error).toBe(true)
  expect(block.content).toMatch(/^\[clipped: /)
})

test('preserves block-level extras such as cache_control', () => {
  const cacheControl = { type: 'ephemeral' }
  const messages: Msg[] = [
    assistantToolUse('toolu_cc', 'Read'),
    userToolResult('toolu_cc', 'A'.repeat(2_000), { cache_control: cacheControl }),
  ]
  addClippedIds(['toolu_cc'])
  const result = applyStableStubs(messages)
  const block = (result[1].content as Block[])[0] as { cache_control?: unknown }
  expect(block.cache_control).toEqual(cacheControl)
})

test('stub bytes are deterministic across "turns" for the same input', () => {
  const build = (): Msg[] => [
    assistantToolUse('toolu_d', 'Grep'),
    userToolResult('toolu_d', 'X'.repeat(3_000)),
  ]
  addClippedIds(['toolu_d'])

  const turn1 = applyStableStubs(build())
  const turn2 = applyStableStubs(build())

  expect(JSON.stringify(turn1)).toBe(JSON.stringify(turn2))
})

test('SKIPS clipping for tool_results whose array content carries an image', () => {
  const arrayContent = [
    { type: 'text', text: 'caption text' },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
    },
  ]
  const messages: Msg[] = [
    assistantToolUse('toolu_img', 'Read'),
    userToolResult('toolu_img', arrayContent),
  ]
  addClippedIds(['toolu_img'])
  const result = applyStableStubs(messages)
  const block = (result[1].content as Block[])[0] as { content: unknown }
  // Vision content survives — the array is preserved untouched
  expect(Array.isArray(block.content)).toBe(true)
  expect(block.content).toEqual(arrayContent)
})

test('stub label includes a token count near the original size', () => {
  // ~4 chars per token → 4000 chars ≈ 1000 tokens
  const messages: Msg[] = [
    assistantToolUse('toolu_n', 'Read'),
    userToolResult('toolu_n', 'A'.repeat(4_000)),
  ]
  addClippedIds(['toolu_n'])
  const result = applyStableStubs(messages)
  const block = (result[1].content as Block[])[0] as { content: string }
  const match = /~(\d+) tokens/.exec(block.content)
  expect(match).not.toBeNull()
  const tokens = Number(match![1])
  // sanity: should be within an order of magnitude of expectation
  expect(tokens).toBeGreaterThan(500)
  expect(tokens).toBeLessThan(2_000)
})

test('buildClipStub uses raw token count (no bucket rounding)', () => {
  expect(buildClipStub('Read', 1_234)).toBe('[clipped: ~1234 tokens from Read]')
  expect(buildClipStub('Bash', 0)).toBe('[clipped: ~0 tokens from Bash]')
  expect(buildClipStub('Grep', 17)).toBe('[clipped: ~17 tokens from Grep]')
})

test('falls back to "tool" when the tool name is unknown', () => {
  // tool_result with no matching assistant tool_use
  const messages: Msg[] = [userToolResult('toolu_orphan', 'data')]
  addClippedIds(['toolu_orphan'])
  const result = applyStableStubs(messages)
  const block = (result[0].content as Block[])[0] as { content: string }
  expect(block.content).toMatch(/from tool\]$/)
})

// ===========================================================================
// Per-session / per-agent isolation
// ===========================================================================

test('sub-agent (different agentId) has its own isolated clipped set', async () => {
  // Use teammateContext.runWithTeammateContext (AsyncLocalStorage) to flip
  // getAgentId() under the hood. This is the actual mechanism in-process
  // teammates use (utils/swarm/inProcessRunner) and exercises the real
  // currentKey() composition.
  const { runWithTeammateContext } = await import('../../utils/teammateContext.js')

  // Parent adds ids
  addClippedIds(['parent_a', 'parent_b'])
  expect(getClippedIds().size).toBe(2)

  // Sub-agent context — different agentId yields a fresh isolated set
  const ctx = {
    agentId: 'agent-1',
    agentName: 'test-agent',
    teamName: 'team-1',
    planModeRequired: false,
    parentSessionId: 'parent-session',
    isInProcess: true as const,
    abortController: new AbortController(),
  }
  await runWithTeammateContext(ctx, async () => {
      expect(getClippedIds().size).toBe(0)
      addClippedIds(['child_x'])
      expect(getClippedIds().size).toBe(1)

    // Sub-agent reset (mirrors inProcessRunner.ts:1107 post-autocompact)
    resetClippedIds()
    expect(getClippedIds().size).toBe(0)
  })

  // Parent's set is INTACT — sub-agent's reset did not wipe it
  expect(getClippedIds().size).toBe(2)
  expect(getClippedIds().has('parent_a')).toBe(true)
})

test('regenerateSessionId drops the outgoing session entry', () => {
  addClippedIds(['toolu_old'])
  expect(getClippedIds().size).toBe(1)
  const before = _getClippedIdsMapSizeForTesting()
  expect(before).toBeGreaterThanOrEqual(1)

  regenerateSessionId()

  // New session sees an empty set
  expect(getClippedIds().size).toBe(0)
  // And the old session's entry was reclaimed by the listener
  expect(_getClippedIdsMapSizeForTesting()).toBe(0)
})

test('switchSession (/resume) drops the outgoing session entry', () => {
  const original = getSessionId()
  addClippedIds(['toolu_a', 'toolu_b'])
  expect(getClippedIds().size).toBe(2)

  // Simulate /resume
  switchSession('resumed-session-id-xxxx' as SessionId)

  expect(getClippedIds().size).toBe(0)
  expect(_getClippedIdsMapSizeForTesting()).toBe(0)

  // Restore the original session id so other tests aren't affected
  switchSession(original)
})

test('Map size stays bounded across many switchSession calls', () => {
  const original = getSessionId()
  for (let i = 0; i < 50; i++) {
    addClippedIds([`tool_${i}`])
    switchSession(`session_${i}` as SessionId)
  }
  // Listener drops outgoing entries → at most 1-2 active
  expect(_getClippedIdsMapSizeForTesting()).toBeLessThanOrEqual(2)
  switchSession(original)
})
