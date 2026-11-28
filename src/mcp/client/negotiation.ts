/**
 * The protocol-era decisions behind a connect to an MCP server, as pure
 * functions; connection.ts carries them out.
 *
 * A server in `auto` mode is probed with `server/discover` and reached in
 * 2026-07-28 when it answers, in the 2025 `initialize` handshake otherwise.
 * The verdict is cached per server (eraCache.ts) and handed back to the SDK
 * as `connect(t, { prior })`, which skips the probe: one spawn of a stdio
 * server instead of two, and no 400 from a 2025 HTTP server. A modern verdict
 * is never replayed over HTTP: adopting it sends nothing, so a server gone
 * back to 2025 failed only on the first list request, before anything could
 * reconnect it, and its capabilities were the cached ones for an hour or
 * more. The probe there is one request, what any check would cost, and it
 * brings the server's current capabilities.
 *
 * The SDK falls back to `initialize` by itself when a server answers the
 * probe 4xx (a 2025 server), and on stdio when the probe times out. On HTTP a
 * 5xx or a timeout makes connect reject instead (Spring AI answers the probe
 * 500), and the connect is made again in the 2025 protocol on a fresh
 * transport. A network error rejects too, but says nothing about the server:
 * one still starting would be reached in 2025 for the session, or never if it
 * speaks only 2026-07-28. It fails the attempt, and the transient retry
 * (connectRetry.ts) probes again. An auth failure is never a reason to change
 * era.
 *
 * A cached verdict that fails to connect is dropped and the connect is made
 * again with a probe. A modern one cannot fail to connect, since adopting it
 * sends nothing, so on stdio it is confirmed inside the connect with one
 * `server/discover` on the session's own pipe (confirmsPriorInPlace): a
 * round trip, still without the probe's second spawn. A 2025 server answers
 * it with an error or exits, and the connect drops the verdict and probes
 * once.
 */
