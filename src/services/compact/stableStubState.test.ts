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
  // Prime the lazy lastSeenSessionId — see FIX-2 in stableStubState.ts.
  // The first sessionSwitched fire is a no-op (no prior session to drop
  // entries for); from the second fire on, the listener cleans up.
  switchSession(getSessionId())

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

test('skips empty/null/empty-array content (no zero-byte → ~30-byte stub)', () => {
  const messages: Msg[] = [
    assistantToolUse('toolu_null', 'Read'),
    userToolResult('toolu_null', null),
    assistantToolUse('toolu_empty_str', 'Read'),
    userToolResult('toolu_empty_str', ''),
    assistantToolUse('toolu_empty_arr', 'Read'),
    userToolResult('toolu_empty_arr', []),
  ]
  addClippedIds(['toolu_null', 'toolu_empty_str', 'toolu_empty_arr'])

  const result = applyStableStubs(messages)

  // Each block should be byte-identical to its input — no stub rewrite.
  const inputBlocks = messages.map(m => (m.content as Block[])[0])
  const resultBlocks = result.map(m => (m.content as Block[])[0])
  expect(resultBlocks[1]).toBe(inputBlocks[1])
  expect(resultBlocks[3]).toBe(inputBlocks[3])
  expect(resultBlocks[5]).toBe(inputBlocks[5])
  // And the original `content` values are preserved verbatim
  expect((resultBlocks[1] as { content: unknown }).content).toBeNull()
  expect((resultBlocks[3] as { content: unknown }).content).toBe('')
  expect((resultBlocks[5] as { content: unknown }).content).toEqual([])
})

test('clipped set with no matching tool_use_ids: blocks reference-equal input', () => {
  // Distinct from the size===0 fast path: set is non-empty, but no block
  // in the messages references any clipped id, so we should walk without
  // allocating a new block.
  const messages: Msg[] = [
    assistantToolUse('toolu_A', 'Read'),
    userToolResult('toolu_A', 'A'.repeat(2_000)),
    assistantToolUse('toolu_B', 'Bash'),
    userToolResult('toolu_B', 'B'.repeat(2_000)),
  ]
  addClippedIds(['toolu_X', 'toolu_Y'])

  const result = applyStableStubs(messages)

  // Each tool_result block in the result must reference-equal the input
  // block: no allocation when the id-set doesn't intersect.
  const inResult = (result[1].content as Block[])[0]
  const inInput = (messages[1].content as Block[])[0]
  expect(inResult).toBe(inInput)
  const inResult2 = (result[3].content as Block[])[0]
  const inInput2 = (messages[3].content as Block[])[0]
  expect(inResult2).toBe(inInput2)
})

test('first switchSession fire after reset is a no-op (lazy lastSeenSessionId)', () => {
  // After _resetAllClippedIdsForTesting + module already loaded, the
  // lastSeenSessionId may have been seeded to the current session by a
  // prior listener fire from another test. To exercise the lazy-init
  // contract here we simply confirm: switchSession to a new id does not
  // throw and ends with an empty Map; subsequent addClippedIds + switch
  // drops the stale entry as expected.
  const original = getSessionId()

  // First fire — should be safe whether or not lastSeenSessionId was
  // already populated.
  expect(() => switchSession('lazy-init-session-1' as SessionId)).not.toThrow()
  expect(_getClippedIdsMapSizeForTesting()).toBe(0)

  // Now under the new session, add an id and switch again — listener
  // must drop the outgoing entry.
  addClippedIds(['toolu_lazy'])
  expect(getClippedIds().size).toBe(1)
  switchSession('lazy-init-session-2' as SessionId)
  expect(getClippedIds().size).toBe(0)
  expect(_getClippedIdsMapSizeForTesting()).toBe(0)

  switchSession(original)
})

// ROADMAP 5.7: substitution semantics for QueryEngine.mutableMessages
//
// QueryEngine substitutes its mutableMessages reference with the result of
// applyStableStubs at the start of each turn. These tests pin the contract
// the engine relies on: identity-preserving fast path when there is nothing
// to clip, and full GC-eligibility of the original block content (not just
// the wire bytes) when there is.

