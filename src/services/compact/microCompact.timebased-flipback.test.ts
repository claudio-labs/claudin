/**
 * S2 regression — time-based microcompact persists through the stable-stub set.
 *
 * The old behavior cleared old tool_results by rewriting the per-request
 * view only (TIME_BASED_MC_CLEARED_MESSAGE), so the next turn re-sent the
 * original bytes ("flip-back") and the post-idle "cleaned" prefix never got
 * a cache hit — plus resetMicrocompactState() wiped ids already frozen by
 * the size-based trigger, breaking stubs behind the cache marker.
 *
 * Fixed behavior under test:
 *   (a) the trigger adds the cleared ids to the per-session clipped set
 *       (addClippedIds) and returns the view UNCHANGED — applyStableStubs
 *       at the wire boundary does the rewrite, deterministically;
 *   (b) the clear persists: the next turn (gap < threshold) produces the
 *       same wire bytes for the clipped ids;
 *   (c) pre-existing size-based clipped ids survive the time trigger.
 *
 * Run: bun test src/services/compact/microCompact.timebased-flipback.test.ts
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// Pin GrowthBook to default-returning FIRST, before anything that reads
// flags loads: getTimeBasedMCConfig's 'tengu_slate_heron' read must fall
// through to the cache-profile defaults regardless of what earlier test
// files left in the module registry.
const realGrowthbook = {
  ...(await import('src/services/analytics/growthbook.js')),
}
mock.module('src/services/analytics/growthbook.js', () => ({
  ...realGrowthbook,
  getFeatureValue_CACHED_MAY_BE_STALE: (_key: string, def: unknown) => def,
}))

import type { Message } from 'src/types/message.js'
const { createAssistantMessage, createUserMessage } = await import(
  'src/utils/messages.js'
)

// Force the 'retain' cache profile BEFORE anything reads it: it is the
// profile with timeBasedClipEnabled=true, gap=60min, keepRecent=5
// (cacheProfile.ts RETAIN_PROFILE). Mode is memoized at module load, so
// reset after setting the env.
process.env.CLAUDIN_CACHE_PROFILE = 'retain'
const { _resetCacheProfileForTesting } = await import('src/services/cache/cacheProfile.js')
_resetCacheProfileForTesting()

// Same boundary mocks as microCompact.test.ts: pin the model + a huge
// effective window so the SIZE-based trigger can never fire in these tests
// (history here is tiny). Everything else is the real code path.
const realAutoCompact = { ...(await import('./autoCompact.js')) }
const realModel = { ...(await import('src/utils/model/model.js')) }

mock.module('./autoCompact.js', () => ({
  ...realAutoCompact,
  getEffectiveContextWindowSize: () => 1_000_000,
}))
mock.module('src/utils/model/model.js', () => ({
  ...realModel,
  getMainLoopModel: () => 'claude-sonnet-4',
}))

const { microcompactMessages } = await import('./microCompact.js')
const { getTimeBasedMCConfig } = await import('./timeBasedMCConfig.js')
const {
  _resetAllClippedIdsForTesting,
  addClippedIds,
  applyStableStubs,
  getClippedIds,
} = await import('./stableStubState.js')

// querySource must start with 'repl_main_thread' (isMainThreadSource) and be
// defined (evaluateTimeBasedTrigger early-returns on undefined).
const MAIN_THREAD = 'repl_main_thread' as Parameters<
  typeof microcompactMessages
>[2] & string

const NUM_EXCHANGES = 8 // keepRecent=5 → toolu_0..toolu_2 get clipped
const RESULT_BODY = (i: number) => `RESULT_${i}_` + 'x'.repeat(400)

function agedTimestamp(ageMinutes: number): string {
  return new Date(Date.now() - ageMinutes * 60_000).toISOString()
}

function assistantWithToolUse(
  toolId: string,
  ageMinutes: number,
): Message {
  const m = createAssistantMessage({
    content: [{ type: 'tool_use' as const, id: toolId, name: 'Read', input: {} }],
  })
  return { ...m, timestamp: agedTimestamp(ageMinutes) } as Message
}

function userWithToolResult(
  toolId: string,
  output: string,
  ageMinutes: number,
): Message {
  const m = createUserMessage({
    content: [
      { type: 'tool_result' as const, tool_use_id: toolId, content: output },
    ],
  })
  return { ...m, timestamp: agedTimestamp(ageMinutes) } as Message
}

/** Conversation whose last assistant message is `ageMinutes` old. */
function buildIdleConversation(ageMinutes: number): Message[] {
  const out: Message[] = []
  for (let i = 0; i < NUM_EXCHANGES; i++) {
    out.push(assistantWithToolUse(`toolu_${i}`, ageMinutes))
    out.push(userWithToolResult(`toolu_${i}`, RESULT_BODY(i), ageMinutes))
  }
  return out
}

/** Map tool_use_id → tool_result content across a message array. */
function toolResultContents(messages: Message[]): Map<string, unknown> {
  const map = new Map<string, unknown>()
  for (const m of messages) {
    if (m.type !== 'user' || !Array.isArray(m.message.content)) continue
    for (const block of m.message.content) {
      if (block.type === 'tool_result') map.set(block.tool_use_id, block.content)
    }
  }
  return map
}

const STUB_FORM = /^\[clipped: ~\d+ tokens from Read\]$/

