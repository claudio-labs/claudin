import { describe, expect, test } from 'bun:test'

import {
  extractRateLimitInfo,
  getRateLimitResetDelayMs,
  getRetryAfterMs,
  isLongRateLimit,
  isQuotaExhaustedError,
  parseOpenAIDuration,
  parseRetryAfterValue,
  RATE_LIMIT_RESET_CAP_MS,
  RATE_LIMIT_STOP_THRESHOLD_MS,
} from 'src/providers/rateLimitInfo.js'

const NOW = 1_700_000_000_000

type ErrorShape = {
  status?: number
  message?: string
  headers?: Record<string, string>
  body?: unknown
}

/**
 * The shape the SDK hands us: a Fetch `Headers` instance, a status and a
 * message that embeds the raw response body on the OpenAI-compatible path.
 */
function makeError({ status = 429, message = '', headers = {}, body }: ErrorShape) {
  return {
    status,
    message,
    headers: new Headers(headers),
    ...(body === undefined ? {} : { error: body }),
  }
}

describe('extractRateLimitInfo — reader table', () => {
  test('reads the Anthropic unified reset header', () => {
    const info = extractRateLimitInfo(
      makeError({
        headers: {
          'anthropic-ratelimit-unified-reset': String(NOW / 1000 + 7200),
        },
      }),
      NOW,
    )
    expect(info).toMatchObject({ kind: 'window', source: 'anthropic-unified' })
    expect(info?.resetsAtMs).toBe(NOW + 7_200_000)
  })

  test('reads the OpenAI reset headers and takes the earlier of the two', () => {
    // OpenAI reports both buckets on every 429, so the larger value is usually
    // the one that did NOT trip. Taking it would end a turn over a ten-second
    // throttle that a single retry clears.
    const info = extractRateLimitInfo(
      makeError({
        headers: {
          'x-ratelimit-reset-requests': '10s',
          'x-ratelimit-reset-tokens': '1m0s',
        },
      }),
      NOW,
    )
    expect(info).toMatchObject({ kind: 'window', source: 'openai-reset' })
    expect(info?.resetsAtMs).toBe(NOW + 10_000)
  })

  test('prefers the bucket the remaining counters say is spent', () => {
    const info = extractRateLimitInfo(
      makeError({
        headers: {
          'x-ratelimit-reset-requests': '10s',
          'x-ratelimit-remaining-requests': '4900',
          'x-ratelimit-reset-tokens': '1m0s',
          'x-ratelimit-remaining-tokens': '0',
        },
      }),
      NOW,
    )
    expect(info?.resetsAtMs).toBe(NOW + 60_000)
  })

  test('falls back to the one bucket that reported a reset', () => {
    const info = extractRateLimitInfo(
      makeError({ headers: { 'x-ratelimit-reset-tokens': '90s' } }),
      NOW,
    )
    expect(info?.resetsAtMs).toBe(NOW + 90_000)
  })

  test("reads Google's RetryInfo out of the response body", () => {
    const info = extractRateLimitInfo(
      makeError({
        message:
          'OpenAI API error 429: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED",' +
          '"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"42s"}]}}',
      }),
      NOW,
    )
    expect(info).toMatchObject({ kind: 'window', source: 'gemini-retry-info' })
    expect(info?.resetsAtMs).toBe(NOW + 42_000)
  })

  test('reads RetryInfo from a parsed body the SDK kept', () => {
    const info = extractRateLimitInfo(
      makeError({
        message: 'rate limited',
        body: {
          error: {
            status: 'RESOURCE_EXHAUSTED',
            details: [{ retryDelay: '1.5s' }],
          },
        },
      }),
      NOW,
    )
    expect(info?.source).toBe('gemini-retry-info')
    expect(info?.resetsAtMs).toBe(NOW + 1_500)
  })

  test('falls back to Retry-After when no specific header is present', () => {
    const info = extractRateLimitInfo(
      makeError({ headers: { 'retry-after': '30' } }),
      NOW,
    )
    expect(info).toMatchObject({ kind: 'window', source: 'retry-after' })
    expect(info?.resetsAtMs).toBe(NOW + 30_000)
  })

  test('a specific window header wins over a short Retry-After', () => {
    // The trap this ordering exists for: a multi-hour window limit that also
    // carries a two-second Retry-After. Honoring the generic header would
    // report a reset seconds away for a limit that clears in hours.
    const info = extractRateLimitInfo(
      makeError({
        headers: {
          'anthropic-ratelimit-unified-reset': String(NOW / 1000 + 14_400),
          'retry-after': '2',
        },
      }),
      NOW,
    )
    expect(info?.source).toBe('anthropic-unified')
    expect(info?.resetsAtMs).toBe(NOW + 14_400_000)
  })

  test('a header is read regardless of which provider sent it', () => {
    // No provider tag is consulted: a proxy in front of Bedrock that forwards
    // the header gets its reset honored rather than discarded.
    const info = extractRateLimitInfo(
      makeError({ headers: { 'x-ratelimit-reset-requests': '5s' } }),
      NOW,
    )
    expect(info?.resetsAtMs).toBe(NOW + 5_000)
  })

  test('reports a distant reset truthfully and caps only the wait', () => {
    // A weekly window is days out. Clamping the reported instant made the
    // message assert "resets in 6h" for a limit that clears on Thursday.
    const weekOut = 7 * 24 * 3_600_000
    const error = makeError({
      headers: {
        'anthropic-ratelimit-unified-reset': String(NOW / 1000 + weekOut / 1000),
      },
    })
    expect(extractRateLimitInfo(error, NOW)?.resetsAtMs).toBe(NOW + weekOut)
    expect(getRateLimitResetDelayMs(error as never, NOW)).toBe(
      RATE_LIMIT_RESET_CAP_MS,
    )
  })
})