test('5.7 substitution: array identity preserved when no rewrites apply', () => {
  // Set has an id that does NOT appear in messages → no rewrites possible.
  addClippedIds(['toolu_unrelated'])
  const messages: Msg[] = [
    assistantToolUse('toolu_a', 'Read'),
    userToolResult('toolu_a', 'A'.repeat(5_000)),
  ]
  const result = applyStableStubs(messages)
  // Same array reference: QueryEngine's `compacted !== this.mutableMessages`
  // identity guard relies on this so we don't reassign on every turn.
  expect(result).toBe(messages)
})

test('5.7 substitution: sub-agent applyStableStubs is no-op for parent-only clipped ids', async () => {
  // QueryEngine.submitMessage substitution must not leak the parent's stubs
  // into a sub-agent's mutableMessages. Each engine runs under its own
  // teammateContext; currentKey() composes (sessionId, agentId), so the
  // sub-agent's lookup misses the parent's set and applyStableStubs is a
  // pure identity no-op there.
  const { runWithTeammateContext } = await import('../../utils/teammateContext.js')

  // Parent: clip an id and confirm substitution rewrites it
  addClippedIds(['parent_only'])
  const parentMessages: Msg[] = [
    assistantToolUse('parent_only', 'Read'),
    userToolResult('parent_only', 'X'.repeat(2_000)),
  ]
  const parentCompacted = applyStableStubs(parentMessages)
  expect(parentCompacted).not.toBe(parentMessages)

  // Sub-agent: same messages, but its currentKey misses the parent's set,
  // so applyStableStubs returns the input ref unchanged (no leak).
  const ctx = {
    agentId: 'agent-isolation-test',
    agentName: 'test-agent',
    teamName: 'team-1',
    planModeRequired: false,
    parentSessionId: 'parent-session',
    isInProcess: true as const,
    abortController: new AbortController(),
  }
  await runWithTeammateContext(ctx, async () => {
    const childMessages: Msg[] = [
      assistantToolUse('parent_only', 'Read'),
      userToolResult('parent_only', 'Y'.repeat(2_000)),
    ]
    const childCompacted = applyStableStubs(childMessages)
    // Identity preserved: the substitution would be a no-op in the engine
    // (the `compacted !== this.mutableMessages` guard skips reassignment).
    expect(childCompacted).toBe(childMessages)
    // And the original 2 KB content is untouched in the child's view.
    const block = (childCompacted[1].content as Block[])[0] as { content: string }
    expect(block.content).toBe('Y'.repeat(2_000))
  })
})

test('5.7 substitution: original block content is no longer reachable from the new array', () => {
  // Build messages where every tool_result content is a unique 50 KB string.
  // After applyStableStubs, the new array must not transitively reference
  // any of those originals — otherwise the in-memory hold survives the
  // substitution and the roadmap 5.7 RSS win evaporates.
  const originals: string[] = []
  const messages: Msg[] = []
  for (let i = 0; i < 20; i++) {
    const big = `payload-${i}-`.repeat(5_000) // ~60 KB each
    originals.push(big)
    messages.push(assistantToolUse(`toolu_${i}`, 'Read'))
    messages.push(userToolResult(`toolu_${i}`, big))
  }
  addClippedIds(originals.map((_, i) => `toolu_${i}`))

  const compacted = applyStableStubs(messages)
  expect(compacted).not.toBe(messages)

  // Walk the compacted array and assert no surviving reference to any
  // original payload string.
  const survivingContents = new Set<unknown>()
  for (const msg of compacted) {
    const content = msg.message?.content ?? msg.content
    if (!Array.isArray(content)) continue
    for (const block of content as Block[]) {
      if (block.type === 'tool_result') {
        survivingContents.add(block.content)
      }
    }
  }
  for (const orig of originals) {
    expect(survivingContents.has(orig)).toBe(false)
  }
  // And the new content is the deterministic stub.
  for (const c of survivingContents) {
    expect(typeof c).toBe('string')
    expect(c as string).toMatch(/^\[clipped: ~\d+ tokens from Read\]$/)
  }
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
