/**
 * Prompt-cache keep-alive — EXPERIMENT, off by default.
 *
 * Anthropic's cache TTL is refreshed every time the cached prefix is READ,
 * so a request that re-sends the last body with `max_tokens` at the floor
 * costs one cache read and buys another TTL window for the whole prefix.
 * Two places pay for the lack of one (2026-09-10 census):
 *
 *  - a fresh sub-agent (5m tier) that spawns nested Agents and waits 4–8
 *    minutes for them: its own prefix expires and the next request rewrites
 *    it whole (6× in two days, 346k tokens). The write TTL is chosen before
 *    the response that blocks exists, so no TTL rule can prevent it;
 *  - the main thread, which pays the 1h tier (2× the 5m write price) to
 *    survive user pauses: $14.64 of premium in two days against $3.33 of
 *    pings that would have covered the same 23 gaps at the 5m tier.
 *
 * Mechanism: `noteRequestStarted(key)` cancels any pending ping for that
 * agent; `armKeepAlive(req)` is called when a response completes and, if the
 * request's tier is 5m, schedules a ping `PING_AFTER_MS` later. The ping
 * re-sends the SAME params (same `thinking` too — changing it invalidates
 * the message cache) with `stream: false` and a floor `max_tokens`, logs the
 * usage it got back, adds it to the session cost, and re-arms until
 * `CLAUDIN_CACHE_KEEPALIVE_MAX_MIN` (default 30) after the first arm or
 * until the next real request. A ping that errors stops the chain for that
 * key — a 400 must never loop.
 *
 * What this holds: one serialized request body per agent key, for the life
 * of the chain. `streaming.ts` deliberately frees its own copies after each
 * request; this keeps the last one on purpose, and only while the flag is
 * on. Not measured against the subscription quota: a ping is a request, and
 * whether the plan counts cache reads at full weight is the open question
 * the bench cannot answer — see docs/tech/cache/keep-alive.md.
 *
 * Env:
 *   CLAUDIN_CACHE_KEEPALIVE=1            turn on
 *   CLAUDIN_CACHE_KEEPALIVE_MAX_MIN=30   how long a chain may run
 *   CLAUDIN_CACHE_KEEPALIVE_MAX_TOKENS=1 the ping's max_tokens
 *   CLAUDIN_MAIN_CACHE_TTL=5m            (cacheControl.ts) main thread at 5m,
 *                                        which only makes sense with this on
 */
import { addToTotalSessionCost } from 'src/agent/cost-tracker.js'
import { calculateUSDCost } from 'src/providers/usage/modelCost.js'
import { logForDebugging } from 'src/shared/debug.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { logError } from 'src/shared/log.js'

/** Below the 5-minute TTL with margin for a slow request. */
export const PING_AFTER_MS = 4.5 * 60 * 1000
const DEFAULT_MAX_MIN = 30
const DEFAULT_MAX_TOKENS = 1

export function isCacheKeepAliveEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDIN_CACHE_KEEPALIVE)
}

function maxChainMs(): number {
  const n = Number(process.env.CLAUDIN_CACHE_KEEPALIVE_MAX_MIN)
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_MIN) * 60 * 1000
}

function pingMaxTokens(): number {
  const n = Number(process.env.CLAUDIN_CACHE_KEEPALIVE_MAX_TOKENS)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_TOKENS
}

/** The minimum a ping needs to send: the client's create() and the body. */
export type KeepAliveClient = {
  beta: {
    messages: {
      // Method syntax on purpose: the SDK client's `create` takes its own
      // params type, and a method signature is checked bivariantly, so with
      // `never` here the real client is assignable without a cast. The ping
      // re-sends a body the SDK already accepted once, cast at the call.
      create(body: never, opts?: { signal?: AbortSignal }): Promise<unknown>
    }
  }
}

export type KeepAliveUsage = {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
}

