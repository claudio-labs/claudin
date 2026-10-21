/**
 * `sideQuery()` bills what it spends.
 *
 * It calls the SDK directly, outside the streaming shim where every other
 * request reaches the cost tracker, so until 2026-10-19 the auto-mode
 * classifier — on the main-loop model, once or twice per gated tool call —
 * was missing from `/cost`, from `--max-budget-usd` and from the `cost-state`
 * a census reads. The client is replaced at its module, the way
 * `analyzeContext.test.ts` does it; the rest of `sideQuery` runs for real.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { invalidateClientCache } from 'src/providers/transport/clientCache.js'

const realClient = { ...(await import('src/providers/transport/client.js')) }
const { sideQuery } = await import('src/agent/sideQuery.js')
const { getSourceUsage, getTotalCost, resetCostState } = await import('src/agent/cost-tracker.js')
const { getSessionCacheMetrics } = await import('src/providers/cache/cacheStatsTracker.js')

const MODEL = 'claude-opus-5-5'

function answering(usage: Record<string, number> | undefined): void {
  invalidateClientCache()
  mock.module('src/providers/transport/client.js', () => ({
    ...realClient,
    getAnthropicClient: async () => ({
      beta: {
        messages: {
          create: async () => ({
            id: 'msg_side',
            type: 'message',
            role: 'assistant',
            model: MODEL,
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage,
          }),
        },
      },
    }),
  }))
}

function restoreClient(): void {
  mock.module('src/providers/transport/client.js', () => realClient)
  invalidateClientCache()
}

// The build inlines MACRO; the fingerprint reads its VERSION. Put back
// whatever an earlier file left there.
let priorMacro: unknown
beforeAll(() => {
  priorMacro = (globalThis as Record<string, unknown>).MACRO
  ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: 'test' }
})
beforeEach(() => {
  resetCostState()
})
afterEach(restoreClient)
afterAll(() => {
  restoreClient()
  resetCostState()
  if (priorMacro === undefined) delete (globalThis as Record<string, unknown>).MACRO
  else (globalThis as Record<string, unknown>).MACRO = priorMacro
})

describe('sideQuery spend', () => {
  test("a classifier call is in the session cost, under its source", async () => {
    answering({ input_tokens: 2_000, output_tokens: 40, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 1_000 })
    await sideQuery({ model: MODEL, querySource: 'auto_mode', messages: [{ role: 'user', content: 'x' }] })
    expect(getTotalCost()).toBeGreaterThan(0)
    expect(getSourceUsage().auto_mode).toMatchObject({
      calls: 1,
      inputTokens: 2_000,
      outputTokens: 40,
      cacheReadInputTokens: 30_000,
      cacheCreationInputTokens: 1_000,
    })
    expect(getSessionCacheMetrics().total).toBe(0)
  })

  test('a response without usage adds nothing', async () => {
    // An OpenAI-compatible shim can answer without a usage block.
    answering(undefined)
    await sideQuery({ model: MODEL, querySource: 'permission_explainer', messages: [{ role: 'user', content: 'x' }] })
    expect(getTotalCost()).toBe(0)
    expect(getSourceUsage()).toEqual({})
  })
})
