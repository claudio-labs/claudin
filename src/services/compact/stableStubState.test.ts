import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  _getClippedIdsMapSizeForTesting,
  _getPinnedToolResultsForTesting,
  _getSpentPinIdsForTesting,
  _resetAllClippedIdsForTesting,
  addClippedIds,
  applyStableStubs,
  buildClipStub,
  evictOldStubbedMessages,
  evictToMaxSize,
  getClipFrontierIndex,
  getClippedIds,
  isPinRegistered,
  MAX_PINNED_RESULT_TOKENS,
  MAX_SHIELDED_PASSES,
  pinToolResult,
  pruneContentReplacementState,
  pruneOldToolResults,
  pruneOrphanClippedIds,
  pruneStaleClippedIds,
  pruneToolResultsByBytes,
  resetClippedIds,
  stubToolResultForDisplay,
  unpinToolResult,
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
  // Default profile emits the head-preserving form for long string content;
  // both forms end with the deterministic marker line.
  expect(block1.content).toMatch(/\[clipped: ~\d+ tokens from Read( — head preserved)?\]$/)
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
    expect(c as string).toMatch(/\[clipped: ~\d+ tokens from Read( — head preserved)?\]$/)
  }
})

// ===========================================================================
// pruneOldToolResults
// ===========================================================================

describe('pruneOldToolResults', () => {
  test('no-op on empty messages', () => {
    const result = pruneOldToolResults([])
    expect(result).toEqual([])
  })

  test('no-op when fewer turns than keepTurns', () => {
    // 1 user message → fewer than default keepTurns=1... actually keepTurns=1
    // means we protect the last 1 user turn, so with exactly 1 user message
    // there is nothing before the cutoff → no pruning.
    const messages: Msg[] = [
      assistantToolUse('toolu_a', 'Bash'),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'output' }] },
    ]
    const result = pruneOldToolResults(messages, 1)
    expect(result).toBe(messages)
  })

  test('stubs tool_results older than keepTurns (default 1)', () => {
    // Two turns: turn-1 and turn-2. With keepTurns=1, turn-1's tool_result
    // should be stubbed, turn-2's (the current) should be intact.
    const bigContent = 'A'.repeat(10_000)
    const turn2Content = 'current turn output'
    const messages: Msg[] = [
      // turn 1
      assistantToolUse('toolu_old', 'Bash'),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: bigContent }] },
      // turn 2 (current)
      assistantToolUse('toolu_cur', 'Grep'),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_cur', content: turn2Content }] },
    ]

    const result = pruneOldToolResults(messages, 1)
    expect(result).not.toBe(messages)

    const oldBlock = (result[1].content as Block[])[0] as { content: string }
    expect(oldBlock.content).toMatch(/^\[clipped: ~\d+ tokens from Bash\]$/)
    expect(oldBlock.content).not.toContain(bigContent)

    const curBlock = (result[3].content as Block[])[0] as { content: string }
    expect(curBlock.content).toBe(turn2Content)
  })

  test('identity-preserving when all turns within window', () => {
    // keepTurns=2, only 1 user message → nothing to prune → same ref returned
    const messages: Msg[] = [
      assistantToolUse('toolu_a', 'Read'),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'data' }] },
    ]
    const result = pruneOldToolResults(messages, 2)
    expect(result).toBe(messages)
  })

  test('identity-preserving when all old blocks are already stubs', () => {
    const stub = buildClipStub('Bash', 500)
    const messages: Msg[] = [
      assistantToolUse('toolu_old', 'Bash'),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: stub }] },
      assistantToolUse('toolu_cur', 'Grep'),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_cur', content: 'fresh output' }] },
    ]

    const result = pruneOldToolResults(messages, 1)
    // The old block is already a stub, so nothing changes → same ref
    expect(result).toBe(messages)
  })

  test('skips image-bearing tool_results (preserves vision context)', () => {
    const imageContent = [
      { type: 'text', text: 'description' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
    ]
    const messages: Msg[] = [
      assistantToolUse('toolu_img', 'Read'),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_img', content: imageContent }] },
      assistantToolUse('toolu_cur', 'Bash'),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_cur', content: 'text output' }] },
    ]

    const result = pruneOldToolResults(messages, 1)
    const imgBlock = (result[1].content as Block[])[0] as { content: unknown }
    // Vision content untouched
    expect(imgBlock.content).toEqual(imageContent)
  })

  test('skips null/empty content (no stub added)', () => {
    const messages: Msg[] = [
      assistantToolUse('toolu_null', 'Bash'),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_null', content: null }] },
      assistantToolUse('toolu_cur', 'Read'),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_cur', content: 'fresh' }] },
    ]
    const result = pruneOldToolResults(messages, 1)
    // null block is skipped → if that was the only change candidate, result ref equals input
    const oldBlock = (result[1].content as Block[])[0] as { content: unknown }
    expect(oldBlock.content).toBeNull()
  })

  test('preserves short tool_results below stub threshold (no token win)', () => {
    // Repro of the "Error: [clipped: ~12 tokens from Agent]" bug: a short
    // error from a previous turn was being rewritten as a clip stub, which
    // saved zero tokens and destroyed the user-visible error text.
    const shortError = 'Agent execution was interrupted'
    const messages: Msg[] = [
      assistantToolUse('toolu_err', 'Agent'),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_err', content: shortError }] },
      assistantToolUse('toolu_cur', 'Read'),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_cur', content: 'fresh' }] },
    ]
    const result = pruneOldToolResults(messages, 1)
    const oldBlock = (result[1].content as Block[])[0] as { content: string }
    expect(oldBlock.content).toBe(shortError)
  })

  test('preserves is_error tool_results regardless of size', () => {
    // Even if an error message somehow grew past the token threshold, we
    // want to keep it intact — losing error context is worse than the few
    // tokens we'd save.
    const errorBody = 'Stack trace:\n' + 'at frame X\n'.repeat(500)
    const messages: Msg[] = [
      assistantToolUse('toolu_err', 'Bash'),
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_err', content: errorBody, is_error: true }],
      },
      assistantToolUse('toolu_cur', 'Read'),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_cur', content: 'fresh' }] },
    ]
    const result = pruneOldToolResults(messages, 1)
    const oldBlock = (result[1].content as Block[])[0] as { content: string }
    expect(oldBlock.content).toBe(errorBody)
  })

  test('keepTurns=6: protects last 6 user turns, prunes everything older', () => {
    // Build 10 turns (each with a big tool_result)
    const msgs: Msg[] = []
    for (let i = 0; i < 10; i++) {
      msgs.push(assistantToolUse(`toolu_${i}`, 'Bash'))
      msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: 'X'.repeat(5_000) }] })
    }

    const result = pruneOldToolResults(msgs, 6)
    expect(result).not.toBe(msgs)

    // Turns 0-3 (the first 4 user messages) should be stubbed
    for (let i = 0; i < 4; i++) {
      const block = (result[i * 2 + 1].content as Block[])[0] as { content: string }
      expect(block.content).toMatch(/^\[clipped: ~\d+ tokens from Bash\]$/)
    }
    // Turns 4-9 (last 6) should be intact
    for (let i = 4; i < 10; i++) {
      const block = (result[i * 2 + 1].content as Block[])[0] as { content: string }
      expect(block.content).toBe('X'.repeat(5_000))
    }
  })

  test('RSS regression: 50 turns of 50 KB → tiny residual after pruning', () => {
    // This pins the memory-reduction contract from the ROADMAP 5.7 bench.
    const msgs: Msg[] = []
    for (let i = 0; i < 50; i++) {
      msgs.push(assistantToolUse(`toolu_${i}`, 'Bash'))
      msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: 'B'.repeat(50_000) }] })
    }

    const result = pruneOldToolResults(msgs, 1)

    // All but the last tool_result must be stubbed stubs (short strings)
    let totalSurvivedBytes = 0
    for (let i = 0; i < result.length; i++) {
      const msg = result[i]!
      const content = msg.content
      if (!Array.isArray(content)) continue
      for (const block of content as Block[]) {
        if (block.type === 'tool_result') {
          totalSurvivedBytes += String((block as { content: unknown }).content ?? '').length
        }
      }
    }
    // The only surviving full payload is the last turn's 50 KB.
    // Everything else is a ~40-char stub. Budget: 50 KB + 49 * 50 bytes ≈ 53 KB.
    expect(totalSurvivedBytes).toBeLessThan(55_000)
  })

  // Regression: QueryEngine.mutableMessages stores messages in the
  // `{ type, message: { role, content } }` wrapper shape (see Message type in
  // src/types/message.ts). pruneOldToolResults must stub those correctly.
  // Without this coverage, an edit to getInner() could silently break A1.
  test('handles .message wrapper shape used by mutableMessages', () => {
    const bigContent = 'C'.repeat(10_000)
    const wrappedMsgs = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_w_old', name: 'Bash', input: {} },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_w_old',
              content: bigContent,
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_w_cur', name: 'Grep', input: {} },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_w_cur',
              content: 'fresh',
            },
          ],
        },
      },
    ] as Msg[]

    const result = pruneOldToolResults(wrappedMsgs, 1)
    expect(result).not.toBe(wrappedMsgs)

    // Old turn stubbed
    const oldInner = (result[1] as { message: { content: Block[] } }).message
    const oldBlock = oldInner.content[0] as { content: string }
    expect(oldBlock.content).toMatch(/^\[clipped: ~\d+ tokens from Bash\]$/)
    expect(oldBlock.content).not.toContain(bigContent)

    // Current turn untouched
    const curInner = (result[3] as { message: { content: Block[] } }).message
    const curBlock = curInner.content[0] as { content: string }
    expect(curBlock.content).toBe('fresh')

    // Outer wrapper identity preserved except where content changed
    expect((result[0] as Msg).type).toBe('assistant')
    expect((result[1] as Msg).type).toBe('user')
  })
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

