import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'

// Helper to build a mock APIError with specific headers
function makeError(headers: Record<string, string>): APIError {
  const headersObj = new Headers(headers)
  return {
    headers: headersObj,
    status: 429,
    message: 'rate limit exceeded',
    name: 'APIError',
    error: {},
  } as unknown as APIError
}

// Save/restore env vars between tests
const originalEnv = { ...process.env }

const envKeys = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
] as const

beforeEach(() => {
  for (const key of envKeys) {
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  mock.restore()
})

async function importFreshWithRetryModule(
  provider:
    | 'firstParty'
    | 'openai'
    | 'github'
    | 'bedrock'
    | 'vertex'
    | 'gemini'
    | 'codex'
    | 'foundry' = 'firstParty',
) {
  mock.restore()
  mock.module('src/utils/model/providers.js', () => ({
    getAPIProvider: () => provider,
    getAPIProviderForStatsig: () => provider,
    // Other consumers in the dependency graph (claude.ts, client.ts) import
    // these symbols transitively. Stub them to keep the module load graph
    // resolvable when withRetry.ts is fresh-imported.
    isGithubNativeAnthropicMode: () => false,
    isFirstPartyAnthropicBaseUrl: () => provider === 'firstParty',
    usesAnthropicAccountFlow: () => false,
  }))
  return import(`./withRetry.js?ts=${Date.now()}-${Math.random()}`)
}

// --- parseOpenAIDuration ---
describe('parseOpenAIDuration', () => {
  test('parses seconds: "1s" → 1000', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('1s')).toBe(1000)
  })

  test('parses minutes+seconds: "6m0s" → 360000', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('6m0s')).toBe(360000)
  })

  test('parses hours+minutes+seconds: "1h30m0s" → 5400000', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('1h30m0s')).toBe(5400000)
  })

  test('parses milliseconds: "500ms" → 500', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('500ms')).toBe(500)
  })

  test('parses minutes only: "2m" → 120000', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('2m')).toBe(120000)
  })

  test('returns null for empty string', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('')).toBeNull()
  })

  test('returns null for unrecognized format', async () => {
    const { parseOpenAIDuration } = await importFreshWithRetryModule()
    expect(parseOpenAIDuration('invalid')).toBeNull()
  })
})

// --- getRateLimitResetDelayMs ---
describe('getRateLimitResetDelayMs - Anthropic (firstParty)', () => {
  test('reads anthropic-ratelimit-unified-reset Unix timestamp', async () => {
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('firstParty')
    const futureUnixSec = Math.floor(Date.now() / 1000) + 60
    const error = makeError({
      'anthropic-ratelimit-unified-reset': String(futureUnixSec),
    })
    const delay = getRateLimitResetDelayMs(error)
    expect(delay).not.toBeNull()
    expect(delay!).toBeGreaterThan(50_000)
    expect(delay!).toBeLessThanOrEqual(60_000)
  })

  test('returns null when header absent', async () => {
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('firstParty')
    const error = makeError({})
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })

  test('returns null when reset is in the past', async () => {
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('firstParty')
    const pastUnixSec = Math.floor(Date.now() / 1000) - 10
    const error = makeError({
      'anthropic-ratelimit-unified-reset': String(pastUnixSec),
    })
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })
})

describe('getRateLimitResetDelayMs - OpenAI provider', () => {
  test('reads x-ratelimit-reset-requests duration string', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('openai')
    const error = makeError({ 'x-ratelimit-reset-requests': '30s' })
    const delay = getRateLimitResetDelayMs(error)
    expect(delay).toBe(30_000)
  })

  test('reads x-ratelimit-reset-tokens and picks the larger delay', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('openai')
    const error = makeError({
      'x-ratelimit-reset-requests': '10s',
      'x-ratelimit-reset-tokens': '1m0s',
    })
    // Should use the larger of the two so we don't retry before both reset
    const delay = getRateLimitResetDelayMs(error)
    expect(delay).toBe(60_000)
  })

  test('returns null when no openai rate limit headers present', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('openai')
    const error = makeError({})
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })

  test('works for github provider too', async () => {
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('github')
    const error = makeError({ 'x-ratelimit-reset-requests': '5s' })
    expect(getRateLimitResetDelayMs(error)).toBe(5_000)
  })
})

