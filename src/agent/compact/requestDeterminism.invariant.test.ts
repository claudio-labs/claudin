/**
 * Invariant: NO spontaneous prompt-cache breaks from tools or formatting.
 *
 * Integrated safety net over the whole per-request render pipeline
 * (microcompact → stable stubs → cache breakpoints)
 * plus the tool-pool update rules: rendering turn N+1 after a normal turn
 * append must serialize every message of turn N's render to byte-identical
 * content (the prefix property the server-side prompt cache depends on),
 * and the tools array must not change bytes across MCP reconnects or LSP
 * initialization.
 *
 * Encodes the 2026-06 cache-break audit fixes (S1 eviction amortization,
 * S2 time-based microcompact persistence, S3 stub byte registry, A1 pool
 * positional stability, A3 LSP defer latch) as one regression: if a future
 * change reintroduces a per-turn byte flip anywhere in this path, this
 * file fails.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
}

// Pin GrowthBook to default-returning FIRST, before anything that reads
// flags loads — flag reads must fall through to cache-profile defaults
// regardless of what earlier test files left in the module registry.
const realGrowthbook = {
  ...(await import('src/platform/analytics/growthbook.js')),
}
mock.module('src/platform/analytics/growthbook.js', () => ({
  ...realGrowthbook,
  getFeatureValue_CACHED_MAY_BE_STALE: (_key: string, def: unknown) => def,
}))

// Pin the retain profile (time-based trigger enabled) before anything
// memoizes it, same scaffolding as microCompact.timebased-flipback.test.ts.
process.env.CLAUDIN_CACHE_PROFILE = 'retain'
const { _resetCacheProfileForTesting } = await import('src/agent/cache/cacheProfile.js')
_resetCacheProfileForTesting()

const realAutoCompact = { ...(await import('src/agent/compact/autoCompact.js')) }
const realModel = { ...(await import('src/providers/model/model.js')) }
mock.module('./autoCompact.js', () => ({
  ...realAutoCompact,
  getEffectiveContextWindowSize: () => 1_000_000,
}))
mock.module('src/providers/model/model.js', () => ({
  ...realModel,
  getMainLoopModel: () => 'claude-sonnet-4',
}))

const { microcompactMessages } = await import('src/agent/compact/microCompact.js')
const {
  _resetAllClippedIdsForTesting,
  applyStableInputStubs,
  applyStableStubs,
  getClipFrontierIndex,
} = await import('src/agent/compact/stableStubState.js')
const { addCacheBreakpoints, _resetDeferCacheMarkerForTesting } = await import(
  'src/providers/shims/claude/paramBuilders.js'
)
const { createAssistantMessage, createUserMessage } = await import(
  'src/agent/messages/messages.js'
)
const { resolveUpdatedTools } = await import(
  'src/mcp/useManageMCPConnections.js'
)
const { clearBetaHeaderLatches, isLspDeferLatched, latchLspDefer } =
  await import('src/platform/bootstrap/state.js')

import type { Message } from 'src/shared/types/message.js'
import type { Tool } from 'src/tools/Tool.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

const MAIN_THREAD = 'repl_main_thread' as never

function aged(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

function exchange(
  id: string,
  body: string,
  ageMinutes: number,
  call: { name: string; input: Record<string, unknown> } = { name: 'Read', input: {} },
): Message[] {
  const a = createAssistantMessage({
    content: [{ type: 'tool_use' as const, id, name: call.name, input: call.input }],
  })
  const u = createUserMessage({
    content: [{ type: 'tool_result' as const, tool_use_id: id, content: body }],
  })
  return [
    { ...a, timestamp: aged(ageMinutes) } as Message,
    { ...u, timestamp: aged(ageMinutes) } as Message,
  ]
}

/** Serialize message params with cache_control markers stripped — the
 * marker is placement metadata, not cached content, and legitimately moves
 * forward every turn. */
function wireBytes(params: unknown[]): string[] {
  return params.map(p =>
    JSON.stringify(p, (key, value) =>
      key === 'cache_control' ? undefined : value,
    ),
  )
}

// The pool the claude renderer's ToolUseContext would carry: Patch
// opts its patchText in for the input-side clip.
const POOL = [{ name: 'Patch', clearableInputFields: ['patchText'] }]

/** The full per-request render pipeline as the wire sees it — the same
 * order as claude/streaming.ts: stubs, input stubs, frontier, marker. */
async function renderTurn(
  messages: Message[],
): Promise<{ bytes: string[]; view: Message[] }> {
  const mc = await microcompactMessages(
    messages,
    { options: { tools: POOL } } as unknown as ToolUseContext,
    MAIN_THREAD,
  )
  const stubbed = applyStableInputStubs(applyStableStubs(mc.messages))
  const params = addCacheBreakpoints(
    stubbed as unknown as Parameters<typeof addCacheBreakpoints>[0],
    true,
    undefined,
    false,
    getClipFrontierIndex(stubbed),
  )
  return { bytes: wireBytes(params as unknown[]), view: stubbed }
}

/** Assert turn N's full render is a byte-identical prefix of turn N+1's. */
function expectPrefixStable(turnN: string[], turnN1: string[]): void {
  expect(turnN1.length).toBeGreaterThanOrEqual(turnN.length)
  for (let i = 0; i < turnN.length; i++) {
    expect(turnN1[i]).toBe(turnN[i]!)
  }
}

