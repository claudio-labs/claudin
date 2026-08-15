/**
 * S1 regression — display eviction is amortized and announced.
 *
 * The REPL's post-turn pipeline (src/agent/repl/controllers/useOnQuery.ts,
 * extracted from src/agent/repl/REPL.tsx by ROADMAP 11e) runs
 * evictOldStubbedMessages / evictToMaxSize on messagesRef.current — the
 * SAME array that seeds the next turn's API request. getClipFrontierIndex
 * treats already-applied pure stubs as byte-stable, so the cache_control
 * marker placed by addCacheBreakpoints can sit AFTER pure-stub pairs;
 * deleting those pairs mutates the serialized prefix behind the marker —
 * a full cache miss from the system prompt's end onward.
 *
 * The old behavior paid that break on EVERY turn once anything was
 * evictable (and on every turn past 200 messages for evictToMaxSize).
 * Fixed behavior under test:
 *   - evictOldStubbedMessages takes a minEvictable batch floor
 *     (EVICT_MIN_BATCH in the REPL): nothing is removed until a batch has
 *     accumulated, then everything goes in ONE break.
 *   - evictToMaxSize takes a triggerAt hysteresis bound (EVICT_TRIGGER_AT
 *     in the REPL): no cut until length > 300, then back to 200 at once.
 *   - The REPL notifies the cache-break detector when an eviction fires,
 *     and runs a free full sweep when the idle gap says the server cache
 *     has expired anyway (evaluateTimeBasedTrigger).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Same MACRO shim as src/services/api/claude/__tests__/addCacheBreakpoints.test.ts
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
}

import {
  _resetAllClippedIdsForTesting,
  buildClipStub,
  evictOldStubbedMessages,
  evictToMaxSize,
  getClipFrontierIndex,
  EVICT_MIN_BATCH,
  EVICT_TRIGGER_AT,
  MAX_DISPLAY_MESSAGES,
} from 'src/agent/compact/stableStubState.js'
import {
  _resetDeferCacheMarkerForTesting,
  addCacheBreakpoints,
} from 'src/services/api/claude/paramBuilders.js'

type Block = Record<string, unknown>
// API-message shape (type + .message wrapper) — accepted both by
// addCacheBreakpoints and, via getInner(), by every stableStubState helper.
type Msg = {
  type: 'user' | 'assistant'
  message: { role: 'user' | 'assistant'; content: Block[] }
}

const originalDeferEnv = process.env.CLAUDIN_DEFER_CACHE_MARKER

beforeEach(() => {
  _resetAllClippedIdsForTesting()
})

afterEach(() => {
  _resetAllClippedIdsForTesting()
  if (originalDeferEnv === undefined) {
    delete process.env.CLAUDIN_DEFER_CACHE_MARKER
  } else {
    process.env.CLAUDIN_DEFER_CACHE_MARKER = originalDeferEnv
  }
  _resetDeferCacheMarkerForTesting()
})

function assistantToolUse(id: string, name = 'Bash'): Msg {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input: {} }],
    },
  }
}

function userToolResult(id: string, content: string): Msg {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content }],
    },
  }
}

// ~500 estimated tokens — well above MIN_STUB_TOKENS (100), so under the
// default (aggressive) profile the age prune WILL rewrite it some future
// turn → mutable → the frontier must stop before it.
const FULL_RESULT = 'X'.repeat(2000)

/**
 * Realistic REPL display array after several turns:
 *   indices 0-3: two OLD turns whose tool_results were already rewritten to
 *                PURE stubs (the exact bytes buildClipStub emits — the same
 *                form CLIP_STUB_PATTERN matches and evictOldStubbedMessages
 *                requires).
 *   indices 4-9: three RECENT turns with full (unstubbed) tool_results.
 */
function buildFixture(): Msg[] {
  return [
    assistantToolUse('toolu_old_0', 'Read'),   // 0
    userToolResult('toolu_old_0', buildClipStub('Read', 5000)),  // 1
    assistantToolUse('toolu_old_1', 'Grep'),   // 2
    userToolResult('toolu_old_1', buildClipStub('Grep', 3000)),  // 3
    assistantToolUse('toolu_new_0'),           // 4
    userToolResult('toolu_new_0', FULL_RESULT), // 5
    assistantToolUse('toolu_new_1'),           // 6
    userToolResult('toolu_new_1', FULL_RESULT), // 7
    assistantToolUse('toolu_new_2'),           // 8
    userToolResult('toolu_new_2', FULL_RESULT), // 9
  ]
}

