import { APIError } from '@anthropic-ai/sdk'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from 'bun:test'

import * as auth from 'src/providers/auth/auth.js'
import * as providers from 'src/providers/model/providers.js'
import * as privacyLevel from 'src/platform/config/privacyLevel.js'
import * as clientCache from 'src/providers/transport/clientCache.js'
import {
  getIsInteractive,
  setIsInteractive,
} from 'src/platform/bootstrap/state.js'
import {
  getGlobalConfig,
  resetGlobalConfigForTests,
} from 'src/platform/config/config.js'
import {
  checkQuotaStatus,
  type ClaudeAILimits,
  currentLimits,
  emitStatusChange,
  extractQuotaStatusFromError,
  extractQuotaStatusFromHeaders,
  getRawUtilization,
  statusListeners,
} from 'src/providers/claudeAiLimits.js'

// Characterization suite: pins how the unified-limiter headers become
// ClaudeAILimits before the per-provider limit alert rewrites the consumers.

const NOW_MS = 1_800_000_000_000
const NOW_S = NOW_MS / 1000
const HOUR = 3600

const DEFAULT_LIMITS: ClaudeAILimits = {
  status: 'allowed',
  unifiedRateLimitFallbackAvailable: false,
  isUsingOverage: false,
}

const PREFIX = 'anthropic-ratelimit-unified-'

function unified(fields: Record<string, string>): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(fields)) {
    headers.set(`${PREFIX}${key}`, value)
  }
  return headers
}

function apiError(status: number, headers: Headers | undefined): APIError {
  return new APIError(
    status,
    { type: 'error' },
    'limited',
    headers as unknown as Headers,
  )
}

let subscriber = true
let emitted: ClaudeAILimits[] = []
const listener = (limits: ClaudeAILimits): void => {
  emitted.push(limits)
}
const spies: Array<{ mockRestore: () => void }> = []
let wasInteractive = false

beforeAll(() => {
  wasInteractive = getIsInteractive()
  spies.push(spyOn(auth, 'isClaudeAISubscriber').mockImplementation(() => subscriber))
})

afterAll(() => {
  for (const spy of spies) spy.mockRestore()
  setIsInteractive(wasInteractive)
})

beforeEach(() => {
  setSystemTime(new Date(NOW_MS))
  subscriber = true
  emitStatusChange({ ...DEFAULT_LIMITS })
  // A non-subscriber pass is the module's own way to clear rawUtilization.
  subscriber = false
  extractQuotaStatusFromHeaders(new Headers())
  subscriber = true
  emitted = []
  statusListeners.add(listener)
})

afterEach(() => {
  statusListeners.delete(listener)
  emitStatusChange({ ...DEFAULT_LIMITS })
  resetGlobalConfigForTests()
  setSystemTime()
})

describe('extractQuotaStatusFromHeaders — status, reset and overage', () => {
  test('a plain allowed response carries the reset and fallback flags only', () => {
    extractQuotaStatusFromHeaders(
      unified({ status: 'allowed', reset: String(NOW_S + HOUR), fallback: 'available' }),
    )
    expect(currentLimits).toEqual({
      status: 'allowed',
      resetsAt: NOW_S + HOUR,
      unifiedRateLimitFallbackAvailable: true,
      isUsingOverage: false,
    })
  })

  test('missing status defaults to allowed and a non-"available" fallback is false', () => {
    extractQuotaStatusFromHeaders(unified({ fallback: 'unavailable' }))
    expect(currentLimits).toEqual({
      status: 'allowed',
      resetsAt: undefined,
      unifiedRateLimitFallbackAvailable: false,
      isUsingOverage: false,
    })
  })

  test('rejected with overage allowed is "using overage" and keeps every overage field', () => {
    extractQuotaStatusFromHeaders(
      unified({
        status: 'rejected',
        reset: String(NOW_S + 2 * HOUR),
        'representative-claim': 'five_hour',
        'overage-status': 'allowed',
        'overage-reset': String(NOW_S + 5 * HOUR),
        'overage-disabled-reason': 'out_of_credits',
      }),
    )
    expect(currentLimits).toEqual({
      status: 'rejected',
      resetsAt: NOW_S + 2 * HOUR,
      unifiedRateLimitFallbackAvailable: false,
      rateLimitType: 'five_hour',
      overageStatus: 'allowed',
      overageResetsAt: NOW_S + 5 * HOUR,
      overageDisabledReason: 'out_of_credits',
      isUsingOverage: true,
    })
  })

  test('overage allowed_warning also counts as using overage', () => {
    extractQuotaStatusFromHeaders(
      unified({ status: 'rejected', 'overage-status': 'allowed_warning' }),
    )
    expect(currentLimits.isUsingOverage).toBe(true)
  })

  test('rejected with overage rejected is not using overage', () => {
    extractQuotaStatusFromHeaders(
      unified({ status: 'rejected', 'overage-status': 'rejected' }),
    )
    expect(currentLimits.isUsingOverage).toBe(false)
    expect(currentLimits.overageStatus).toBe('rejected')
  })

  test('allowed_warning with no threshold crossed is downgraded to allowed', () => {
    extractQuotaStatusFromHeaders(unified({ status: 'allowed_warning' }))
    expect(currentLimits.status).toBe('allowed')
  })
})