describe('extractRateLimitInfo — classification', () => {
  test('returns null for anything that is not a 429', () => {
    expect(extractRateLimitInfo(makeError({ status: 500 }), NOW)).toBeNull()
    expect(extractRateLimitInfo(makeError({ status: 401 }), NOW)).toBeNull()
    expect(extractRateLimitInfo({}, NOW)).toBeNull()
  })

  test('a 429 with no reset signal at all is a burst', () => {
    const info = extractRateLimitInfo(makeError({ message: 'slow down' }), NOW)
    expect(info).toMatchObject({ kind: 'burst', source: 'none' })
    expect(info?.resetsAtMs).toBeUndefined()
  })

  test('billing exhaustion is its own kind and never carries a reset', () => {
    const info = extractRateLimitInfo(
      makeError({
        message: 'You exceeded your current quota, please check your plan',
        headers: { 'retry-after': '30' },
      }),
      NOW,
    )
    expect(info).toMatchObject({ kind: 'exhausted', source: 'none' })
    expect(info?.resetsAtMs).toBeUndefined()
  })

  test('a reset already in the past is not treated as a window', () => {
    const info = extractRateLimitInfo(
      makeError({
        headers: {
          'anthropic-ratelimit-unified-reset': String(NOW / 1000 - 10),
        },
      }),
      NOW,
    )
    expect(info?.kind).toBe('burst')
  })

  test('strips the shim category marker and the status prefix from the detail', () => {
    const info = extractRateLimitInfo(
      makeError({
        message:
          '429 OpenAI API error 429: too many requests [openai_category=rate_limited]',
      }),
      NOW,
    )
    expect(info?.detail).toBe('OpenAI API error 429: too many requests')
  })

  test('pulls the inner message out of a JSON envelope', () => {
    const info = extractRateLimitInfo(
      makeError({ message: '429 {"type":"error","message":"quota per minute"}' }),
      NOW,
    )
    expect(info?.detail).toBe('quota per minute')
  })
})

describe('isQuotaExhaustedError', () => {
  test('matches the two provider wordings', () => {
    expect(
      isQuotaExhaustedError(makeError({ message: 'Rate limit reached, limit: 0' })),
    ).toBe(true)
    expect(
      isQuotaExhaustedError(
        makeError({ message: 'You exceeded your current quota' }),
      ),
    ).toBe(true)
  })

  test('does not match an ordinary 429 or a non-429', () => {
    expect(isQuotaExhaustedError(makeError({ message: 'too many requests' }))).toBe(
      false,
    )
    expect(
      isQuotaExhaustedError(makeError({ status: 500, message: 'limit: 0' })),
    ).toBe(false)
  })
})

describe('getRateLimitResetDelayMs', () => {
  test('returns the delay when a reader found one', () => {
    expect(
      getRateLimitResetDelayMs(
        makeError({ headers: { 'x-ratelimit-reset-requests': '30s' } }) as never,
        NOW,
      ),
    ).toBe(30_000)
  })

  test('returns null when nothing reported a reset', () => {
    expect(getRateLimitResetDelayMs(makeError({}) as never, NOW)).toBeNull()
  })

  test('returns null for a non-rate-limit error', () => {
    expect(
      getRateLimitResetDelayMs(makeError({ status: 500 }) as never, NOW),
    ).toBeNull()
  })
})