/**
 * Display array with `pairs` evictable stub-only pairs followed by three
 * recent full turns (keepTurns=2 protects the tail).
 */
function buildBatchFixture(pairs: number): Msg[] {
  const out: Msg[] = []
  for (let i = 0; i < pairs; i++) {
    out.push(assistantToolUse(`toolu_old_${i}`, 'Read'))
    out.push(userToolResult(`toolu_old_${i}`, buildClipStub('Read', 1000 + i)))
  }
  out.push(assistantToolUse('toolu_new_0'))
  out.push(userToolResult('toolu_new_0', FULL_RESULT))
  out.push(assistantToolUse('toolu_new_1'))
  out.push(userToolResult('toolu_new_1', FULL_RESULT))
  out.push(assistantToolUse('toolu_new_2'))
  out.push(userToolResult('toolu_new_2', FULL_RESULT))
  return out
}

/** Indices of message params whose last content block carries cache_control. */
function markerIndices(out: Array<{ content?: unknown }>): number[] {
  const result: number[] = []
  for (let i = 0; i < out.length; i += 1) {
    const content = out[i]?.content
    if (!Array.isArray(content)) continue
    const last = content[content.length - 1] as
      | { cache_control?: unknown }
      | undefined
    if (last && last.cache_control) result.push(i)
  }
  return result
}

describe('context: pure-stub pairs live behind the cache marker', () => {
  test('frontier passes OVER pure-stub pairs and the marker lands after them', () => {
    const msgs = buildFixture()

    // Default (aggressive profile, agePruneActive=true): the first mutable
    // block is the full tool_result at index 5 → frontier = 4. The pure-stub
    // pairs (indices 0-3) all sit AT OR BELOW the frontier.
    const frontierAggressive = getClipFrontierIndex(msgs)
    expect(frontierAggressive).toBe(4)

    // Retain profile (agePruneActive=false): full tool_results are
    // byte-stable too → frontier is the LAST message; the whole array is
    // freezable, so ANY removal is a mutation behind the marker.
    const frontierRetain = getClipFrontierIndex(msgs, { agePruneActive: false })
    expect(frontierRetain).toBe(msgs.length - 1) // 9

    process.env.CLAUDIN_DEFER_CACHE_MARKER = '0'
    _resetDeferCacheMarkerForTesting()
    const out = addCacheBreakpoints(
      msgs as unknown as Parameters<typeof addCacheBreakpoints>[0],
      true,
      undefined,
      false,
      frontierAggressive,
    )
    expect(markerIndices(out as Array<{ content?: unknown }>)).toEqual([4])
  })
})

describe('S1 regression: eviction is amortized (batch floor)', () => {
  test('below EVICT_MIN_BATCH nothing is evicted — prefix bytes stay identical', () => {
    const turnN = buildFixture()
    const frontier = getClipFrontierIndex(turnN) // 4
    const prefixBefore = JSON.stringify(turnN.slice(0, frontier + 1))

    // Exactly what REPL.tsx runs post-turn: only 4 evictable messages
    // (< EVICT_MIN_BATCH = 24) → identity, no break.
    const turnN1 = evictOldStubbedMessages(turnN, 2, EVICT_MIN_BATCH)
    expect(turnN1).toBe(turnN)
    expect(JSON.stringify(turnN1.slice(0, frontier + 1))).toBe(prefixBefore)

    // Same conclusion through the real renderer: the wire prefix up to the
    // marker is byte-identical across the two turns.
    process.env.CLAUDIN_DEFER_CACHE_MARKER = '0'
    _resetDeferCacheMarkerForTesting()
    const paramsN = addCacheBreakpoints(
      turnN as unknown as Parameters<typeof addCacheBreakpoints>[0],
      true, undefined, false, frontier,
    )
    const paramsN1 = addCacheBreakpoints(
      turnN1 as unknown as Parameters<typeof addCacheBreakpoints>[0],
      true, undefined, false, getClipFrontierIndex(turnN1),
    )
    expect(JSON.stringify(paramsN1.slice(0, frontier + 1))).toBe(
      JSON.stringify(paramsN.slice(0, frontier + 1)),
    )
  })

  test('at/above EVICT_MIN_BATCH the whole accumulated batch goes in ONE eviction', () => {
    const pairs = EVICT_MIN_BATCH / 2 // 12 stub-only pairs = 24 messages
    const msgs = buildBatchFixture(pairs)
    const out = evictOldStubbedMessages(msgs, 2, EVICT_MIN_BATCH)
    // All evictable pairs removed at once — only the 3 recent turns remain.
    expect(out.length).toBe(6)
    expect(out[0]).toBe(msgs[pairs * 2]!)
  })

  test('sweep mode (minEvictable=1) evicts whatever is available — used when the cache is already cold', () => {
    const msgs = buildFixture()
    const out = evictOldStubbedMessages(msgs, 2, 1)
    expect(out.length).toBe(6)
    const survivingIds = new Set(
      out.flatMap(m =>
        m.message.content.map(b => (b.tool_use_id ?? b.id) as string),
      ),
    )
    expect(survivingIds.has('toolu_old_0')).toBe(false)
    expect(survivingIds.has('toolu_old_1')).toBe(false)
  })
})