describe('early warning — server surpassed-threshold header', () => {
  test('5h threshold becomes a session warning with utilization and reset', () => {
    extractQuotaStatusFromHeaders(
      unified({
        status: 'allowed',
        fallback: 'available',
        '5h-surpassed-threshold': '0.9',
        '5h-utilization': '0.92',
        '5h-reset': String(NOW_S + HOUR),
      }),
    )
    expect(currentLimits).toEqual({
      status: 'allowed_warning',
      resetsAt: NOW_S + HOUR,
      rateLimitType: 'five_hour',
      utilization: 0.92,
      unifiedRateLimitFallbackAvailable: true,
      isUsingOverage: false,
      surpassedThreshold: 0.9,
    })
  })

  test('7d threshold without utilization/reset headers leaves them undefined', () => {
    extractQuotaStatusFromHeaders(
      unified({ status: 'allowed_warning', '7d-surpassed-threshold': '0.75' }),
    )
    expect(currentLimits).toEqual({
      status: 'allowed_warning',
      resetsAt: undefined,
      rateLimitType: 'seven_day',
      utilization: undefined,
      unifiedRateLimitFallbackAvailable: false,
      isUsingOverage: false,
      surpassedThreshold: 0.75,
    })
  })

  test('the overage claim maps to the overage limit type', () => {
    extractQuotaStatusFromHeaders(
      unified({ 'overage-surpassed-threshold': '0.8', 'overage-utilization': '0.81' }),
    )
    expect(currentLimits.rateLimitType).toBe('overage')
    expect(currentLimits.utilization).toBe(0.81)
  })

  test('5h is checked before 7d when both thresholds are present', () => {
    extractQuotaStatusFromHeaders(
      unified({ '7d-surpassed-threshold': '0.5', '5h-surpassed-threshold': '0.9' }),
    )
    expect(currentLimits.rateLimitType).toBe('five_hour')
  })

  test('a rejected status skips early warning entirely', () => {
    extractQuotaStatusFromHeaders(
      unified({ status: 'rejected', '5h-surpassed-threshold': '0.9' }),
    )
    expect(currentLimits.status).toBe('rejected')
    expect(currentLimits.surpassedThreshold).toBeUndefined()
  })
})