export type KeepAliveRequest = {
  /** `agentId`, or `main` for the top-level thread. */
  key: string
  client: KeepAliveClient
  /** The exact body the last request sent (minus `stream`). */
  params: Record<string, unknown>
  /** Resolved model, for the cost line. */
  model: string
  /** True when the request was cached at the 5m tier — the only tier worth pinging. */
  shortTtl: boolean
}

type Chain = {
  timer: ReturnType<typeof setTimeout>
  /** Increments on every real request; a ping only fires for the generation it was armed in. */
  generation: number
  firstArmedAt: number
  req: KeepAliveRequest
}

const chains = new Map<string, Chain>()
const generations = new Map<string, number>()

/** Test/observability seam: what each ping saw. */
export type KeepAlivePing = { key: string; at: number; usage: KeepAliveUsage | null; error?: string }
const pings: KeepAlivePing[] = []
export function _getPingsForTesting(): readonly KeepAlivePing[] {
  return pings
}

function cancel(key: string): void {
  const chain = chains.get(key)
  if (!chain) return
  clearTimeout(chain.timer)
  chains.delete(key)
}

/** A real request for `key` is starting: whatever was armed is stale. */
export function noteRequestStarted(key: string): void {
  generations.set(key, (generations.get(key) ?? 0) + 1)
  cancel(key)
}

/** The response for `key` completed; schedule the first ping if the tier is 5m. */
export function armKeepAlive(req: KeepAliveRequest, now: number = Date.now()): void {
  if (!isCacheKeepAliveEnabled() || !req.shortTtl) return
  cancel(req.key)
  schedule(req, generations.get(req.key) ?? 0, now)
}

function schedule(req: KeepAliveRequest, generation: number, firstArmedAt: number): void {
  const timer = setTimeout(() => void fire(req.key, generation), PING_AFTER_MS)
  // Never keep the process alive for a ping.
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  chains.set(req.key, { timer, generation, firstArmedAt, req })
}

async function fire(key: string, generation: number): Promise<void> {
  const chain = chains.get(key)
  if (!chain || chain.generation !== generation) return
  chains.delete(key)
  if ((generations.get(key) ?? 0) !== generation) return
  const at = Date.now()
  if (at - chain.firstArmedAt > maxChainMs()) {
    logForDebugging(`[cache keep-alive] ${key}: chain past its ceiling, stopping`)
    return
  }
  const { req } = chain
  try {
    const res = (await req.client.beta.messages.create({
      ...req.params,
      stream: false,
      max_tokens: pingMaxTokens(),
    } as never)) as { usage?: KeepAliveUsage } | undefined
    const usage = res?.usage ?? null
    pings.push({ key, at, usage })
    if (usage) {
      const cost = calculateUSDCost(req.model, {
        input_tokens: usage.input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
      } as Parameters<typeof calculateUSDCost>[1])
      addToTotalSessionCost(cost, usage as Parameters<typeof addToTotalSessionCost>[1], req.model)
      logForDebugging(
        `[cache keep-alive] ${key}: read ${usage.cache_read_input_tokens ?? 0} created ${usage.cache_creation_input_tokens ?? 0} ($${cost.toFixed(4)})`,
      )
    }
    // Same generation still (no real request meanwhile): keep the chain going.
    if ((generations.get(key) ?? 0) === generation) {
      schedule(req, generation, chain.firstArmedAt)
    }
  } catch (e) {
    pings.push({ key, at, usage: null, error: e instanceof Error ? e.message : String(e) })
    logError(`[cache keep-alive] ${key}: ping failed, chain stopped — ${String(e)}`)
  }
}

/** Drop every chain — process exit, /clear, tests. */
export function cancelAllKeepAlives(): void {
  for (const key of [...chains.keys()]) cancel(key)
}

export function _resetKeepAliveForTesting(): void {
  cancelAllKeepAlives()
  generations.clear()
  pings.length = 0
}

/** Test-only: run the pending ping for `key` now instead of waiting. */
export async function _fireNowForTesting(key: string): Promise<void> {
  const chain = chains.get(key)
  if (!chain) return
  clearTimeout(chain.timer)
  await fire(key, chain.generation)
}