describe('getRateLimitResetDelayMs - providers without reset headers', () => {
  test('returns null for bedrock', async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('bedrock')
    const error = makeError({ 'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 60) })
    // Bedrock doesn't use this header — should still return null
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })

  test('returns null for vertex', async () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('vertex')
    const error = makeError({})
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })
})

// --- parseRetryAfterValue ---
describe('parseRetryAfterValue', () => {
  test('parses integer seconds', async () => {
    const { parseRetryAfterValue } = await importFreshWithRetryModule()
    expect(parseRetryAfterValue('5')).toBe(5000)
  })

  test('parses decimal seconds', async () => {
    const { parseRetryAfterValue } = await importFreshWithRetryModule()
    expect(parseRetryAfterValue('0.5')).toBe(500)
  })

  test('parses zero as zero ms', async () => {
    const { parseRetryAfterValue } = await importFreshWithRetryModule()
    expect(parseRetryAfterValue('0')).toBe(0)
  })

  test('parses HTTP-date in the future as ms delta', async () => {
    const { parseRetryAfterValue } = await importFreshWithRetryModule()
    // ~30 seconds in the future; allow a small tolerance for test latency.
    const future = new Date(Date.now() + 30_000).toUTCString()
    const ms = parseRetryAfterValue(future)
    expect(ms).not.toBeNull()
    expect(ms!).toBeGreaterThan(28_000)
    expect(ms!).toBeLessThanOrEqual(30_000)
  })

  test('returns 0 for HTTP-date in the past (no negative waits)', async () => {
    const { parseRetryAfterValue } = await importFreshWithRetryModule()
    const past = new Date(Date.now() - 60_000).toUTCString()
    expect(parseRetryAfterValue(past)).toBe(0)
  })

  test('returns null for garbage input', async () => {
    const { parseRetryAfterValue } = await importFreshWithRetryModule()
    expect(parseRetryAfterValue('not-a-number')).toBeNull()
  })

  test('returns null for null/undefined/empty', async () => {
    const { parseRetryAfterValue } = await importFreshWithRetryModule()
    expect(parseRetryAfterValue(null)).toBeNull()
    expect(parseRetryAfterValue(undefined)).toBeNull()
    expect(parseRetryAfterValue('')).toBeNull()
    expect(parseRetryAfterValue('   ')).toBeNull()
  })

  test('does not produce negative waits for malformed negative input', async () => {
    const { parseRetryAfterValue } = await importFreshWithRetryModule()
    // "-5" fails the seconds regex; Date.parse may interpret it (year -5)
    // as a past instant. Either way, the contract is "never wait a negative
    // amount" — accept null OR 0, but never <0.
    const result = parseRetryAfterValue('-5')
    expect(result === null || result === 0).toBe(true)
  })

  test('caps absurd values at PERSISTENT_RESET_CAP_MS (6h)', async () => {
    const { parseRetryAfterValue } = await importFreshWithRetryModule()
    const SIX_HOURS = 6 * 60 * 60 * 1000
    // 99999999999 seconds → would be ~3170 years; must be clamped.
    expect(parseRetryAfterValue('99999999999')).toBe(SIX_HOURS)
  })
})