describe('early warning — time-relative fallback', () => {
  test('90% of the 5h window used with 1h of 5h elapsed warns', () => {
    extractQuotaStatusFromHeaders(
      unified({ '5h-utilization': '0.9', '5h-reset': String(NOW_S + 4 * HOUR) }),
    )
    expect(currentLimits).toEqual({
      status: 'allowed_warning',
      resetsAt: NOW_S + 4 * HOUR,
      rateLimitType: 'five_hour',
      utilization: 0.9,
      unifiedRateLimitFallbackAvailable: false,
      isUsingOverage: false,
    })
  })

  test('the same usage late in the 5h window does not warn', () => {
    extractQuotaStatusFromHeaders(
      unified({ '5h-utilization': '0.95', '5h-reset': String(NOW_S + HOUR) }),
    )
    expect(currentLimits.status).toBe('allowed')
    expect(currentLimits.rateLimitType).toBeUndefined()
  })

  test('just under the 5h utilization threshold does not warn', () => {
    extractQuotaStatusFromHeaders(
      unified({ '5h-utilization': '0.89', '5h-reset': String(NOW_S + 4 * HOUR) }),
    )
    expect(currentLimits.status).toBe('allowed')
  })

  test('the 7d window warns on its middle threshold (50% used, 30% elapsed)', () => {
    // 30% of 7 days elapsed → reset in 70% of the window.
    const reset = NOW_S + Math.round(0.7 * 7 * 24 * HOUR)
    extractQuotaStatusFromHeaders(
      unified({ '7d-utilization': '0.5', '7d-reset': String(reset) }),
    )
    expect(currentLimits.status).toBe('allowed_warning')
    expect(currentLimits.rateLimitType).toBe('seven_day')
    expect(currentLimits.utilization).toBe(0.5)
  })

  test('the 7d window does not warn at 50% used with 40% elapsed', () => {
    const reset = NOW_S + Math.round(0.6 * 7 * 24 * HOUR)
    extractQuotaStatusFromHeaders(
      unified({ '7d-utilization': '0.5', '7d-reset': String(reset) }),
    )
    expect(currentLimits.status).toBe('allowed')
  })

  test('a utilization header without its reset is ignored', () => {
    extractQuotaStatusFromHeaders(unified({ '5h-utilization': '0.99' }))
    expect(currentLimits.status).toBe('allowed')
  })

  test('a reset already in the past clamps progress to the end of the window', () => {
    extractQuotaStatusFromHeaders(
      unified({ '5h-utilization': '0.99', '5h-reset': String(NOW_S - HOUR) }),
    )
    expect(currentLimits.status).toBe('allowed')
  })

  test('a window that has not started clamps progress to zero and warns', () => {
    extractQuotaStatusFromHeaders(
      unified({ '5h-utilization': '0.9', '5h-reset': String(NOW_S + 10 * HOUR) }),
    )
    expect(currentLimits.status).toBe('allowed_warning')
  })
})

describe('raw utilization', () => {
  test('records each window that has both utilization and reset', () => {
    extractQuotaStatusFromHeaders(
      unified({
        '5h-utilization': '0.4',
        '5h-reset': String(NOW_S + HOUR),
        '7d-utilization': '0.2',
      }),
    )
    expect(getRawUtilization()).toEqual({
      five_hour: { utilization: 0.4, resets_at: NOW_S + HOUR },
    })
  })

  test('is cleared for a non-subscriber', () => {
    extractQuotaStatusFromHeaders(
      unified({ '7d-utilization': '0.2', '7d-reset': String(NOW_S + HOUR) }),
    )
    expect(getRawUtilization().seven_day).toEqual({
      utilization: 0.2,
      resets_at: NOW_S + HOUR,
    })
    subscriber = false
    extractQuotaStatusFromHeaders(
      unified({ '7d-utilization': '0.2', '7d-reset': String(NOW_S + HOUR) }),
    )
    expect(getRawUtilization()).toEqual({})
  })
})

describe('emission and the subscriber gate', () => {
  test('listeners receive a change and not a repeat of the same limits', () => {
    const headers = unified({ status: 'rejected', reset: String(NOW_S + HOUR) })
    extractQuotaStatusFromHeaders(headers)
    extractQuotaStatusFromHeaders(headers)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.status).toBe('rejected')
  })

  test('a non-subscriber with stale limits is reset to the defaults once', () => {
    extractQuotaStatusFromHeaders(unified({ status: 'rejected' }))
    subscriber = false
    extractQuotaStatusFromHeaders(unified({ status: 'rejected' }))
    extractQuotaStatusFromHeaders(unified({ status: 'rejected' }))
    expect(emitted.map(l => l.status)).toEqual(['rejected', 'allowed'])
    expect(currentLimits).toEqual(DEFAULT_LIMITS)
  })

  test('a non-subscriber with a lingering reset only is reset too', () => {
    emitStatusChange({ ...DEFAULT_LIMITS, resetsAt: NOW_S + HOUR })
    emitted = []
    subscriber = false
    extractQuotaStatusFromHeaders(new Headers())
    expect(emitted).toEqual([DEFAULT_LIMITS])
  })

  test('a non-subscriber already at defaults emits nothing', () => {
    subscriber = false
    extractQuotaStatusFromHeaders(unified({ status: 'rejected' }))
    expect(emitted).toEqual([])
  })

  test('the overage disabled reason is cached in the global config', () => {
    extractQuotaStatusFromHeaders(
      unified({ 'overage-disabled-reason': 'org_level_disabled' }),
    )
    expect(getGlobalConfig().cachedExtraUsageDisabledReason).toBe(
      'org_level_disabled',
    )
    extractQuotaStatusFromHeaders(unified({}))
    expect(getGlobalConfig().cachedExtraUsageDisabledReason).toBeNull()
  })
})