describe('stubToolResultForDisplay', () => {
  test('returns same reference for non-user messages', () => {
    const msg: Msg = { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }
    const result = stubToolResultForDisplay(msg, [msg])
    expect(result).toBe(msg)
  })

  test('returns same reference for user messages with small tool_results', () => {
    const msg: Msg = userToolResult('toolu_1', 'small output')
    const result = stubToolResultForDisplay(msg, [msg])
    expect(result).toBe(msg)
  })

  test('stubs user messages with large tool_result content', () => {
    const assistantMsg: Msg = assistantToolUse('toolu_1', 'Grep')
    const largeContent = 'X'.repeat(20_000)  // ~5000 tokens
    const msg: Msg = userToolResult('toolu_1', largeContent)
    const result = stubToolResultForDisplay(msg, [assistantMsg])
    expect(result).not.toBe(msg)
    const content = (result as Msg).content as Block[]
    expect(content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' })
    expect((content[0] as { content: string }).content).toContain('clipped')
    expect((content[0] as { content: string }).content).toContain('Grep')
  })

  test('uses fallback tool name when assistant message is not in allMessages', () => {
    const largeContent = 'Y'.repeat(20_000)
    const msg: Msg = userToolResult('toolu_1', largeContent)
    const result = stubToolResultForDisplay(msg, [])  // no assistant message available
    expect(result).not.toBe(msg)
    const content = (result as Msg).content as Block[]
    expect((content[0] as { content: string }).content).toContain('tool')
  })

  test('does not stub already-stubbed content', () => {
    const stubbed = buildClipStub('Grep', 5000)
    const msg: Msg = userToolResult('toolu_1', stubbed)
    const result = stubToolResultForDisplay(msg, [msg])
    expect(result).toBe(msg)
  })

  test('does not stub tool_results already in clippedIds', () => {
    _resetAllClippedIdsForTesting()
    addClippedIds(['toolu_1'])
    const largeContent = 'Z'.repeat(20_000)
    const msg: Msg = userToolResult('toolu_1', largeContent)
    const result = stubToolResultForDisplay(msg, [msg])
    expect(result).toBe(msg)
    _resetAllClippedIdsForTesting()
  })

  test('stubs multiple large tool_results in one message', () => {
    const assistantMsg: Msg = { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_1', name: 'Grep', input: {} },
      { type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} },
    ] }
    const largeContent1 = 'A'.repeat(20_000)
    const largeContent2 = 'B'.repeat(15_000)
    const msg: Msg = { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: largeContent1 },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: largeContent2 },
    ] }
    const result = stubToolResultForDisplay(msg, [assistantMsg])
    expect(result).not.toBe(msg)
    const content = (result as Msg).content as Block[]
    expect((content[0] as { content: string }).content).toContain('Grep')
    expect((content[1] as { content: string }).content).toContain('Read')
  })

  test('leaves small tool_result intact while stubbing large one', () => {
    const assistantMsg: Msg = { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
      { type: 'tool_use', id: 'toolu_2', name: 'Grep', input: {} },
    ] }
    const smallContent = 'short output'
    const largeContent = 'X'.repeat(20_000)
    const msg: Msg = { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: smallContent },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: largeContent },
    ] }
    const result = stubToolResultForDisplay(msg, [assistantMsg])
    expect(result).not.toBe(msg)
    const content = (result as Msg).content as Block[]
    // Small result unchanged
    expect((content[0] as { content: string }).content).toBe(smallContent)
    // Large result stubbed
    expect((content[1] as { content: string }).content).toContain('clipped')
  })

  test('preserves .message wrapper when stubbing', () => {
    const largeContent = 'X'.repeat(20_000)
    // Simulate a wrapped message (real MessageType shape)
    const msg = {
      type: 'user' as const,
      uuid: 'test-uuid-123',
      timestamp: Date.now(),
      message: {
        role: 'user' as const,
        content: [{ type: 'tool_result' as const, tool_use_id: 'toolu_1', content: largeContent }],
      },
    }
    const result = stubToolResultForDisplay(msg, [])
    // Must preserve outer wrapper fields
    expect(result).toMatchObject({
      type: 'user',
      uuid: 'test-uuid-123',
    })
    // Inner message must have stubbed content
    const inner = (result as { message: { content: Block[] } }).message
    expect(inner.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' })
    expect((inner.content[0] as { content: string }).content).toContain('clipped')
  })
})