describe('isLongRateLimit', () => {
  test('a reset past the threshold is long', () => {
    expect(
      isLongRateLimit(
        makeError({
          headers: { 'retry-after': String(RATE_LIMIT_STOP_THRESHOLD_MS / 1000 + 1) },
        }),
        NOW,
      ),
    ).toBe(true)
  })

  test('a reset at or under the threshold is not', () => {
    expect(
      isLongRateLimit(
        makeError({
          headers: { 'retry-after': String(RATE_LIMIT_STOP_THRESHOLD_MS / 1000) },
        }),
        NOW,
      ),
    ).toBe(false)
    expect(
      isLongRateLimit(makeError({ headers: { 'retry-after': '3' } }), NOW),
    ).toBe(false)
  })

  test('an unreported reset is not long — backoff is still the best guess', () => {
    expect(isLongRateLimit(makeError({ message: 'slow down' }), NOW)).toBe(false)
  })

  test('billing exhaustion is not long — there is nothing to wait for', () => {
    expect(
      isLongRateLimit(
        makeError({
          message: 'You exceeded your current quota',
          headers: { 'retry-after': '7200' },
        }),
        NOW,
      ),
    ).toBe(false)
  })

  test('a non-429 is never long', () => {
    expect(
      isLongRateLimit(
        makeError({ status: 503, headers: { 'retry-after': '7200' } }),
        NOW,
      ),
    ).toBe(false)
  })
})

describe('parseRetryAfterValue', () => {
  test('parses integer and decimal seconds', () => {
    expect(parseRetryAfterValue('5', NOW)).toBe(5000)
    expect(parseRetryAfterValue('0.5', NOW)).toBe(500)
    expect(parseRetryAfterValue('0', NOW)).toBe(0)
  })

  test('parses an HTTP-date as a delta and clamps a past one at zero', () => {
    expect(parseRetryAfterValue(new Date(NOW + 30_000).toUTCString(), NOW)).toBe(
      30_000,
    )
    expect(parseRetryAfterValue(new Date(NOW - 60_000).toUTCString(), NOW)).toBe(0)
  })

  test('returns null for empty and unparseable input', () => {
    expect(parseRetryAfterValue(null, NOW)).toBeNull()
    expect(parseRetryAfterValue(undefined, NOW)).toBeNull()
    expect(parseRetryAfterValue('   ', NOW)).toBeNull()
    expect(parseRetryAfterValue('not-a-number', NOW)).toBeNull()
  })

  test('clamps a date-shaped value in the past to zero', () => {
    // "-5" fails the digits-only regex and Date.parse reads it as the year 5
    // BC, so this is the branch that actually runs for malformed input.
    expect(parseRetryAfterValue('-5', NOW)).toBe(0)
  })

  test('rejects a digit run long enough to overflow to Infinity', () => {
    expect(parseRetryAfterValue('9'.repeat(400), NOW)).toBeNull()
  })

  test('caps at six hours', () => {
    expect(parseRetryAfterValue('999999', NOW)).toBe(RATE_LIMIT_RESET_CAP_MS)
  })
})

describe('getRetryAfterMs', () => {
  test('prefers the millisecond extension over the RFC header', () => {
    expect(
      getRetryAfterMs(
        makeError({ headers: { 'retry-after-ms': '1500', 'retry-after': '30' } }),
        NOW,
      ),
    ).toBe(1500)
  })

  test('falls back to retry-after when the ms extension is absent', () => {
    expect(getRetryAfterMs(makeError({ headers: { 'retry-after': '30' } }), NOW)).toBe(
      30_000,
    )
  })
})

describe('parseOpenAIDuration', () => {
  test('parses the Go duration forms', () => {
    expect(parseOpenAIDuration('1s')).toBe(1000)
    expect(parseOpenAIDuration('6m0s')).toBe(360_000)
    expect(parseOpenAIDuration('1h30m0s')).toBe(5_400_000)
    expect(parseOpenAIDuration('500ms')).toBe(500)
    expect(parseOpenAIDuration('2m')).toBe(120_000)
  })

  test('returns null for empty and unrecognized input', () => {
    expect(parseOpenAIDuration('')).toBeNull()
    expect(parseOpenAIDuration('invalid')).toBeNull()
  })
})