describe('extractQuotaStatusFromError', () => {
  test('a 429 with headers is forced to rejected', () => {
    extractQuotaStatusFromError(
      apiError(
        429,
        unified({
          status: 'allowed',
          reset: String(NOW_S + HOUR),
          'representative-claim': 'seven_day',
          '7d-utilization': '1',
          '7d-reset': String(NOW_S + HOUR),
        }),
      ),
    )
    expect(currentLimits.status).toBe('rejected')
    expect(getRawUtilization().seven_day).toEqual({
      utilization: 1,
      resets_at: NOW_S + HOUR,
    })
  })

  test('a 429 without headers rejects the current limits as they are', () => {
    emitStatusChange({ ...DEFAULT_LIMITS, rateLimitType: 'five_hour' })
    emitted = []
    extractQuotaStatusFromError(apiError(429, undefined))
    expect(currentLimits).toEqual({
      ...DEFAULT_LIMITS,
      rateLimitType: 'five_hour',
      status: 'rejected',
    })
    expect(emitted).toHaveLength(1)
  })

  test('a repeated 429 does not re-emit', () => {
    extractQuotaStatusFromError(apiError(429, undefined))
    extractQuotaStatusFromError(apiError(429, undefined))
    expect(emitted).toHaveLength(1)
  })

  test('a non-429 error is ignored', () => {
    extractQuotaStatusFromError(apiError(500, unified({ status: 'rejected' })))
    expect(emitted).toEqual([])
    expect(currentLimits.status).toBe('allowed')
  })

  test('a non-subscriber 429 is ignored', () => {
    subscriber = false
    extractQuotaStatusFromError(apiError(429, unified({ status: 'rejected' })))
    expect(emitted).toEqual([])
  })
})

describe('checkQuotaStatus gates', () => {
  let essentialOnly = false
  let apiProvider: ReturnType<typeof providers.getAPIProvider> = 'firstParty'
  let queries = 0
  let response: { headers: Headers } | Error = { headers: new Headers() }
  const gateSpies: Array<{ mockRestore: () => void }> = []

  beforeEach(() => {
    essentialOnly = false
    apiProvider = 'firstParty'
    queries = 0
    response = { headers: new Headers() }
    setIsInteractive(true)
    gateSpies.push(
      spyOn(privacyLevel, 'isEssentialTrafficOnly').mockImplementation(
        () => essentialOnly,
      ),
      spyOn(providers, 'getAPIProvider').mockImplementation(() => apiProvider),
      spyOn(clientCache, 'getCachedAnthropicClient').mockImplementation(
        async () => {
          const fakeClient = {
            beta: {
              messages: {
                create: () => ({
                  asResponse: async () => {
                    queries++
                    if (response instanceof Error) throw response
                    return response
                  },
                }),
              },
            },
          }
          return fakeClient as unknown as Awaited<
            ReturnType<typeof clientCache.getCachedAnthropicClient>
          >
        },
      ),
    )
  })

  afterEach(() => {
    for (const spy of gateSpies.splice(0)) spy.mockRestore()
    setIsInteractive(wasInteractive)
  })

  test('an interactive first-party subscriber probes and reads the headers', async () => {
    response = { headers: unified({ status: 'rejected', reset: String(NOW_S + HOUR) }) }
    await checkQuotaStatus()
    expect(queries).toBe(1)
    expect(currentLimits.status).toBe('rejected')
  })

  test('a 429 from the probe goes through the error path', async () => {
    response = apiError(429, undefined)
    await checkQuotaStatus()
    expect(queries).toBe(1)
    expect(currentLimits.status).toBe('rejected')
  })

  test('a non-API error from the probe is swallowed without changing limits', async () => {
    response = new Error('socket hang up')
    await checkQuotaStatus()
    expect(queries).toBe(1)
    expect(currentLimits).toEqual(DEFAULT_LIMITS)
  })

  test('essential-traffic-only skips the probe', async () => {
    essentialOnly = true
    await checkQuotaStatus()
    expect(queries).toBe(0)
  })

  test('a third-party provider skips the probe', async () => {
    apiProvider = 'openai'
    await checkQuotaStatus()
    expect(queries).toBe(0)
  })

  test('a non-subscriber skips the probe', async () => {
    subscriber = false
    await checkQuotaStatus()
    expect(queries).toBe(0)
  })

  test('a non-interactive session skips the probe', async () => {
    setIsInteractive(false)
    await checkQuotaStatus()
    expect(queries).toBe(0)
  })
})