beforeEach(() => {
  _resetAllClippedIdsForTesting()
  clearBetaHeaderLatches()
  // Re-pin per test: other files in a full-suite run reset the memoized
  // cache profile / env in their own cleanup.
  process.env.CLAUDIN_CACHE_PROFILE = 'retain'
  _resetCacheProfileForTesting()
  process.env.CLAUDIN_DEFER_CACHE_MARKER = '0'
  _resetDeferCacheMarkerForTesting()
})

describe('request determinism — message prefix', () => {
  test('steady turns: appending a turn never rewrites prior message bytes', async () => {
    const history: Message[] = []
    for (let i = 0; i < 10; i++) {
      history.push(...exchange(`toolu_${i}`, `RESULT_${i}_` + 'x'.repeat(600), 5))
    }

    const turnN = await renderTurn(history)

    // Next turn: the REPL post-turn pipeline writes the clipped set back into
    // the display array (nothing is ever evicted) and a new exchange is
    // appended.
    const postTurn = applyStableStubs(history)
    const nextHistory = [
      ...postTurn,
      ...exchange('toolu_next', 'fresh result', 0),
    ]
    const turnN1 = await renderTurn(nextHistory)

    expectPrefixStable(turnN.bytes, turnN1.bytes)
  })

  test('idle gap (time-based microcompact): clip turn and following turn serialize identical prefixes', async () => {
    const history: Message[] = []
    // 9 aged exchanges (90min > 60min retain threshold) — keepRecent=5
    // leaves toolu_0..toolu_3 to be clipped on the post-idle turn.
    for (let i = 0; i < 9; i++) {
      history.push(
        ...exchange(`toolu_${i}`, `RESULT_${i}_` + 'x'.repeat(600), 90),
      )
    }
    // Turn N: post-idle — the time-based trigger clips toolu_0..3 into the
    // stable-stub set; the wire renders their deterministic stubs.
    const turnN = await renderTurn(history)

    // Turn N+1: gap is ~0 (fresh exchange appended); nothing re-triggers.
    const nextHistory = [
      ...applyStableStubs(history),
      ...exchange('toolu_next', 'fresh result', 0),
    ]
    const turnN1 = await renderTurn(nextHistory)

    expectPrefixStable(turnN.bytes, turnN1.bytes)
  })

  test('idle gap clips old Patch INPUTS: the patch body leaves the wire and the next turn is prefix-stable', async () => {
    const history: Message[] = []
    for (let i = 0; i < 9; i++) {
      history.push(
        ...exchange(`toolu_${i}`, 'Success. Applied the patch.', 90, {
          name: 'Patch',
          input: { patchText: `PATCH_${i}_` + 'p'.repeat(2_000) },
        }),
      )
    }

    const turnN = await renderTurn(history)
    // The oldest calls' bodies are gone from the wire, replaced by the
    // input stub; the kept tail still carries its patch.
    expect(turnN.bytes[0]).not.toContain('PATCH_0_')
    expect(turnN.bytes[0]).toContain('tokens of patchText from Patch')
    expect(turnN.bytes.join('\n')).toContain('PATCH_8_')
    // The one-line results were never stubbed — input-only ids stay out of
    // the result set.
    expect(turnN.bytes[1]).toContain('Success. Applied the patch.')

    const nextHistory = [
      ...applyStableStubs(history),
      ...exchange('toolu_next', 'fresh result', 0),
    ]
    const turnN1 = await renderTurn(nextHistory)
    expectPrefixStable(turnN.bytes, turnN1.bytes)
  })
})

describe('request determinism — tools array', () => {
  function t(name: string): Tool {
    return { name, description: `${name} d` } as unknown as Tool
  }

  test('MCP fail + reconnect cycle leaves the pool byte-identical', () => {
    const pool = [t('Bash'), t('mcp__s__a'), t('mcp__s__b'), t('Read')]
    const before = JSON.stringify(pool)
    const failed = resolveUpdatedTools(pool, 'failed', 'mcp__s__', undefined)
    const reconnected = resolveUpdatedTools(failed, 'connected', 'mcp__s__', [
      t('mcp__s__a'),
      t('mcp__s__b'),
    ])
    expect(JSON.stringify(reconnected)).toBe(before)
  })

  test('LSP defer decision is sticky for the session', () => {
    // First request: LSP pending → deferred → latched.
    latchLspDefer('LspDiagnostics')
    // LSP completes initialization mid-session — the latch keeps the tool
    // deferred (defer_loading bytes unchanged) until a cache-cold reset.
    expect(isLspDeferLatched('LspDiagnostics')).toBe(true)
    clearBetaHeaderLatches()
    expect(isLspDeferLatched('LspDiagnostics')).toBe(false)
  })
})

afterAll(() => {
  _resetAllClippedIdsForTesting()
  clearBetaHeaderLatches()
  delete process.env.CLAUDIN_CACHE_PROFILE
  delete process.env.CLAUDIN_DEFER_CACHE_MARKER
  _resetCacheProfileForTesting()
  _resetDeferCacheMarkerForTesting()
  mock.module('./autoCompact.js', () => realAutoCompact)
  mock.module('src/providers/model/model.js', () => realModel)
  mock.module('src/platform/analytics/growthbook.js', () => realGrowthbook)
})