import {
  type DiscoverResult,
  type PriorDiscovery,
  type ProtocolEra,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from '@modelcontextprotocol/client'
import type { McpProtocolMode } from 'src/mcp/client/serverOptions.js'

/** Which SDK transport a connect runs on; only these two can negotiate. */
export type NegotiableTransport = 'http' | 'stdio' | 'other'

export type EraVerdict =
  | { kind: 'modern'; discover: DiscoverResult; savedAt: number; ttlMs: number }
  | { kind: 'legacy'; savedAt: number; ttlMs: number }

/**
 * Why a connect does not follow the cache: the 2025 protocol after the server
 * turned the probe down, or a probe after a cached verdict failed.
 */
export type EraOverride = { kind: 'legacy' } | { kind: 'probe' }

export type ConnectPlan = {
  /** The client's `versionNegotiation.mode`. */
  mode: 'auto' | 'legacy'
  /** A cached verdict for `connect(t, { prior })`. */
  prior?: PriorDiscovery
  /** The probe's own timeout, set when a probe runs. */
  probeTimeoutMs?: number
}

export const MAX_PROBE_TIMEOUT_MS = 5000
const HOUR_MS = 60 * 60 * 1000
export const MIN_MODERN_VERDICT_TTL_MS = HOUR_MS
export const MAX_VERDICT_TTL_MS = 24 * HOUR_MS
export const LEGACY_VERDICT_TTL_MS = 24 * HOUR_MS

export function probeTimeoutMs(startupTimeoutMs: number): number {
  return Math.min(MAX_PROBE_TIMEOUT_MS, startupTimeoutMs)
}

export function isVerdictFresh(verdict: EraVerdict, now: number): boolean {
  // A clock set back makes every entry look young; it is stale instead.
  return now >= verdict.savedAt && now - verdict.savedAt < verdict.ttlMs
}

function toPrior(verdict: EraVerdict): PriorDiscovery {
  return verdict.kind === 'modern' ? { kind: 'modern', discover: verdict.discover } : { kind: 'legacy' }
}

/** Whether a verdict of this kind is cached for, and replayed on, this transport (see the header). */
function isReplayed(kind: EraVerdict['kind'], transport: NegotiableTransport): boolean {
  return kind === 'legacy' || transport === 'stdio'
}

/**
 * Whether planConnect looks at a cached verdict: an `auto` connect on a
 * transport that negotiates, with no override. The caller reads the cache
 * only then.
 */
export function readsCachedVerdict(input: {
  mode: McpProtocolMode
  transport: NegotiableTransport
  override: EraOverride | undefined
}): boolean {
  return input.mode === 'auto' && input.transport !== 'other' && input.override === undefined
}

export function planConnect(input: {
  mode: McpProtocolMode
  transport: NegotiableTransport
  verdict: EraVerdict | undefined
  override: EraOverride | undefined
  startupTimeoutMs: number
  now: number
}): ConnectPlan {
  if (input.mode === 'legacy' || input.transport === 'other') return { mode: 'legacy' }
  if (input.override?.kind === 'legacy') return { mode: 'legacy' }
  const probe: ConnectPlan = { mode: 'auto', probeTimeoutMs: probeTimeoutMs(input.startupTimeoutMs) }
  // Past the two legacy cases, only a probe override is left to refuse the cache.
  if (!readsCachedVerdict(input)) return probe
  if (
    input.verdict &&
    isVerdictFresh(input.verdict, input.now) &&
    isReplayed(input.verdict.kind, input.transport)
  ) {
    return { mode: 'auto', prior: toPrior(input.verdict) }
  }
  return probe
}

/** Whether the connect confirms a cached modern verdict before handing the connection out. */
export function confirmsPriorInPlace(plan: ConnectPlan, transport: NegotiableTransport): boolean {
  return plan.prior?.kind === 'modern' && transport === 'stdio'
}

export function isAuthConnectError(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return true
  if (error instanceof SdkHttpError) {
    return (
      error.code === SdkErrorCode.ClientHttpAuthentication ||
      error.code === SdkErrorCode.ClientHttpForbidden ||
      error.status === 401 ||
      error.status === 403
    )
  }
  return false
}

/** A probe the server answered 5xx, or took and never answered. */
function isProbeTurnedDown(error: unknown): boolean {
  return (
    (error instanceof SdkHttpError && error.code === SdkErrorCode.EraNegotiationFailed && error.status >= 500) ||
    (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout)
  )
}

/** The next connect after this one failed, or null when the failure stands. */
export function nextEraStep(
  error: unknown,
  { plan, transport }: { plan: ConnectPlan; transport: NegotiableTransport },
): EraOverride | null {
  if (isAuthConnectError(error)) return null
  if (plan.prior) return { kind: 'probe' }
  if (plan.mode !== 'auto' || transport !== 'http' || !isProbeTurnedDown(error)) return null
  return { kind: 'legacy' }
}

function discoverTtlMs(discover: DiscoverResult): number {
  const raw = (discover as { ttlMs?: unknown }).ttlMs
  const ttl = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
  return Math.min(MAX_VERDICT_TTL_MS, Math.max(MIN_MODERN_VERDICT_TTL_MS, ttl))
}

/**
 * What to cache after a connect succeeded. A connect made from a cached
 * verdict caches nothing: saving it again would keep a legacy verdict alive
 * forever, since an upgraded server still answers `initialize`.
 */
export function verdictAfterConnect(input: {
  plan: ConnectPlan
  transport: NegotiableTransport
  override: EraOverride | undefined
  era: ProtocolEra | undefined
  discover: DiscoverResult | undefined
  now: number
}): EraVerdict | undefined {
  // The server turned the probe down; once initialize works, that is its verdict.
  if (input.override?.kind === 'legacy') return { kind: 'legacy', savedAt: input.now, ttlMs: LEGACY_VERDICT_TTL_MS }
  if (input.plan.mode !== 'auto' || input.plan.prior) return undefined
  if (input.era === 'modern' && input.discover && isReplayed('modern', input.transport)) {
    return { kind: 'modern', discover: input.discover, savedAt: input.now, ttlMs: discoverTtlMs(input.discover) }
  }
  if (input.era === 'legacy') return { kind: 'legacy', savedAt: input.now, ttlMs: LEGACY_VERDICT_TTL_MS }
  return undefined
}