describe('S2 regression: time-based microcompact persists via stable stubs', () => {
  beforeEach(() => {
    _resetAllClippedIdsForTesting()
    // Re-pin the profile per test: other files in a full-suite run reset
    // the memoized profile / env in their own cleanup, which would silently
    // flip these tests to a profile with the time-based trigger disabled.
    process.env.CLAUDIN_CACHE_PROFILE = 'retain'
    _resetCacheProfileForTesting()
  })

  test('precondition: retain profile enables the time-based trigger (gap 60min, keepRecent 5)', () => {
    const config = getTimeBasedMCConfig()
    expect(config.enabled).toBe(true)
    expect(config.gapThresholdMinutes).toBe(60)
    expect(config.keepRecent).toBe(5)
  })

  test('idle gap > threshold: ids enter clippedIds, view returned unchanged, wire gets deterministic stubs', async () => {
    const messages = buildIdleConversation(90) // 90min > 60min threshold
    const originalBytes = JSON.stringify(messages)

    const result = await microcompactMessages(messages, undefined, MAIN_THREAD)

    // (a) the view is returned unchanged — the rewrite happens at the wire.
    expect(result.messages).toBe(messages)
    expect(JSON.stringify(messages)).toBe(originalBytes)

    // (b) the cleared ids ARE frozen into the clipped set (oldest 3),
    // the newest keepRecent=5 are not.
    const clipped = getClippedIds()
    for (let i = 0; i < 3; i++) {
      expect(clipped.has(`toolu_${i}`)).toBe(true)
    }
    for (let i = 3; i < NUM_EXCHANGES; i++) {
      expect(clipped.has(`toolu_${i}`)).toBe(false)
    }

    // (c) the wire boundary stubs exactly those ids.
    const wire = toolResultContents(applyStableStubs(result.messages))
    for (let i = 0; i < 3; i++) {
      expect(String(wire.get(`toolu_${i}`))).toMatch(STUB_FORM)
    }
    for (let i = 3; i < NUM_EXCHANGES; i++) {
      expect(wire.get(`toolu_${i}`)).toBe(RESULT_BODY(i))
    }
  })

  test('no flip-back: the NEXT turn (gap < threshold) sends byte-identical stubs for the clipped ids', async () => {
    const history = buildIdleConversation(90)

    // Turn N (post-idle): trigger fires; wire bytes for the clipped prefix.
    const turnN = await microcompactMessages(history, undefined, MAIN_THREAD)
    const wireN = toolResultContents(applyStableStubs(turnN.messages))

    // Turn N+1: the REPL appends the fresh assistant reply to the SAME
    // history. Gap is now ~0 → time-based trigger does NOT fire; size
    // trigger is far below threshold.
    const replyNow = createAssistantMessage({ content: 'ok, done.' })
    const userNow = createUserMessage({ content: 'next question' })
    const nextHistory: Message[] = [...history, replyNow, userNow]

    const turnN1 = await microcompactMessages(nextHistory, undefined, MAIN_THREAD)
    const wireN1 = toolResultContents(applyStableStubs(turnN1.messages))

    // The clip persisted: every clipped id serializes to the exact bytes
    // turn N wrote to the server cache — the cleaned prefix gets its hit.
    for (let i = 0; i < 3; i++) {
      expect(String(wireN1.get(`toolu_${i}`))).toMatch(STUB_FORM)
      expect(wireN1.get(`toolu_${i}`)).toBe(wireN.get(`toolu_${i}`))
    }
    // Kept ids remain full on both turns.
    for (let i = 3; i < NUM_EXCHANGES; i++) {
      expect(wireN1.get(`toolu_${i}`)).toBe(RESULT_BODY(i))
    }
  })

  test('pre-existing size-based clipped ids SURVIVE the time trigger (no resetClippedIds)', async () => {
    // Simulate stubs already frozen by the size-based trigger on earlier
    // turns — these live BEHIND the cache marker and must stay stable.
    addClippedIds(['toolu_frozen_a', 'toolu_frozen_b'])
    expect(getClippedIds().size).toBe(2)

    const messages = buildIdleConversation(90)
    await microcompactMessages(messages, undefined, MAIN_THREAD)

    expect(getClippedIds().has('toolu_frozen_a')).toBe(true)
    expect(getClippedIds().has('toolu_frozen_b')).toBe(true)
    // ...and the time trigger's own ids joined them.
    expect(getClippedIds().has('toolu_0')).toBe(true)
  })

  test('idempotent: a second post-idle turn with everything already clipped does not re-trigger', async () => {
    const messages = buildIdleConversation(90)
    await microcompactMessages(messages, undefined, MAIN_THREAD)
    const sizeBefore = getClippedIds().size

    // Still idle (gap unchanged) — but all candidates are already clipped:
    // the trigger finds no new ids and falls through without side effects.
    await microcompactMessages(messages, undefined, MAIN_THREAD)
    expect(getClippedIds().size).toBe(sizeBefore)
  })

  test('control: no trigger when gap < threshold (nothing clipped)', async () => {
    const messages = buildIdleConversation(30) // 30min < 60min
    const result = await microcompactMessages(messages, undefined, MAIN_THREAD)
    expect(getClippedIds().size).toBe(0)
    const sent = toolResultContents(applyStableStubs(result.messages))
    for (let i = 0; i < NUM_EXCHANGES; i++) {
      expect(sent.get(`toolu_${i}`)).toBe(RESULT_BODY(i))
    }
  })
})

afterAll(() => {
  _resetAllClippedIdsForTesting()
  delete process.env.CLAUDIN_CACHE_PROFILE
  _resetCacheProfileForTesting()
  mock.module('./autoCompact.js', () => realAutoCompact)
  mock.module('src/utils/model/model.js', () => realModel)
  mock.module('src/services/analytics/growthbook.js', () => realGrowthbook)
})
