import { describe, expect, test } from 'bun:test'
import {
  type DiscoverResult,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from '@modelcontextprotocol/client'
import {
  confirmsPriorInPlace,
  type ConnectPlan,
  type EraVerdict,
  isAuthConnectError,
  isVerdictFresh,
  LEGACY_VERDICT_TTL_MS,
  MAX_VERDICT_TTL_MS,
  MIN_MODERN_VERDICT_TTL_MS,
  nextEraStep,
  planConnect,
  probeTimeoutMs,
  verdictAfterConnect,
} from 'src/mcp/client/negotiation.js'

const NOW = 1_000_000_000
const discover = (ttlMs?: unknown) =>
  ({ supportedVersions: ['2026-07-28'], capabilities: {}, ...(ttlMs !== undefined && { ttlMs }) }) as DiscoverResult
const modern: EraVerdict = { kind: 'modern', discover: discover(), savedAt: NOW - 10, ttlMs: 60_000 }
const legacy: EraVerdict = { kind: 'legacy', savedAt: NOW - 10, ttlMs: 60_000 }

const http = (status: number, code = SdkErrorCode.ClientHttpNotImplemented) =>
  new SdkHttpError(code, `HTTP ${status}`, { status })

function plan(overrides: Partial<Parameters<typeof planConnect>[0]> = {}): ConnectPlan {
  return planConnect({
    mode: 'auto',
    transport: 'http',
    verdict: undefined,
    override: undefined,
    startupTimeoutMs: 30_000,
    now: NOW,
    ...overrides,
  })
}

describe('probeTimeoutMs', () => {
  test('is 5 s, or the startup timeout when that is shorter', () => {
    expect(probeTimeoutMs(30_000)).toBe(5000)
    expect(probeTimeoutMs(1200)).toBe(1200)
  })
})

describe('isVerdictFresh', () => {
  test('within its TTL only, and never from the future', () => {
    expect(isVerdictFresh(legacy, NOW)).toBe(true)
    expect(isVerdictFresh(legacy, NOW - 10 + 60_000)).toBe(false)
    expect(isVerdictFresh(legacy, NOW - 11)).toBe(false)
  })
})

describe('planConnect', () => {
  test('a legacy server, or a transport that cannot negotiate, goes straight to initialize', () => {
    expect(plan({ mode: 'legacy', verdict: modern })).toEqual({ mode: 'legacy' })
    expect(plan({ transport: 'other', verdict: modern })).toEqual({ mode: 'legacy' })
  })

  test('without a fresh verdict, probes within the startup timeout', () => {
    expect(plan()).toEqual({ mode: 'auto', probeTimeoutMs: 5000 })
    expect(plan({ transport: 'stdio', startupTimeoutMs: 800 })).toEqual({ mode: 'auto', probeTimeoutMs: 800 })
    expect(plan({ verdict: { ...legacy, savedAt: NOW - 60_000 } })).toEqual({ mode: 'auto', probeTimeoutMs: 5000 })
  })

  test('a fresh verdict is handed to the SDK as the prior; over HTTP only a legacy one', () => {
    expect(plan({ transport: 'stdio', verdict: modern })).toEqual({
      mode: 'auto',
      prior: { kind: 'modern', discover: modern.discover },
    })
    expect(plan({ transport: 'stdio', verdict: legacy })).toEqual({ mode: 'auto', prior: { kind: 'legacy' } })
    expect(plan({ verdict: legacy })).toEqual({ mode: 'auto', prior: { kind: 'legacy' } })
    expect(plan({ verdict: modern })).toEqual({ mode: 'auto', probeTimeoutMs: 5000 })
  })

  test('an override wins over the cache', () => {
    expect(plan({ verdict: modern, override: { kind: 'legacy' } })).toEqual({ mode: 'legacy' })
    expect(plan({ verdict: modern, override: { kind: 'probe' } })).toEqual({ mode: 'auto', probeTimeoutMs: 5000 })
  })
})

describe('isAuthConnectError', () => {
  test('401, 403 and the SDK auth errors', () => {
    expect(isAuthConnectError(new UnauthorizedError())).toBe(true)
    expect(isAuthConnectError(http(401, SdkErrorCode.ClientHttpAuthentication))).toBe(true)
    expect(isAuthConnectError(http(403, SdkErrorCode.ClientHttpForbidden))).toBe(true)
    expect(isAuthConnectError(http(401))).toBe(true)
    expect(isAuthConnectError(http(403))).toBe(true)
    expect(isAuthConnectError(http(500))).toBe(false)
    expect(isAuthConnectError(new Error('401'))).toBe(false)
  })
})

describe('nextEraStep', () => {
  const probing = plan()
  const timeout = new SdkError(SdkErrorCode.RequestTimeout, 'probe timed out')
  const network = new SdkError(SdkErrorCode.EraNegotiationFailed, 'probe failed: ECONNREFUSED')

  test('a 5xx on the HTTP probe goes to the 2025 protocol', () => {
    expect(nextEraStep(http(500, SdkErrorCode.EraNegotiationFailed), { plan: probing, transport: 'http' })).toEqual({
      kind: 'legacy',
    })
  })

  test('a timed-out probe too; a network error fails the attempt, for the transient retry to probe again', () => {
    expect(nextEraStep(timeout, { plan: probing, transport: 'http' })).toEqual({ kind: 'legacy' })
    expect(nextEraStep(network, { plan: probing, transport: 'http' })).toBeNull()
  })

  test('nothing for stdio (the SDK falls back itself), a legacy plan, or another error', () => {
    expect(nextEraStep(timeout, { plan: probing, transport: 'stdio' })).toBeNull()
    expect(nextEraStep(timeout, { plan: { mode: 'legacy' }, transport: 'http' })).toBeNull()
    expect(nextEraStep(new Error('spawn ENOENT'), { plan: probing, transport: 'http' })).toBeNull()
    expect(nextEraStep(http(503), { plan: probing, transport: 'http' })).toBeNull()
  })

  test('a failed cached verdict is probed again, unless the failure is auth', () => {
    const fromCache = plan({ verdict: legacy })
    expect(nextEraStep(new Error('Connection closed'), { plan: fromCache, transport: 'stdio' })).toEqual({
      kind: 'probe',
    })
    expect(nextEraStep(new UnauthorizedError(), { plan: fromCache, transport: 'http' })).toBeNull()
    expect(nextEraStep(http(401, SdkErrorCode.EraNegotiationFailed), { plan: probing, transport: 'http' })).toBeNull()
  })
})

describe('verdictAfterConnect', () => {
  const probing = plan()
  const after = (input: Partial<Parameters<typeof verdictAfterConnect>[0]>) =>
    verdictAfterConnect({
      plan: probing,
      transport: 'stdio',
      override: undefined,
      era: undefined,
      discover: undefined,
      now: NOW,
      ...input,
    })

  test('a probed modern server: the discover result, its ttlMs clamped to 1 h–24 h', () => {
    expect(after({ era: 'modern', discover: discover() })).toEqual({
      kind: 'modern',
      discover: discover(),
      savedAt: NOW,
      ttlMs: MIN_MODERN_VERDICT_TTL_MS,
    })
    expect(after({ era: 'modern', discover: discover(3 * 60 * 60 * 1000) })?.ttlMs).toBe(3 * 60 * 60 * 1000)
    expect(after({ era: 'modern', discover: discover(10 * MAX_VERDICT_TTL_MS) })?.ttlMs).toBe(MAX_VERDICT_TTL_MS)
    expect(after({ era: 'modern', discover: discover('soon') })?.ttlMs).toBe(MIN_MODERN_VERDICT_TTL_MS)
  })

  test('a probed legacy server: 24 h', () => {
    expect(after({ era: 'legacy' })).toEqual({ kind: 'legacy', savedAt: NOW, ttlMs: LEGACY_VERDICT_TTL_MS })
    expect(after({ era: 'legacy', transport: 'http' })).toEqual({ kind: 'legacy', savedAt: NOW, ttlMs: LEGACY_VERDICT_TTL_MS })
  })

  test('over HTTP a modern server is not cached, since nothing would replay it', () => {
    expect(after({ era: 'modern', discover: discover(), transport: 'http' })).toBeUndefined()
  })

  test('a fallback after the server turned the probe down is cached', () => {
    expect(after({ plan: { mode: 'legacy' }, override: { kind: 'legacy' }, era: 'legacy' })).toEqual({
      kind: 'legacy',
      savedAt: NOW,
      ttlMs: LEGACY_VERDICT_TTL_MS,
    })
  })

  test('nothing for a connect from the cache, a legacy plan, or an unknown era', () => {
    expect(after({ plan: plan({ verdict: legacy }), era: 'legacy' })).toBeUndefined()
    expect(after({ plan: { mode: 'legacy' }, era: 'legacy' })).toBeUndefined()
    expect(after({ era: undefined })).toBeUndefined()
    expect(after({ era: 'modern', discover: undefined })).toBeUndefined()
  })
})

describe('checking a cached modern verdict', () => {
  const adopted = plan({ transport: 'stdio', verdict: modern })
  test('stdio confirms it in place', () => {
    expect(confirmsPriorInPlace(adopted, 'stdio')).toBe(true)
  })

  test('nothing to check without a modern prior', () => {
    for (const p of [plan(), plan({ verdict: legacy }), plan({ verdict: modern }), plan({ mode: 'legacy' })]) {
      expect(confirmsPriorInPlace(p, 'stdio')).toBe(false)
    }
  })
})