describe('evictOldStubbedMessages', () => {
  function stubContent(toolName: string, tokens: number): string {
    return buildClipStub(toolName, tokens)
  }

  test('returns same reference when no messages can be evicted', () => {
    const msgs: Msg[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]
    const result = evictOldStubbedMessages(msgs, 1)
    expect(result).toBe(msgs)
  })

  test('returns same reference when messages have fewer turns than keepTurns', () => {
    const msgs: Msg[] = [
      assistantToolUse('toolu_1', 'Bash'),
      userToolResult('toolu_1', stubContent('Bash', 1000)),
    ]
    const result = evictOldStubbedMessages(msgs, 2)
    expect(result).toBe(msgs)
  })

  test('evicts fully stubbed tool_use/tool_result pairs beyond keepTurns', () => {
    const msgs: Msg[] = [
      assistantToolUse('toolu_1', 'Grep'),
      userToolResult('toolu_1', stubContent('Grep', 5000)),
      assistantToolUse('toolu_2', 'Read'),
      userToolResult('toolu_2', stubContent('Read', 3000)),
      // Keep region: these survive
      assistantToolUse('toolu_3', 'Bash'),
      userToolResult('toolu_3', 'live output'),
    ]
    const result = evictOldStubbedMessages(msgs, 1)
    // Should evict the first 4 messages (2 pairs), keep last 2
    expect(result.length).toBe(2)
    expect((result[0]!.content as Block[])[0]).toMatchObject({ type: 'tool_use', id: 'toolu_3' })
    expect((result[1]!.content as Block[])[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_3' })
  })

  test('preserves assistant messages with text alongside tool_use', () => {
    const msgs: Msg[] = [
      { role: 'assistant', content: [
        { type: 'text', text: 'Let me search for that.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Grep', input: {} },
      ] },
      userToolResult('toolu_1', stubContent('Grep', 5000)),
      // Keep region
      assistantToolUse('toolu_2', 'Bash'),
      userToolResult('toolu_2', 'live'),
    ]
    const result = evictOldStubbedMessages(msgs, 1)
    // Assistant message has text — not evictable. User message stays too
    // (its tool_use_id is in a non-evictable assistant message).
    expect(result.length).toBe(4)
  })

  test('does not evict user messages with non-stub tool_results', () => {
    const msgs: Msg[] = [
      assistantToolUse('toolu_1', 'Grep'),
      userToolResult('toolu_1', 'full content not yet stubbed'),
      // Keep region
      assistantToolUse('toolu_2', 'Bash'),
      userToolResult('toolu_2', 'live'),
    ]
    const result = evictOldStubbedMessages(msgs, 1)
    // tool_result has full content (not a stub) — can't evict
    expect(result.length).toBe(4)
  })

  test('does not evict user messages with non-tool_result blocks', () => {
    const msgs: Msg[] = [
      assistantToolUse('toolu_1', 'Grep'),
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: stubContent('Grep', 5000) },
        { type: 'text', text: 'also a text block' },
      ] },
      // Keep region
      assistantToolUse('toolu_2', 'Bash'),
      userToolResult('toolu_2', 'live'),
    ]
    const result = evictOldStubbedMessages(msgs, 1)
    // User message has a text block alongside tool_result — can't evict
    expect(result.length).toBe(4)
  })

  test('evicts only evictable pairs, leaves others intact', () => {
    const msgs: Msg[] = [
      // Evictable: pure tool_use + stubbed tool_result
      assistantToolUse('toolu_1', 'Grep'),
      userToolResult('toolu_1', stubContent('Grep', 5000)),
      // Not evictable: assistant has text
      { role: 'assistant', content: [
        { type: 'text', text: 'Here is what I found:' },
        { type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} },
      ] },
      userToolResult('toolu_2', stubContent('Read', 3000)),
      // Evictable
      assistantToolUse('toolu_3', 'Bash'),
      userToolResult('toolu_3', stubContent('Bash', 1000)),
      // Keep region
      assistantToolUse('toolu_4', 'Bash'),
      userToolResult('toolu_4', 'live'),
    ]
    const result = evictOldStubbedMessages(msgs, 1)
    // Should evict pairs 1 and 3, keep pair 2 (has text) and pair 4 (in keep region)
    expect(result.length).toBe(4)
    // Pair 2 (non-evictable assistant + its tool_result)
    expect((result[0]!.content as Block[]).map((b: Block) => b.type)).toEqual(['text', 'tool_use'])
    expect((result[1]!.content as Block[])[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_2' })
    // Pair 4 (keep region)
    expect((result[2]!.content as Block[])[0]).toMatchObject({ type: 'tool_use', id: 'toolu_4' })
    expect((result[3]!.content as Block[])[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_4' })
  })

  test('handles empty messages array', () => {
    const result = evictOldStubbedMessages([], 1)
    expect(result).toEqual([])
  })

  test('RSS regression: 50 turns → much shorter array after stub+evict', () => {
    const msgs: Msg[] = []
    for (let i = 0; i < 50; i++) {
      msgs.push(assistantToolUse(`toolu_${i}`, 'Bash'))
      msgs.push(userToolResult(`toolu_${i}`, 'X'.repeat(50_000)))
    }

    // First stub old results
    const stubbed = pruneOldToolResults(msgs, 1)
    // Then evict fully-stubbed pairs
    const result = evictOldStubbedMessages(stubbed, 1)

    // Only the last turn's pair should survive
    expect(result.length).toBe(2)
    expect((result[0]!.content as Block[])[0]).toMatchObject({ type: 'tool_use', id: 'toolu_49' })
  })
})

describe('evictToMaxSize', () => {
  test('returns same reference when under limit', () => {
    const msgs: Msg[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]
    const result = evictToMaxSize(msgs, 10)
    expect(result).toBe(msgs)
  })

  test('truncates messages from the front when over limit', () => {
    const msgs: Msg[] = []
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: 'assistant', content: [{ type: 'text', text: `msg_${i}` }] })
    }
    const result = evictToMaxSize(msgs, 10)
    expect(result.length).toBe(10)
    // Should keep the last 10 messages
    expect((result[0]!.content as Block[])[0]).toMatchObject({ text: 'msg_10' })
    expect((result[9]!.content as Block[])[0]).toMatchObject({ text: 'msg_19' })
  })

  test('preserves compact boundary message', () => {
    const msgs: Msg[] = []
    for (let i = 0; i < 5; i++) {
      msgs.push({ role: 'assistant', content: [{ type: 'text', text: `old_${i}` }] })
    }
    // Compact boundary at index 5
    msgs.push({ role: 'system', subtype: 'compact_boundary', content: [{ type: 'text', text: 'summary' }] } as Msg)
    for (let i = 0; i < 15; i++) {
      msgs.push({ role: 'assistant', content: [{ type: 'text', text: `new_${i}` }] })
    }
    // Total 21 messages, max 10
    const result = evictToMaxSize(msgs, 10)
    // Should not cut past the compact boundary
    expect(result.some(m => (m as { subtype?: string }).subtype === 'compact_boundary')).toBe(true)
  })

  test('does not split tool_use/tool_result pairs', () => {
    const msgs: Msg[] = []
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: 'assistant', content: [{ type: 'text', text: `text_${i}` }] })
      msgs.push({ role: 'user', content: [{ type: 'text', text: `reply_${i}` }] })
    }
    // Add a tool_use/tool_result pair near the cut point
    msgs.push(assistantToolUse('toolu_1', 'Bash'))
    msgs.push(userToolResult('toolu_1', 'output'))
    msgs.push({ role: 'assistant', content: [{ type: 'text', text: 'final' }] })

    const result = evictToMaxSize(msgs, 10)
    // Should not have orphaned tool_use or tool_result
    const toolUseIdx = result.findIndex(m => {
      const content = (m as Msg).content as Block[] | undefined
      return Array.isArray(content) && content.some(b => b.type === 'tool_use')
    })
    const toolResultIdx = result.findIndex(m => {
      const content = (m as Msg).content as Block[] | undefined
      return Array.isArray(content) && content.some(b => b.type === 'tool_result')
    })
    // If there's a tool_use, there must be a tool_result after it
    if (toolUseIdx !== -1) {
      expect(toolResultIdx).toBeGreaterThan(toolUseIdx)
    }
  })

  test('returns same reference when exactly at limit', () => {
    const msgs: Msg[] = Array.from({ length: 10 }, (_, i) => ({
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: `msg_${i}` }],
    }))
    const result = evictToMaxSize(msgs, 10)
    expect(result).toBe(msgs)
  })

  test('handles very small max (2 messages)', () => {
    const msgs: Msg[] = []
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: 'assistant', content: [{ type: 'text', text: `msg_${i}` }] })
    }
    const result = evictToMaxSize(msgs, 2)
    expect(result.length).toBeLessThanOrEqual(2)
    expect(result.length).toBeGreaterThanOrEqual(1)
  })

  test('skips past tool_use when cut lands on it', () => {
    // Cut point lands exactly on an assistant with tool_use —
    // should skip past the pair, not include a partial/orphaned pair
    const msgs: Msg[] = [
      // indices 0-7: 8 text messages
      ...Array.from({ length: 8 }, (_, i) => ({
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: `text_${i}` }],
      })),
      // index 8: assistant with tool_use (this is where cutAt would land)
      assistantToolUse('toolu_cut', 'Bash'),
      // index 9: tool_result
      userToolResult('toolu_cut', 'output'),
      // index 10-11: trailing messages
      { role: 'assistant', content: [{ type: 'text', text: 'after' }] },
      { role: 'user', content: [{ type: 'text', text: 'reply' }] },
    ]
    // 12 messages, max 4 → excess = 8, cutAt = 8 (lands on tool_use)
    const result = evictToMaxSize(msgs, 4)
    // Should skip past tool_use+tool_result pair → cutAt = 10
    // Result: last 2 messages (indices 10, 11)
    const toolUseIdx = result.findIndex(m => {
      const content = (m as Msg).content as Block[] | undefined
      return Array.isArray(content) && content.some(b => b.type === 'tool_use')
    })
    const toolResultIdx = result.findIndex(m => {
      const content = (m as Msg).content as Block[] | undefined
      return Array.isArray(content) && content.some(b => b.type === 'tool_result')
    })
    // No orphaned tool_use or tool_result
    expect(toolUseIdx).toBe(-1)
    expect(toolResultIdx).toBe(-1)
  })

  test('skips past orphaned tool_result when cut lands on it', () => {
    // Cut point lands on a user message with tool_result —
    // its preceding assistant was already cut, so skip past it
    const msgs: Msg[] = [
      // indices 0-7: 8 text messages
      ...Array.from({ length: 8 }, (_, i) => ({
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: `text_${i}` }],
      })),
      // index 8: assistant with tool_use (will be cut)
      assistantToolUse('toolu_orphan', 'Bash'),
      // index 9: tool_result (cutAt would land here if max forces it)
      userToolResult('toolu_orphan', 'output'),
      // index 10: safe message
      { role: 'assistant', content: [{ type: 'text', text: 'safe' }] },
    ]
    // 11 messages, max 2 → excess = 9, cutAt = 9 (lands on tool_result)
    const result = evictToMaxSize(msgs, 2)
    // Should skip past tool_result → cutAt = 10
    // Result: only the last message
    const toolResultIdx = result.findIndex(m => {
      const content = (m as Msg).content as Block[] | undefined
      return Array.isArray(content) && content.some(b => b.type === 'tool_result')
    })
    expect(toolResultIdx).toBe(-1)
  })

  test('skips multiple consecutive tool_use/tool_result pairs', () => {
    // Cut point lands on a sequence of tool pairs —
    // should skip past all of them
    const msgs: Msg[] = [
      // indices 0-5: 6 text messages
      ...Array.from({ length: 6 }, (_, i) => ({
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: `text_${i}` }],
      })),
      // indices 6-9: two consecutive tool pairs
      assistantToolUse('toolu_a', 'Bash'),
      userToolResult('toolu_a', 'output_a'),
      assistantToolUse('toolu_b', 'Grep'),
      userToolResult('toolu_b', 'output_b'),
      // index 10: safe message
      { role: 'assistant', content: [{ type: 'text', text: 'safe' }] },
    ]
    // 11 messages, max 4 → excess = 7, cutAt = 7 (lands on tool_result of a)
    const result = evictToMaxSize(msgs, 4)
    // Should skip past all tool pairs → cutAt = 10
    const toolUseIdx = result.findIndex(m => {
      const content = (m as Msg).content as Block[] | undefined
      return Array.isArray(content) && content.some(b => b.type === 'tool_use')
    })
    const toolResultIdx = result.findIndex(m => {
      const content = (m as Msg).content as Block[] | undefined
      return Array.isArray(content) && content.some(b => b.type === 'tool_result')
    })
    expect(toolUseIdx).toBe(-1)
    expect(toolResultIdx).toBe(-1)
    expect(result.length).toBe(1)
  })

  test('RSS regression: 500 messages → capped at 200', () => {
    const msgs: Msg[] = []
    for (let i = 0; i < 500; i++) {
      msgs.push(assistantToolUse(`toolu_${i}`, 'Bash'))
      msgs.push(userToolResult(`toolu_${i}`, 'output'))
    }
    // 1000 total messages
    const result = evictToMaxSize(msgs, 200)
    expect(result.length).toBeLessThanOrEqual(200)
  })
})