// --- getRetryAfterMs ---
describe('getRetryAfterMs', () => {
  test('reads retry-after-ms (millisecond extension)', async () => {
    const { getRetryAfterMs } = await importFreshWithRetryModule()
    const error = makeError({ 'retry-after-ms': '1500' })
    expect(getRetryAfterMs(error)).toBe(1500)
  })

  test('falls back to retry-after seconds when ms absent', async () => {
    const { getRetryAfterMs } = await importFreshWithRetryModule()
    const error = makeError({ 'retry-after': '5' })
    expect(getRetryAfterMs(error)).toBe(5000)
  })

  test('prefers retry-after-ms over retry-after when both present', async () => {
    const { getRetryAfterMs } = await importFreshWithRetryModule()
    const error = makeError({
      'retry-after-ms': '100',
      'retry-after': '1',
    })
    // ms wins because it's more precise.
    expect(getRetryAfterMs(error)).toBe(100)
  })

  test('parses retry-after as HTTP-date', async () => {
    const { getRetryAfterMs } = await importFreshWithRetryModule()
    const future = new Date(Date.now() + 10_000).toUTCString()
    const error = makeError({ 'retry-after': future })
    const ms = getRetryAfterMs(error)
    expect(ms).not.toBeNull()
    expect(ms!).toBeGreaterThan(8_000)
    expect(ms!).toBeLessThanOrEqual(10_000)
  })

  test('returns null when no retry headers present', async () => {
    const { getRetryAfterMs } = await importFreshWithRetryModule()
    const error = makeError({})
    expect(getRetryAfterMs(error)).toBeNull()
  })

  test('reads from plain object headers (not just Headers instance)', async () => {
    const { getRetryAfterMs } = await importFreshWithRetryModule()
    // Mimic SDK error shapes that expose headers as a plain record.
    const error = {
      headers: { 'retry-after-ms': '750' },
      status: 429,
      message: 'rate limit',
      name: 'APIError',
    } as unknown as APIError
    expect(getRetryAfterMs(error)).toBe(750)
  })

  test('returns null on invalid header value (falls through to backoff)', async () => {
    const { getRetryAfterMs } = await importFreshWithRetryModule()
    const error = makeError({ 'retry-after': 'garbage' })
    expect(getRetryAfterMs(error)).toBeNull()
  })
})

// --- getRetryDelay ---
describe('getRetryDelay', () => {
  test('honors retry-after ms directly', async () => {
    const { getRetryDelay } = await importFreshWithRetryModule()
    expect(getRetryDelay(1, 1500)).toBe(1500)
  })

  test('honors zero as zero (no backoff override)', async () => {
    const { getRetryDelay } = await importFreshWithRetryModule()
    expect(getRetryDelay(1, 0)).toBe(0)
  })

  test('falls back to backoff when retryAfterMs is null', async () => {
    const { getRetryDelay } = await importFreshWithRetryModule()
    // attempt 1 → BASE_DELAY_MS (500) + jitter ≤ 25%
    const delay = getRetryDelay(1, null)
    expect(delay).toBeGreaterThanOrEqual(500)
    expect(delay).toBeLessThanOrEqual(625)
  })

  test('falls back to backoff when retryAfterMs undefined', async () => {
    const { getRetryDelay } = await importFreshWithRetryModule()
    const delay = getRetryDelay(1)
    expect(delay).toBeGreaterThanOrEqual(500)
    expect(delay).toBeLessThanOrEqual(625)
  })
})

// --- shouldRetry (OpenAI-compat 404) ---
describe('shouldRetry', () => {
  function make404Error(message: string): APIError {
    return {
      headers: new Headers(),
      status: 404,
      message,
      name: 'APIError',
      error: {},
    } as unknown as APIError
  }

  test('retries 404 with openai_category marker (endpoint_not_found) at attempt 1', async () => {
    const { shouldRetry } = await importFreshWithRetryModule()
    const error = make404Error('Not found [openai_category=endpoint_not_found]')
    expect(shouldRetry(error, 1)).toBe(true)
  })

  test('retries 404 with openai_category marker at attempt 2', async () => {
    const { shouldRetry } = await importFreshWithRetryModule()
    const error = make404Error('Not found [openai_category=endpoint_not_found]')
    expect(shouldRetry(error, 2)).toBe(true)
  })

  test('stops retrying 404 with marker after MAX_OPENAI_COMPAT_404_RETRIES', async () => {
    const { shouldRetry } = await importFreshWithRetryModule()
    const error = make404Error('Not found [openai_category=endpoint_not_found]')
    expect(shouldRetry(error, 3)).toBe(false)
  })

  test('does not retry 404 with model_not_found category', async () => {
    const { shouldRetry } = await importFreshWithRetryModule()
    const error = make404Error('Model not found [openai_category=model_not_found]')
    expect(shouldRetry(error, 1)).toBe(false)
  })

  test('does not retry 404 without openai_category marker', async () => {
    const { shouldRetry } = await importFreshWithRetryModule()
    const error = make404Error('Not found')
    expect(shouldRetry(error, 1)).toBe(false)
  })
})