describe('S1 regression: evictToMaxSize hysteresis band', () => {
  function textMessages(count: number): Msg[] {
    const msgs: Msg[] = []
    for (let i = 0; i < count; i++) {
      msgs.push({
        type: i % 2 === 0 ? 'user' : 'assistant',
        message: {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: [{ type: 'text', text: `m${i}` }],
        },
      })
    }
    return msgs
  }

  test('inside the band (200 < length <= 300) nothing is cut', () => {
    const msgs = textMessages(230)
    // Everything is byte-stable text → frontier spans the whole array; the
    // old per-turn cut here was a guaranteed full prefix invalidation.
    expect(getClipFrontierIndex(msgs)).toBe(229)
    const out = evictToMaxSize(msgs, MAX_DISPLAY_MESSAGES, EVICT_TRIGGER_AT)
    expect(out).toBe(msgs)
  })

  test('above the trigger the array is cut back to the cap in one break', () => {
    const msgs = textMessages(310)
    const out = evictToMaxSize(msgs, MAX_DISPLAY_MESSAGES, EVICT_TRIGGER_AT)
    expect(out.length).toBeLessThanOrEqual(MAX_DISPLAY_MESSAGES)
    // Cut comes from the START and lands on the tail of the original array.
    expect(out[out.length - 1]).toBe(msgs[msgs.length - 1]!)
  })

  test('default triggerAt preserves the legacy semantics (cut as soon as over max)', () => {
    const msgs = textMessages(230)
    const out = evictToMaxSize(msgs) // no hysteresis when not requested
    expect(out.length).toBeLessThanOrEqual(MAX_DISPLAY_MESSAGES)
  })
})

describe('S1 regression: REPL wiring', () => {
  // The wiring this guards used to live in src/agent/repl/REPL.tsx. ROADMAP 11e's
  // deferred half moved the controllers into src/agent/repl/controllers/, so
  // the guard follows them: the post-turn pipeline is now onQueryImpl's tail in
  // useOnQuery.ts and the idle-gap sweep is onSubmit's in useOnSubmit.ts. Each
  // assertion is checked against the file that actually owns the call, rather
  // than a concatenation, so a failure still names where to look.
  const controllerSource = (name: string) =>
    readFileSync(
      join(import.meta.dir, '../repl/controllers/', name),
      'utf8',
    )

  test('the post-turn path notifies the detector and uses the amortized params', () => {
    const onQuerySource = controllerSource('useOnQuery.ts')
    // Amortized params at the post-turn call sites.
    expect(onQuerySource).toContain(
      'evictOldStubbedMessages(stubbed, 2, EVICT_MIN_BATCH)',
    )
    expect(onQuerySource).toContain(
      'evictToMaxSize(evicted, MAX_DISPLAY_MESSAGES, EVICT_TRIGGER_AT)',
    )
    // Intentional evictions are announced to the cache-break detector —
    // call-shaped and line-anchored so neither the import line nor a
    // commented-out call can satisfy the guard.
    expect(onQuerySource).toMatch(
      /^\s*notifyCacheDeletion\(getQuerySourceForREPL\(\)\)/m,
    )
  })

  test('onSubmit has the idle sweep', () => {
    const onSubmitSource = controllerSource('useOnSubmit.ts')
    // Idle-gap sweep before seeding the request.
    expect(onSubmitSource).toContain('evaluateTimeBasedTrigger(sweepSnapshot')
    // The sweep must not fire while a query is in flight (queued-submit
    // path): the in-flight turn keeps using its unswept array, so sweeping
    // here would diverge display from request bytes and make the next
    // turn's break full instead of free.
    expect(onSubmitSource).toMatch(
      /!queryGuard\.isActive &&\s*\n\s*evaluateTimeBasedTrigger\(sweepSnapshot/,
    )
    // Same-tick races: concurrent appends after the snapshot survive.
    expect(onSubmitSource).toContain(
      '[...swept, ...prev.slice(sweepSnapshot.length)]',
    )
  })
})