describe('pruneContentReplacementState', () => {
  function makeState(ids: string[], replacementIds: string[] = ids) {
    return {
      seenIds: new Set(ids),
      replacements: new Map(replacementIds.map(id => [id, `[preview ${id}]`])),
    }
  }

  test('removes seenIds for tool_use_ids no longer in messages', () => {
    const msgs = [
      assistantToolUse('keep-1', 'Bash'),
      userToolResult('keep-1', 'output'),
    ]
    const state = makeState(['keep-1', 'gone-1', 'gone-2'])

    pruneContentReplacementState(msgs, state)

    expect(state.seenIds.has('keep-1')).toBe(true)
    expect(state.seenIds.has('gone-1')).toBe(false)
    expect(state.seenIds.has('gone-2')).toBe(false)
  })

  test('removes replacements for tool_use_ids no longer in messages', () => {
    const msgs = [
      assistantToolUse('keep-1', 'Bash'),
      userToolResult('keep-1', 'output'),
    ]
    const state = makeState(['keep-1', 'gone-1'], ['keep-1', 'gone-1'])

    pruneContentReplacementState(msgs, state)

    expect(state.replacements.has('keep-1')).toBe(true)
    expect(state.replacements.has('gone-1')).toBe(false)
  })

  test('detects live IDs from tool_result blocks (not just tool_use)', () => {
    // Only tool_result message, no corresponding assistant tool_use
    const msgs = [userToolResult('from-result', 'output')]
    const state = makeState(['from-result', 'orphan'])

    pruneContentReplacementState(msgs, state)

    expect(state.seenIds.has('from-result')).toBe(true)
    expect(state.seenIds.has('orphan')).toBe(false)
  })

  test('handles empty messages — removes everything', () => {
    const state = makeState(['id-1', 'id-2'], ['id-1'])

    pruneContentReplacementState([], state)

    expect(state.seenIds.size).toBe(0)
    expect(state.replacements.size).toBe(0)
  })

  test('no-op when all IDs are still present', () => {
    const msgs = [
      assistantToolUse('a', 'Bash'),
      userToolResult('a', 'out'),
      assistantToolUse('b', 'Grep'),
      userToolResult('b', 'out'),
    ]
    const state = makeState(['a', 'b'], ['a', 'b'])
    const seenBefore = state.seenIds.size
    const replBefore = state.replacements.size

    pruneContentReplacementState(msgs, state)

    expect(state.seenIds.size).toBe(seenBefore)
    expect(state.replacements.size).toBe(replBefore)
  })

  test('preserves object identity (mutates in-place)', () => {
    const msgs = [assistantToolUse('keep', 'Bash')]
    const state = makeState(['keep', 'gone'])
    const originalSeenRef = state.seenIds
    const originalReplRef = state.replacements

    pruneContentReplacementState(msgs, state)

    expect(state.seenIds).toBe(originalSeenRef)
    expect(state.replacements).toBe(originalReplRef)
  })

  test('full eviction pipeline: evictToMaxSize + pruneContentReplacementState', () => {
    // Build 300 tool pairs → 600 messages total
    const msgs: Msg[] = []
    for (let i = 0; i < 300; i++) {
      msgs.push(assistantToolUse(`toolu_${i}`, 'Bash'))
      msgs.push(userToolResult(`toolu_${i}`, 'output'))
    }

    // Simulate contentReplacementState tracking all 300 IDs
    const state = makeState(
      Array.from({ length: 300 }, (_, i) => `toolu_${i}`),
      Array.from({ length: 300 }, (_, i) => `toolu_${i}`),
    )
    expect(state.seenIds.size).toBe(300)
    expect(state.replacements.size).toBe(300)

    // Evict to 200 messages
    const after = evictToMaxSize(msgs, 200)
    expect(after.length).toBeLessThanOrEqual(200)

    // Prune orphaned state entries
    pruneContentReplacementState(after, state)

    // seenIds and replacements should only contain IDs still in the array
    expect(state.seenIds.size).toBeLessThanOrEqual(200)
    expect(state.replacements.size).toBeLessThanOrEqual(200)

    // Every remaining ID should be present in the surviving messages
    for (const id of state.seenIds) {
      const inMessages = after.some(m => {
        const content = (m as Msg).content as Block[] | undefined
        return Array.isArray(content) && content.some(
          b => (b as Block).tool_use_id === id || (b as Block).id === id,
        )
      })
      expect(inMessages).toBe(true)
    }
  })

  test('full eviction pipeline: evictOldStubbedMessages + pruneContentReplacementState', () => {
    // Build messages with old stubbed tool pairs + recent ones
    const stub = buildClipStub('Bash', 5000)
    const msgs: Msg[] = [
      // Old: fully stubbed pair (evictable)
      assistantToolUse('old-1', 'Bash'),
      userToolResult('old-1', stub),
      assistantToolUse('old-2', 'Grep'),
      userToolResult('old-2', stub),
      // Recent: still has real content (kept)
      assistantToolUse('keep-1', 'Bash'),
      userToolResult('keep-1', 'real output'),
      { role: 'user', content: [{ type: 'text', text: 'latest user message' }] },
    ]

    // Simulate contentReplacementState tracking all IDs
    const state = makeState(
      ['old-1', 'old-2', 'keep-1'],
      ['old-1', 'old-2', 'keep-1'],
    )

    // Register old IDs as clipped so they're recognized as stubs
    addClippedIds(['old-1', 'old-2'])

    const after = evictOldStubbedMessages(msgs, 1)
    expect(after.length).toBeLessThan(msgs.length)

    // Prune orphaned state entries
    pruneContentReplacementState(after, state)

    // old-1 and old-2 should be gone
    expect(state.seenIds.has('old-1')).toBe(false)
    expect(state.seenIds.has('old-2')).toBe(false)
    expect(state.replacements.has('old-1')).toBe(false)
    expect(state.replacements.has('old-2')).toBe(false)

    // keep-1 should still be present
    expect(state.seenIds.has('keep-1')).toBe(true)
    expect(state.replacements.has('keep-1')).toBe(true)
  })

  test('mixed messages: non-tool messages are ignored, tool IDs are pruned', () => {
    const msgs: Msg[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      assistantToolUse('a', 'Bash'),
      userToolResult('a', 'out'),
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ]
    const state = makeState(['a', 'b', 'c'], ['a', 'b'])

    pruneContentReplacementState(msgs, state)

    expect(state.seenIds.has('a')).toBe(true)
    expect(state.seenIds.has('b')).toBe(false)
    expect(state.seenIds.has('c')).toBe(false)
    expect(state.replacements.has('a')).toBe(true)
    expect(state.replacements.has('b')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Clip frontier (design doc: Clip-Frontier Cache Breakpoint, Phase 1)
// ---------------------------------------------------------------------------

function bigText(tokens: number): string {
  // roughTokenCountEstimation ≈ chars/4
  return 'x'.repeat(tokens * 4)
}

function userText(text: string): Msg {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function assistantText(text: string): Msg {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

describe('getClipFrontierIndex', () => {
  test('text-only conversation → entire array is stable (length-1)', () => {
    const msgs: Msg[] = [
      userText('hello'),
      assistantText('hi'),
      userText('more'),
      assistantText('done'),
    ]
    expect(getClipFrontierIndex(msgs)).toBe(msgs.length - 1)
  })

  test('empty array → -1 (no stable prefix to mark)', () => {
    expect(getClipFrontierIndex([])).toBe(-1)
  })

  test('full tool_result ≥ MIN_STUB_TOKENS is mutable → frontier stops before it', () => {
    const msgs: Msg[] = [
      userText('prompt'),
      assistantToolUse('a', 'Bash'),
      userToolResult('a', bigText(500)), // age prune will stub this
      assistantText('summary'),
    ]
    expect(getClipFrontierIndex(msgs)).toBe(1)
  })

  test('already-stubbed results are stable → frontier passes them', () => {
    const msgs: Msg[] = [
      userText('prompt'),
      assistantToolUse('a', 'Bash'),
      userToolResult('a', buildClipStub('Bash', 5000)),
      assistantToolUse('b', 'Grep'),
      userToolResult('b', bigText(500)), // newest full result — mutable
      assistantText('working...'),
    ]
    expect(getClipFrontierIndex(msgs)).toBe(3)
  })

  test('small (< MIN_STUB_TOKENS) results are stable', () => {
    const msgs: Msg[] = [
      assistantToolUse('a', 'Bash'),
      userToolResult('a', 'short output'), // ~3 tokens, prune skips it
      assistantText('ok'),
    ]
    expect(getClipFrontierIndex(msgs)).toBe(msgs.length - 1)
  })

  test('is_error results are stable (age prune skips them)', () => {
    const msgs: Msg[] = [
      assistantToolUse('a', 'Bash'),
      userToolResult('a', bigText(500), { is_error: true }),
      assistantText('ok'),
    ]
    expect(getClipFrontierIndex(msgs)).toBe(msgs.length - 1)
  })

  test('image-bearing results outside clippedIds are stable', () => {
    const msgs: Msg[] = [
      assistantToolUse('a', 'Read'),
      userToolResult('a', [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x'.repeat(8000) } },
      ]),
      assistantText('ok'),
    ]
    expect(getClipFrontierIndex(msgs)).toBe(msgs.length - 1)
  })

  test('image-bearing result with id in clippedIds is mutable (deferred clip)', () => {
    addClippedIds(['a'])
    const msgs: Msg[] = [
      assistantToolUse('a', 'Read'),
      userToolResult('a', [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x'.repeat(8000) } },
      ]),
      assistantText('ok'),
    ]
    expect(getClipFrontierIndex(msgs)).toBe(0)
  })

  test('id in clippedIds with non-stub text is mutable even when small or error', () => {
    addClippedIds(['a'])
    const msgs: Msg[] = [
      assistantToolUse('a', 'Bash'),
      userToolResult('a', 'tiny', { is_error: true }),
      assistantText('ok'),
    ]
    // applyStableStubs honors clippedIds regardless of size/is_error
    expect(getClipFrontierIndex(msgs)).toBe(0)
  })

  test('empty content is stable (stubOneBlock leaves it unchanged)', () => {
    addClippedIds(['a', 'b'])
    const msgs: Msg[] = [
      assistantToolUse('a', 'Bash'),
      userToolResult('a', ''),
      assistantToolUse('b', 'Grep'),
      userToolResult('b', []),
    ]
    expect(getClipFrontierIndex(msgs)).toBe(msgs.length - 1)
  })

  test('first message mutable → -1', () => {
    const msgs: Msg[] = [userToolResult('a', bigText(500))]
    expect(getClipFrontierIndex(msgs)).toBe(-1)
  })

  test('thinking blocks: mutable only when thinkingIsMutable is set', () => {
    const msgs: Msg[] = [
      userText('prompt'),
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig' },
          { type: 'text', text: 'answer' },
        ],
      },
      userText('next'),
    ]
    expect(getClipFrontierIndex(msgs)).toBe(msgs.length - 1)
    expect(getClipFrontierIndex(msgs, { thinkingIsMutable: true })).toBe(0)
  })

  test('redacted_thinking is never mutable (API requires verbatim echo)', () => {
    const msgs: Msg[] = [
      userText('prompt'),
      {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'opaque' },
          { type: 'text', text: 'answer' },
        ],
      },
    ]
    expect(getClipFrontierIndex(msgs, { thinkingIsMutable: true })).toBe(
      msgs.length - 1,
    )
  })

  test('narration (text + tool_use, no thinking): mutable only when narrationIsMutable', () => {
    const narrationTurn: Msg = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me check that file' },
        { type: 'tool_use', id: 'a', name: 'Read', input: {} },
      ],
    }
    const msgs: Msg[] = [userText('prompt'), narrationTurn, userToolResult('a', 'ok')]
    expect(getClipFrontierIndex(msgs)).toBe(msgs.length - 1)
    expect(getClipFrontierIndex(msgs, { narrationIsMutable: true })).toBe(0)
  })

  test('narration rule skips thinking-bearing turns (mirrors stripOldNarrationBlocks)', () => {
    const msgs: Msg[] = [
      userText('prompt'),
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig' },
          { type: 'text', text: 'narrating' },
          { type: 'tool_use', id: 'a', name: 'Read', input: {} },
        ],
      },
      userToolResult('a', 'ok'),
    ]
    // narration-only: the thinking-bearing turn is never text-stripped
    expect(getClipFrontierIndex(msgs, { narrationIsMutable: true })).toBe(
      msgs.length - 1,
    )
    // …but the thinking redaction itself still makes it mutable
    expect(
      getClipFrontierIndex(msgs, {
        narrationIsMutable: true,
        thinkingIsMutable: true,
      }),
    ).toBe(0)
  })

  test('already-stripped narration turn (tool_use only) is stable', () => {
    const msgs: Msg[] = [
      userText('prompt'),
      assistantToolUse('a', 'Read'), // post-strip shape: no text block
      userToolResult('a', buildClipStub('Read', 3000)),
    ]
    expect(getClipFrontierIndex(msgs, { narrationIsMutable: true })).toBe(
      msgs.length - 1,
    )
  })

  test('works with .message-wrapped messages (UserMessage/AssistantMessage shape)', () => {
    const msgs: Msg[] = [
      { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      {
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'a', content: bigText(500) }],
        },
      },
    ]
    expect(getClipFrontierIndex(msgs)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Prefix byte-stability invariant (design doc Phase 2)
// ---------------------------------------------------------------------------

describe('clip-frontier prefix invariant', () => {
  test('pruneOldToolResults is idempotent (second pass returns same ref)', () => {
    const msgs: Msg[] = [
      assistantToolUse('a', 'Bash'),
      userToolResult('a', bigText(500)),
      userText('next turn'),
      assistantToolUse('b', 'Grep'),
      userToolResult('b', bigText(400)),
    ]
    const once = pruneOldToolResults(msgs, 1)
    expect(once).not.toBe(msgs)
    const twice = pruneOldToolResults(once, 1)
    expect(twice).toBe(once)
  })

  test('applyStableStubs after prune is identity when all clipped ids are already stubs', () => {
    addClippedIds(['a'])
    const msgs: Msg[] = [
      assistantToolUse('a', 'Bash'),
      userToolResult('a', bigText(500)),
      userText('next'),
    ]
    const stubbed = applyStableStubs(msgs)
    expect(stubbed).not.toBe(msgs)
    expect(applyStableStubs(stubbed)).toBe(stubbed)
  })

  test('multi-turn simulation: bytes behind the frontier never change', () => {
    // Simulates the per-turn loop: each turn appends a tool_use/tool_result
    // pair, the age prune runs (QueryEngine.ts pruneOldToolResults(…, 1)),
    // and the renderer computes the frontier. The invariant: the serialized
    // prefix [0..frontier] from turn N is a byte-prefix of turn N+1's array.
    let msgs: Msg[] = [userText('initial prompt')]
    let prevFrontier = -1
    let prevPrefixBytes = ''

    for (let turn = 0; turn < 8; turn++) {
      const id = `toolu_${turn}`
      msgs = [
        ...msgs,
        assistantToolUse(id, 'Bash'),
        userToolResult(id, bigText(300 + turn)),
      ]
      msgs = pruneOldToolResults(msgs, 1)
      msgs = applyStableStubs(msgs)

      const frontier = getClipFrontierIndex(msgs)

      // Frontier never regresses
      expect(frontier).toBeGreaterThanOrEqual(prevFrontier)

      // Previous frozen prefix is byte-identical in the current array
      if (prevFrontier >= 0) {
        const currentPrefix = JSON.stringify(msgs.slice(0, prevFrontier + 1))
        expect(currentPrefix).toBe(prevPrefixBytes)
      }

      prevFrontier = frontier
      prevPrefixBytes = JSON.stringify(msgs.slice(0, frontier + 1))
    }
  })

  test('multi-turn simulation with explicit clips (clippedIds) keeps the invariant', () => {
    let msgs: Msg[] = [userText('initial prompt')]
    let prevFrontier = -1
    let prevPrefixBytes = ''

    for (let turn = 0; turn < 6; turn++) {
      const id = `toolu_${turn}`
      msgs = [
        ...msgs,
        assistantToolUse(id, 'Read'),
        userToolResult(id, bigText(400)),
      ]
      // Every other turn, microcompact-style explicit clip of the previous id
      if (turn > 0 && turn % 2 === 0) addClippedIds([`toolu_${turn - 1}`])

      msgs = pruneOldToolResults(msgs, 1)
      msgs = applyStableStubs(msgs)

      const frontier = getClipFrontierIndex(msgs)
      expect(frontier).toBeGreaterThanOrEqual(prevFrontier)
      if (prevFrontier >= 0) {
        expect(JSON.stringify(msgs.slice(0, prevFrontier + 1))).toBe(
          prevPrefixBytes,
        )
      }
      prevFrontier = frontier
      prevPrefixBytes = JSON.stringify(msgs.slice(0, frontier + 1))
    }
  })
})

// ---------------------------------------------------------------------------
// RSS byte-guard prune (cache-profile 'retain', design doc Phase 5)
// ---------------------------------------------------------------------------

describe('pruneToolResultsByBytes', () => {
  function conversation(fileTokens: number[], tailTurns = 2): Msg[] {
    // Builds: prompt, then per file: asst(tool_use) + user(tool_result full),
    // then `tailTurns` extra small user turns so the cutoff walk has room.
    const msgs: Msg[] = [userText('prompt')]
    fileTokens.forEach((tok, i) => {
      msgs.push(assistantToolUse(`t${i}`, 'Read'))
      msgs.push(userToolResult(`t${i}`, bigText(tok)))
    })
    for (let i = 0; i < tailTurns; i++) msgs.push(userText(`tail ${i}`))
    return msgs
  }

  test('identity under the high water', () => {
    const msgs = conversation([500, 500, 500])
    expect(pruneToolResultsByBytes(msgs, 10_000, 5_000)).toBe(msgs)
  })

  test('identity when guard disabled (Infinity)', () => {
    const msgs = conversation([5_000, 5_000])
    expect(pruneToolResultsByBytes(msgs, Infinity, Infinity)).toBe(msgs)
  })

  test('over the high water → stubs oldest-first down to the low water', () => {
    // Each block estimates to ~1143 tok (4000 chars / 3.5), total ~4572.
    const msgs = conversation([1_000, 1_000, 1_000, 1_000])
    const out = pruneToolResultsByBytes(msgs, 3_000, 2_400)
    expect(out).not.toBe(msgs)
    // Oldest results stubbed until remaining ≤ 2000: stub t0, t1 (4k→2k)
    const tr = (i: number) => ((out[2 + i * 2].content as Block[])[0] as { content: string }).content
    expect(tr(0)).toMatch(/^\[clipped: ~\d+ tokens from Read\]$/)
    expect(tr(1)).toMatch(/^\[clipped: ~\d+ tokens from Read\]$/)
    expect(tr(2)).not.toMatch(/^\[clipped:/)
    expect(tr(3)).not.toMatch(/^\[clipped:/)
  })

  test('never touches the last keepRecentTurns user turns even under pressure', () => {
    // Two huge results, no tail turns: the results themselves are the last
    // user messages — both inside the keep window of 2 → identity.
    const msgs = conversation([50_000, 50_000], 0)
    expect(pruneToolResultsByBytes(msgs, 1_000, 500, 2)).toBe(msgs)
  })

  test('skips errors, images, small results and existing stubs in the pressure count', () => {
    const msgs: Msg[] = [
      userText('prompt'),
      assistantToolUse('err', 'Bash'),
      userToolResult('err', bigText(5_000), { is_error: true }),
      assistantToolUse('img', 'Read'),
      userToolResult('img', [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x'.repeat(9000) } },
      ]),
      assistantToolUse('small', 'Bash'),
      userToolResult('small', 'tiny'),
      assistantToolUse('stub', 'Grep'),
      userToolResult('stub', buildClipStub('Grep', 9000)),
      userText('tail 1'),
      userText('tail 2'),
    ]
    // None of these count toward pressure → identity even with tiny high water
    expect(pruneToolResultsByBytes(msgs, 100, 50)).toBe(msgs)
  })

  test('idempotent: second pass over the pruned output is identity', () => {
    const msgs = conversation([2_000, 2_000, 2_000])
    const once = pruneToolResultsByBytes(msgs, 3_000, 1_500)
    expect(once).not.toBe(msgs)
    expect(pruneToolResultsByBytes(once, 3_000, 1_500)).toBe(once)
  })
})

describe('getClipFrontierIndex — agePruneActive (retain profile)', () => {
  test('full tool_results are stable when the age prune is off', () => {
    const msgs: Msg[] = [
      userText('prompt'),
      assistantToolUse('a', 'Read'),
      userToolResult('a', bigText(5_000)),
      assistantToolUse('b', 'Read'),
      userToolResult('b', bigText(5_000)),
    ]
    // Aggressive (default): first full result is mutable → frontier stops early
    expect(getClipFrontierIndex(msgs)).toBe(1)
    // Retain: nothing ages → whole array is byte-stable
    expect(getClipFrontierIndex(msgs, { agePruneActive: false })).toBe(msgs.length - 1)
  })

  test('clippedIds-pending blocks stay mutable even with age prune off', () => {
    addClippedIds(['a'])
    const msgs: Msg[] = [
      userText('prompt'),
      assistantToolUse('a', 'Read'),
      userToolResult('a', bigText(5_000)),
      assistantText('done'),
    ]
    expect(getClipFrontierIndex(msgs, { agePruneActive: false })).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Head-preserving stubs (openclaude mid-tier idea, single-mutation form)
// ---------------------------------------------------------------------------

describe('head-preserving stubs', () => {
  const HEAD = 1000

  test('age prune with stubKeepHeadChars keeps the head + marker, single mutation', () => {
    const content = 'LINE1 header info\n' + 'x'.repeat(20_000)
    const msgs: Msg[] = [
      assistantToolUse('a', 'Read'),
      userToolResult('a', content),
      userText('next turn'),
    ]
    const once = pruneOldToolResults(msgs, 1, HEAD)
    const block = (once[1].content as Block[])[0] as { content: string }
    expect(block.content.startsWith('LINE1 header info\n')).toBe(true)
    expect(block.content).toMatch(/\n\[clipped: ~\d+ tokens from Read — head preserved\]$/)
    expect(block.content.length).toBeLessThan(HEAD + 100)
    // Idempotent: second pass returns the same reference
    expect(pruneOldToolResults(once, 1, HEAD)).toBe(once)
  })

  test('byte-stable: two independent stub passes produce identical bytes', () => {
    const content = 'y'.repeat(30_000)
    const build = () =>
      pruneOldToolResults(
        [
          assistantToolUse('a', 'Bash'),
          userToolResult('a', content),
          userText('next'),
        ] as Msg[],
        1,
        HEAD,
      )
    const b1 = ((build()[1].content as Block[])[0] as { content: string }).content
    const b2 = ((build()[1].content as Block[])[0] as { content: string }).content
    expect(b1).toBe(b2)
  })

  test('content barely above the floor gets the pure stub (no pointless head)', () => {
    // > MIN_STUB_TOKENS (100 tok ≈ 400+ chars) but < headChars + 500 margin
    const content = 'z'.repeat(1200)
    const msgs: Msg[] = [
      assistantToolUse('a', 'Bash'),
      userToolResult('a', content),
      userText('next'),
    ]
    const out = pruneOldToolResults(msgs, 1, HEAD)
    const block = (out[1].content as Block[])[0] as { content: string }
    expect(block.content).toMatch(/^\[clipped: ~\d+ tokens from Bash\]$/)
  })

  test('head-stub is stable for the clip frontier', () => {
    const msgs: Msg[] = [
      userText('prompt'),
      assistantToolUse('a', 'Read'),
      userToolResult('a', 'head text\n' + 'x'.repeat(9000)),
      userText('next'),
    ]
    const stubbed = pruneOldToolResults(msgs, 1, HEAD)
    expect(getClipFrontierIndex(stubbed)).toBe(stubbed.length - 1)
  })

  test('display stub keeps the head when stubKeepHeadChars is set', () => {
    const big = 'HEADER\n' + 'q'.repeat(40_000)
    const msgs: Msg[] = [assistantToolUse('a', 'Read')]
    const message = userToolResult('a', big)
    const out = stubToolResultForDisplay(message, msgs, 2000, HEAD)
    const block = (out.content as Block[])[0] as { content: string }
    expect(block.content.startsWith('HEADER\n')).toBe(true)
    expect(block.content).toMatch(/head preserved\]$/)
    // Re-applying is a no-op (already-stubbed detection covers the head form)
    expect(stubToolResultForDisplay(out, msgs, 2000, HEAD)).toBe(out)
  })

  test('byte-guard applies heads and still drains below the low water', () => {
    const msgs: Msg[] = [
      userText('prompt'),
      assistantToolUse('a', 'Read'),
      userToolResult('a', 'A'.repeat(40_000)),
      assistantToolUse('b', 'Read'),
      userToolResult('b', 'B'.repeat(40_000)),
      userText('tail 1'),
      userText('tail 2'),
    ]
    const out = pruneToolResultsByBytes(msgs, 5_000, 1_000, 2, HEAD)
    expect(out).not.toBe(msgs)
    const tr1 = (out[2].content as Block[])[0] as { content: string }
    expect(tr1.content).toMatch(/head preserved\]$/)
    expect(tr1.content.startsWith('AAAA')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Review fixes regression tests (code-review findings)
// ---------------------------------------------------------------------------

describe('review fixes', () => {
  test('explicit clip and age prune produce IDENTICAL bytes for the same content (no wire flip)', () => {
    const content = 'HEAD line\n' + 'x'.repeat(20_000)
    // Path 1: explicit clip via clippedIds (applyStableStubs)
    addClippedIds(['a'])
    const viaClip = applyStableStubs([
      assistantToolUse('a', 'Read'),
      userToolResult('a', content),
    ] as Msg[])
    const clipBytes = ((viaClip[1].content as Block[])[0] as { content: string }).content
    resetClippedIds()
    // Path 2: age prune with the SAME profile head setting
    const { getCacheProfile } = require('../cache/cacheProfile.js')
    const viaPrune = pruneOldToolResults(
      [
        assistantToolUse('a', 'Read'),
        userToolResult('a', content),
        userText('next'),
      ] as Msg[],
      1,
      getCacheProfile().stubKeepHeadChars,
    )
    const pruneBytes = ((viaPrune[1].content as Block[])[0] as { content: string }).content
    expect(clipBytes).toBe(pruneBytes)
  })

  test('huge content merely ENDING with a head-stub marker line is NOT treated as a stub', () => {
    const fakeTail = 'y'.repeat(100_000) + '\n[clipped: ~123 tokens from Bash — head preserved]'
    const msgs: Msg[] = [
      assistantToolUse('a', 'Bash'),
      userToolResult('a', fakeTail),
      userText('next'),
    ]
    const out = pruneOldToolResults(msgs, 1, 0)
    const block = (out[1].content as Block[])[0] as { content: string }
    // It must have been re-stubbed (prunable), not exempted
    expect(block.content.length).toBeLessThan(1000)
  })

  test('byte-guard trigger counts only CLEARABLE (pre-cutoff) tokens', () => {
    // Huge results inside the protected window must NOT trip the guard
    const msgs: Msg[] = [
      userText('prompt'),
      assistantToolUse('old', 'Read'),
      userToolResult('old', bigText(1_000)), // small clearable
      assistantToolUse('big1', 'Read'),
      userToolResult('big1', bigText(100_000)), // protected (last 2 user turns)
      assistantToolUse('big2', 'Read'),
      userToolResult('big2', bigText(100_000)), // protected
    ]
    expect(pruneToolResultsByBytes(msgs, 50_000, 25_000, 2)).toBe(msgs)
  })

  test('pruneOldToolResults short-circuits on keepTurns=Infinity', () => {
    const msgs: Msg[] = [
      assistantToolUse('a', 'Read'),
      userToolResult('a', bigText(5_000)),
      userText('next'),
    ]
    expect(pruneOldToolResults(msgs, Infinity)).toBe(msgs)
  })

  test('frontier treats image results as mutable when imagesAreMutable (media cap active)', () => {
    const msgs: Msg[] = [
      userText('prompt'),
      assistantToolUse('a', 'Read'),
      userToolResult('a', [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x'.repeat(8000) } },
      ]),
      userText('next'),
    ]
    expect(getClipFrontierIndex(msgs)).toBe(msgs.length - 1)
    expect(getClipFrontierIndex(msgs, { imagesAreMutable: true })).toBe(1)
  })

  test('evictOldStubbedMessages deliberately KEEPS pairs holding HEAD-form stubs', () => {
    // Head-stubs carry content the model still uses, and eviction REMOVES
    // messages from the array that seeds the next turn's API view — a
    // prefix mutation the clip frontier cannot anticipate. Pure stubs only.
    const headStub = 'some head\n[clipped: ~5000 tokens from Read — head preserved]'
    const msgs: Msg[] = [
      assistantToolUse('a', 'Read'),
      userToolResult('a', headStub),
      userText('turn 1'),
      { role: 'assistant', content: [{ type: 'text', text: 'r1' }] },
      userText('turn 2'),
      { role: 'assistant', content: [{ type: 'text', text: 'r2' }] },
    ]
    expect(evictOldStubbedMessages(msgs, 2)).toBe(msgs)
  })

  test('CLAUDIN_STUB_HEAD_CHARS env override is clamped below the plausibility bound', () => {
    const { getCacheProfile, _resetCacheProfileForTesting } = require('../cache/cacheProfile.js')
    process.env.CLAUDIN_STUB_HEAD_CHARS = '40000'
    _resetCacheProfileForTesting()
    expect(getCacheProfile().stubKeepHeadChars).toBeLessThanOrEqual(24_000)
    delete process.env.CLAUDIN_STUB_HEAD_CHARS
    _resetCacheProfileForTesting()
  })
})

// ---------------------------------------------------------------------------
// Pinned tool_results — the exemption FileReadTool's clip-pin stand-down uses.
// A pinned id is content the model already lost once and asked for again, so
// every clip path must leave it alone; without that the re-send is clipped on
// the next pass and the re-read loops forever.
// ---------------------------------------------------------------------------

describe('pinned tool_results', () => {
  // Fat enough to be worth clipping, comfortably UNDER the protection ceiling
  // so every test below exercises a pin that is actually honoured. Derived so
  // that lowering MAX_PINNED_RESULT_TOKENS cannot silently turn these into
  // over-ceiling cases that pass for the wrong reason.
  const bigContent = 'A'.repeat(MAX_PINNED_RESULT_TOKENS / 2)

  /** Two turns: the first holds `id`'s fat result, the second is current. */
  function twoTurns(id: string): Msg[] {
    return [
      assistantToolUse(id, 'Read'),
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: id, content: bigContent },
        ],
      },
      assistantToolUse('toolu_cur', 'Grep'),
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_cur', content: 'fresh' },
        ],
      },
    ]
  }

  function contentOf(msg: Msg, index = 0): string {
    return ((msg.content as Block[])[index] as { content: string }).content
  }

  test('the age prune skips a pinned result and still clips an unpinned one', () => {
    const pinned = twoTurns('toolu_pinned')
    pinToolResult('toolu_pinned')
    expect(pruneOldToolResults(pinned, 1)).toBe(pinned)
    expect(contentOf(pinned[1])).toBe(bigContent)

    // Control: the identical shape without a pin IS clipped.
    const unpinned = twoTurns('toolu_plain')
    const result = pruneOldToolResults(unpinned, 1)
    expect(result).not.toBe(unpinned)
    expect(contentOf(result[1])).toMatch(/^\[clipped: ~\d+ tokens from Read/)
  })

  test('applyStableStubs skips a pinned id even when it is in clippedIds', () => {
    const messages = twoTurns('toolu_pinned')
    addClippedIds(['toolu_pinned'])
    pinToolResult('toolu_pinned')

    expect(applyStableStubs(messages)).toBe(messages)
    expect(contentOf(messages[1])).toBe(bigContent)

    // Unpinning re-arms the pending clip — the pin defers, it does not cancel.
    unpinToolResult('toolu_pinned')
    const result = applyStableStubs(messages)
    expect(result).not.toBe(messages)
    // This path stubs with the profile's head-preserving form, so the marker
    // is the tail of the content rather than the whole of it.
    expect(contentOf(result[1])).toMatch(/\[clipped: ~\d+ tokens from Read/)
  })

  test('the RSS byte-guard skips a pinned result', () => {
    const messages = twoTurns('toolu_pinned')
    pinToolResult('toolu_pinned')
    // keepRecentTurns=1: the cutoff lands after turn 1, so the fat result IS a
    // candidate. (With the default 2 the cutoff is index 0 and the guard bails
    // before looking at anything — which made an earlier version of this test
    // tautological: it passed with the pin check deleted.)
    expect(pruneToolResultsByBytes(messages, 1, 0, 1)).toBe(messages)
    expect(contentOf(messages[1])).toBe(bigContent)

    // Control: same call, no pin → the guard really does clip here.
    const unpinned = twoTurns('toolu_plain')
    const clipped = pruneToolResultsByBytes(unpinned, 1, 0, 1)
    expect(clipped).not.toBe(unpinned)
    expect(contentOf(clipped[1])).toMatch(/\[clipped: ~\d+ tokens from Read/)
  })

  test('the immediate display stub skips a pinned result', () => {
    const message: Msg = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_pinned', content: bigContent },
      ],
    }
    const all: Msg[] = [assistantToolUse('toolu_pinned', 'Read'), message]

    pinToolResult('toolu_pinned')
    expect(stubToolResultForDisplay(message, all, 10)).toBe(message)

    unpinToolResult('toolu_pinned')
    const stubbed = stubToolResultForDisplay(message, all, 10)
    expect(stubbed).not.toBe(message)
    expect(contentOf(stubbed)).toMatch(/^\[clipped: ~\d+ tokens from Read/)
  })

  test('the clip frontier ignores pins (no immutability promise)', () => {
    // Deliberate: the pin can be dropped later, so a pinned full result must
    // not be advertised as frozen — the frontier must stop before it either
    // way. Guards the decision recorded in the pin registry comment.
    const msgs = twoTurns('toolu_pinned')
    const before = getClipFrontierIndex(msgs)
    pinToolResult('toolu_pinned')
    expect(getClipFrontierIndex(msgs)).toBe(before)
  })

  test('shielding slots are capped at 16, oldest first', () => {
    for (let i = 0; i < 17; i++) pinToolResult(`toolu_${i}`)
    expect(_getPinnedToolResultsForTesting().size).toBe(16)
    expect(_getPinnedToolResultsForTesting().has('toolu_0')).toBe(false)
    expect(_getPinnedToolResultsForTesting().has('toolu_16')).toBe(true)
  })

  test('losing a slot retires the id instead of forgetting it', () => {
    // The state machine keys on "did this copy already get its protected
    // re-send?". Forgetting an evicted id answers no, so FileReadTool re-sends
    // and re-pins, evicting someone else's pin, who then re-sends — one full
    // body per rotation, forever. Retiring keeps the answer yes.
    for (let i = 0; i < 17; i++) pinToolResult(`toolu_${i}`)
    expect(_getPinnedToolResultsForTesting().has('toolu_0')).toBe(false)
    expect(_getSpentPinIdsForTesting().has('toolu_0')).toBe(true)
    expect(isPinRegistered('toolu_0')).toBe(true)
  })

  test('re-pinning refreshes recency instead of adding a slot', () => {
    pinToolResult('toolu_first')
    for (let i = 1; i < 16; i++) pinToolResult(`toolu_${i}`)
    expect(_getPinnedToolResultsForTesting().size).toBe(16)
    // Touch the oldest, then overflow by one: the NEXT-oldest is evicted.
    pinToolResult('toolu_first')
    pinToolResult('toolu_overflow')
    expect(_getPinnedToolResultsForTesting().has('toolu_first')).toBe(true)
    expect(_getPinnedToolResultsForTesting().has('toolu_1')).toBe(false)
  })

  test('re-pinning a spent id makes it shield again', () => {
    for (let i = 0; i < 17; i++) pinToolResult(`toolu_${i}`)
    expect(_getSpentPinIdsForTesting().has('toolu_0')).toBe(true)
    pinToolResult('toolu_0')
    expect(_getPinnedToolResultsForTesting().has('toolu_0')).toBe(true)
    expect(_getSpentPinIdsForTesting().has('toolu_0')).toBe(false)
  })

  test('unpinning clears both registries so a later clip starts over', () => {
    // unpin means "the protection is no longer owed" (the model demonstrably
    // has the content, or the entry that vouched for it is gone). Leaving the
    // id spent would make a genuinely new clip → re-read skip the one re-send
    // it is entitled to and jump straight to the outline.
    for (let i = 0; i < 17; i++) pinToolResult(`toolu_${i}`)
    unpinToolResult('toolu_0')
    unpinToolResult('toolu_16')
    expect(isPinRegistered('toolu_0')).toBe(false)
    expect(isPinRegistered('toolu_16')).toBe(false)
  })

  test('an empty id is never pinned', () => {
    pinToolResult('')
    expect(_getPinnedToolResultsForTesting().size).toBe(0)
  })

  test('pruneOrphanClippedIds drops pins whose tool_result is gone', () => {
    const messages = twoTurns('toolu_live')
    pinToolResult('toolu_live')
    pinToolResult('toolu_dead')

    pruneOrphanClippedIds(messages as never)
    expect(isPinRegistered('toolu_live')).toBe(true)
    expect(isPinRegistered('toolu_dead')).toBe(false)
  })

  test('resetClippedIds clears the pins too', () => {
    pinToolResult('toolu_pinned')
    resetClippedIds()
    expect(isPinRegistered('toolu_pinned')).toBe(false)
  })

  test('a session switch clears the pins', () => {
    // The outgoing session's transcript is gone, so every key belonging to it
    // (the session itself and its sub-agents) is dropped with it.
    const original = getSessionId()
    switchSession(original)
    pinToolResult('toolu_pinned')

    switchSession('pin-session-switch-xxxx' as SessionId)
    expect(isPinRegistered('toolu_pinned')).toBe(false)

    switchSession(original)
  })

  /** Sub-agent context shaped like utils/swarm/inProcessRunner's. */
  function teammateCtx(agentId: string) {
    return {
      agentId,
      agentName: 'test-agent',
      teamName: 'team-1',
      planModeRequired: false,
      parentSessionId: 'parent-session',
      isInProcess: true as const,
      abortController: new AbortController(),
    }
  }

  test("a sub-agent's routine cleanup cannot drop the main thread's pins", async () => {
    const { runWithTeammateContext } = await import(
      '../../utils/teammateContext.js'
    )
    pinToolResult('toolu_parent')

    await runWithTeammateContext(teammateCtx('agent-pin-1'), async () => {
      // Different transcript, different key: the parent's pin is neither
      // visible nor reachable from in here.
      expect(isPinRegistered('toolu_parent')).toBe(false)
      unpinToolResult('toolu_parent')
      pinToolResult('toolu_child')

      // The two cleanups a sub-agent runs all the time: post-autocompact reset
      // (inProcessRunner) and an orphan prune over ITS messages — which of
      // course never contain the parent's tool_use id.
      resetClippedIds()
      pruneOrphanClippedIds(twoTurns('toolu_child_live') as never)
      expect(isPinRegistered('toolu_child')).toBe(false)
    })

    // With one shared set, each of those wiped the parent's protection and
    // re-armed the clip → re-read loop the pin exists to end.
    expect(isPinRegistered('toolu_parent')).toBe(true)
  })

  test('the FIFO cap is per (session, agent), not shared across agents', async () => {
    const { runWithTeammateContext } = await import(
      '../../utils/teammateContext.js'
    )
    pinToolResult('toolu_parent')

    await runWithTeammateContext(teammateCtx('agent-pin-2'), async () => {
      for (let i = 0; i < 17; i++) pinToolResult(`toolu_child_${i}`)
      expect(_getPinnedToolResultsForTesting().size).toBe(16)
    })

    // A busy sub-agent burns through its own 16 slots without evicting the
    // parent's single pin.
    expect(isPinRegistered('toolu_parent')).toBe(true)
    expect(_getPinnedToolResultsForTesting().size).toBe(1)
  })

  test('a live pin evicted by the FIFO cap becomes clippable again', () => {
    // Documented degradation, not a defect: 16 newer pins push the oldest out
    // even while its tool_result is still in the transcript, and the block then
    // clips like any other. That is the reason the cap is per agent and the
    // reason isToolResultBlockMutable refuses to treat a pin as immutability.
    const messages = twoTurns('toolu_old')
    pinToolResult('toolu_old')
    for (let i = 0; i < 16; i++) pinToolResult(`toolu_new_${i}`)

    expect(_getPinnedToolResultsForTesting().has('toolu_old')).toBe(false)
    const result = pruneOldToolResults(messages, 1)
    expect(result).not.toBe(messages)
    expect(contentOf(result[1])).toMatch(/\[clipped: ~\d+ tokens from Read/)
    // …but it stays REGISTERED, so the next same-range re-read is answered
    // with the outline fallback rather than another full re-send.
    expect(isPinRegistered('toolu_old')).toBe(true)
  })

  test('a pin stops shielding after MAX_SHIELDED_PASSES clip passes', () => {
    // An unbounded pin keeps its block off every clip path, and because the
    // clip frontier still counts it as mutable the cache_control marker cannot
    // advance past it — every later turn re-sends the suffix uncached, at
    // O(turns). So it expires and the block resumes clipping.
    const clipOnce = () => {
      const messages = twoTurns('toolu_aging')
      return pruneOldToolResults(messages, 1)
    }
    pinToolResult('toolu_aging')

    let clippedAt = -1
    for (let pass = 1; pass <= MAX_SHIELDED_PASSES * 2; pass++) {
      const out = clipOnce()
      if (/\[clipped: ~\d+ tokens from Read/.test(String(contentOf(out[1])))) {
        clippedAt = pass
        break
      }
    }
    // EXACT, not a range. The count is what pins the tick to the START of a
    // pass: aging at the END would shield for one pass longer and land on
    // MAX_SHIELDED_PASSES + 1. Start-of-pass placement is the whole reason the
    // byte guard's candidate filter and stubOneBlock can't disagree mid-pass.
    expect(clippedAt).toBe(MAX_SHIELDED_PASSES)
    // Expiry must not re-arm the loop: the id is spent, not forgotten.
    expect(_getPinnedToolResultsForTesting().has('toolu_aging')).toBe(false)
    expect(isPinRegistered('toolu_aging')).toBe(true)
  })

  test('the byte guard ages pins too — retain never reaches the other two ticks', () => {
    // retain sets keepTurns to Infinity (pruneOldToolResults returns before its
    // tick) and leaves the clipped set empty until microcompact (applyStableStubs
    // returns before its tick), so pruneToolResultsByBytes is the ONLY pass that
    // can age a pin there — and retain is the one profile where this guard, the
    // thing the expiry protects, actually runs. Without a tick here a pin placed
    // under retain was permanently exempt from the RSS bound.
    pinToolResult('toolu_bytes_aging')
    let clippedAt = -1
    for (let pass = 1; pass <= MAX_SHIELDED_PASSES * 2; pass++) {
      const out = pruneToolResultsByBytes(twoTurns('toolu_bytes_aging'), 1, 0, 1)
      if (/\[clipped: ~\d+ tokens from Read/.test(String(contentOf(out[1])))) {
        clippedAt = pass
        break
      }
    }
    expect(clippedAt).toBe(MAX_SHIELDED_PASSES)
    expect(isPinRegistered('toolu_bytes_aging')).toBe(true)
  })

  /** Same shape as twoTurns, with a result far past the protection ceiling. */
  function twoTurnsHuge(id: string): Msg[] {
    // Twice the ceiling, whatever the ceiling is.
    const huge = 'A'.repeat(MAX_PINNED_RESULT_TOKENS * 8)
    return [
      assistantToolUse(id, 'Read'),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: huge }] },
      assistantToolUse('toolu_cur', 'Grep'),
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_cur', content: 'fresh' },
        ],
      },
    ]
  }

  test('a pinned result past the size ceiling is clipped anyway', () => {
    // The count cap bounds how many blocks are exempt, not how many bytes, and
    // under AGGRESSIVE the age prune IS the RSS bound — so an unbounded
    // exemption would hasten the autocompact the profile exists to postpone.
    const messages = twoTurnsHuge('toolu_huge')
    pinToolResult('toolu_huge')

    const result = pruneOldToolResults(messages, 1)
    expect(result).not.toBe(messages)
    expect(contentOf(result[1])).toMatch(/\[clipped: ~\d+ tokens from Read/)
    // The registry entry survives: it is what makes the next same-range
    // re-read serve the outline instead of another futile re-send.
    expect(isPinRegistered('toolu_huge')).toBe(true)
    // But it must NOT keep a shielding slot it cannot use: sixteen oversized
    // reads would otherwise evict every pin that was actually working.
    expect(_getPinnedToolResultsForTesting().has('toolu_huge')).toBe(false)
    expect(_getSpentPinIdsForTesting().has('toolu_huge')).toBe(true)
  })

  test('the byte guard and the age prune agree on the ceiling', () => {
    // If the guard skipped an over-ceiling pin that stubOneBlock then clips,
    // `remaining` would be debited for bytes the guard never freed.
    const messages = twoTurnsHuge('toolu_huge')
    pinToolResult('toolu_huge')

    const clipped = pruneToolResultsByBytes(messages, 1, 0, 1)
    expect(clipped).not.toBe(messages)
    expect(contentOf(clipped[1])).toMatch(/\[clipped: ~\d+ tokens from Read/)
  })

  test('shielded bytes are excluded from the byte guard trigger, not just its candidates', () => {
    // The candidate filter `continue`s on a shielded block BEFORE
    // `clearableTokens += tokens`, so protected bytes must not count toward the
    // high-water decision either. If they did, the guard would fire on pressure
    // it cannot relieve and mass-stub the ordinary blocks around it while never
    // reaching the low water — wiping retained context for no gain. Asserting
    // "an over-ceiling block still clips" (the test above) cannot see this;
    // only a trigger sitting BETWEEN the two sizes can.
    const shielded = 'S'.repeat(4_000) // ~1000 tokens, well under the ceiling
    const ordinary = 'O'.repeat(2_000) // ~500 tokens
    const build = (): Msg[] => [
      assistantToolUse('toolu_shielded', 'Read'),
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_shielded', content: shielded },
        ],
      },
      assistantToolUse('toolu_ordinary', 'Grep'),
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_ordinary', content: ordinary },
        ],
      },
      assistantToolUse('toolu_recent', 'Bash'),
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_recent', content: 'fresh' },
        ],
      },
    ]

    // Sanity: with nothing pinned, ~1500 clearable tokens trips a 800 high water.
    const before = build()
    const unpinned = pruneToolResultsByBytes(before, 800, 100, 1)
    expect(unpinned).not.toBe(before)
    expect(contentOf(unpinned[1])).toMatch(/\[clipped: ~\d+ tokens from Read/)

    // Pinned: only the ordinary ~500 tokens are clearable, under the 800 high
    // water, so the guard must not fire at all — identity return, nothing
    // clipped, including the ordinary block it would otherwise have taken.
    _resetAllClippedIdsForTesting()
    pinToolResult('toolu_shielded')
    const messages = build()
    const pinned = pruneToolResultsByBytes(messages, 800, 100, 1)
    expect(pinned).toBe(messages)
  })

  test('pruneStaleClippedIds reclaims other keys pins, keeps the current one', async () => {
    const { runWithTeammateContext } = await import(
      '../../utils/teammateContext.js'
    )
    const ctx = teammateCtx('agent-pin-3')
    await runWithTeammateContext(ctx, async () => {
      pinToolResult('toolu_child')
    })
    pinToolResult('toolu_parent')

    // Called from the main thread after compaction left sub-agent keys behind.
    pruneStaleClippedIds()

    expect(isPinRegistered('toolu_parent')).toBe(true)
    await runWithTeammateContext(ctx, async () => {
      expect(isPinRegistered('toolu_child')).toBe(false)
    })
  })

  test('a session switch clears that session\u2019s sub-agent pins too', async () => {
    const { runWithTeammateContext } = await import(
      '../../utils/teammateContext.js'
    )
    const original = getSessionId()
    switchSession(original) // prime lastSeenSessionId
    const ctx = teammateCtx('agent-pin-4')
    await runWithTeammateContext(ctx, async () => {
      pinToolResult('toolu_child')
    })
    pinToolResult('toolu_parent')

    switchSession('pin-switch-subagent-xxxx' as SessionId)
    // Coming back proves the sweep actually deleted the keys instead of the
    // new session merely looking at a different one: a surviving
    // `<old>:agent-pin-4` entry would resume protecting a transcript that the
    // /resume replaced.
    switchSession(original)

    expect(isPinRegistered('toolu_parent')).toBe(false)
    await runWithTeammateContext(ctx, async () => {
      expect(isPinRegistered('toolu_child')).toBe(false)
    })
  })

  test('pruneStaleClippedIds from inside a sub-agent touches nothing', async () => {
    const { runWithTeammateContext } = await import(
      '../../utils/teammateContext.js'
    )
    pinToolResult('toolu_parent')
    addClippedIds(['clip_parent'])

    const ctx = teammateCtx('agent-pin-5')
    await runWithTeammateContext(ctx, async () => {
      pinToolResult('toolu_child')
      // A teammate autocompacting reaches runPostCompactCleanup with the
      // teammate ALS installed. Sweeping "every key but mine" from there would
      // delete the main thread's key while its messages are still live — the
      // cross-thread corruption that file's own doc comment warns about.
      pruneStaleClippedIds()
      expect(isPinRegistered('toolu_child')).toBe(true)
    })

    expect(isPinRegistered('toolu_parent')).toBe(true)
    expect(getClippedIds().has('clip_parent')).toBe(true)
  })
})
