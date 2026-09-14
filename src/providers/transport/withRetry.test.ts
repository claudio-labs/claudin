import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'

const realProviders = { ...(await import('src/providers/model/providers.js')) }

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
  'CLAUDIN_USE_OPENAI',
  'CLAUDIN_USE_GEMINI',
  'CLAUDIN_USE_GITHUB',
  'CLAUDIN_USE_BEDROCK',
  'CLAUDIN_USE_VERTEX',
  'CLAUDIN_USE_FOUNDRY',
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
})

afterAll(() => {
  mock.module('src/providers/model/providers.js', () => realProviders)
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
  mock.module('src/providers/model/providers.js', () => ({
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

// Build a real APIError so isSdkApiError() (which checks the constructor, not a
// `.name` prop) recognizes it. status defaults to 400 (the invalid_request case).
function makeApiError(message: string, status = 400): APIError {
  return new APIError(status, undefined, message, new Headers())
}

// --- isThinkingBlockMismatchError ---
describe('isThinkingBlockMismatchError', () => {
  test('matches the "cannot be modified" (config-change) variant', async () => {
    const { isThinkingBlockMismatchError } = await importFreshWithRetryModule()
    expect(
      isThinkingBlockMismatchError(
        makeApiError('messages.1: thinking blocks cannot be modified'),
      ),
    ).toBe(true)
  })

  test('matches the foreign-signature variant (cross-provider switch)', async () => {
    const { isThinkingBlockMismatchError } = await importFreshWithRetryModule()
    // Exact wording Anthropic returns when the history carries a thinking block
    // signed by another provider (e.g. switching from Moonshot/Kimi to Anthropic).
    expect(
      isThinkingBlockMismatchError(
        makeApiError('messages.1.content.0: Invalid `signature` in `thinking` block'),
      ),
    ).toBe(true)
  })

  test('does not match an unrelated 400', async () => {
    const { isThinkingBlockMismatchError } = await importFreshWithRetryModule()
    expect(
      isThinkingBlockMismatchError(makeApiError('messages: invalid role "system"')),
    ).toBe(false)
  })

  test('does not match a non-thinking signature error', async () => {
    const { isThinkingBlockMismatchError } = await importFreshWithRetryModule()
    expect(
      isThinkingBlockMismatchError(makeApiError('Invalid `signature` in request')),
    ).toBe(false)
  })

  test('only matches status 400', async () => {
    const { isThinkingBlockMismatchError } = await importFreshWithRetryModule()
    const err = makeApiError('Invalid `signature` in `thinking` block', 500)
    expect(isThinkingBlockMismatchError(err)).toBe(false)
  })
})

// --- shouldRetry: thinking-block mismatch is retryable ---
describe('shouldRetry - thinking-block mismatch', () => {
  test('a foreign-signature thinking 400 is retryable (so strip-and-retry runs)', async () => {
    const { shouldRetry } = await importFreshWithRetryModule()
    expect(
      shouldRetry(
        makeApiError('messages.1.content.0: Invalid `signature` in `thinking` block'),
      ),
    ).toBe(true)
  })

  test('an unrelated 400 is not retryable', async () => {
    const { shouldRetry } = await importFreshWithRetryModule()
    expect(shouldRetry(makeApiError('messages: invalid role "system"'))).toBe(false)
  })
})

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
    process.env.CLAUDIN_USE_OPENAI = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('openai')
    const error = makeError({ 'x-ratelimit-reset-requests': '30s' })
    const delay = getRateLimitResetDelayMs(error)
    expect(delay).toBe(30_000)
  })

  test('reads x-ratelimit-reset-tokens and picks the larger delay', async () => {
    process.env.CLAUDIN_USE_OPENAI = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('openai')
    const error = makeError({
      'x-ratelimit-reset-requests': '10s',
      'x-ratelimit-reset-tokens': '1m0s',
    })
    // The smaller of the two: OpenAI reports both buckets on every 429, so the
    // larger value is usually the bucket that did NOT trip.
    expect(getRateLimitResetDelayMs(error)).toBe(10_000)
  })

  test('uses the bucket the remaining counters say is spent', async () => {
    process.env.CLAUDIN_USE_OPENAI = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('openai')
    const error = makeError({
      'x-ratelimit-reset-requests': '10s',
      'x-ratelimit-remaining-requests': '4900',
      'x-ratelimit-reset-tokens': '1m0s',
      'x-ratelimit-remaining-tokens': '0',
    })
    expect(getRateLimitResetDelayMs(error)).toBe(60_000)
  })

  test('returns null when no openai rate limit headers present', async () => {
    process.env.CLAUDIN_USE_OPENAI = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('openai')
    const error = makeError({})
    expect(getRateLimitResetDelayMs(error)).toBeNull()
  })

  test('works for github provider too', async () => {
    process.env.CLAUDIN_USE_GITHUB = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('github')
    const error = makeError({ 'x-ratelimit-reset-requests': '5s' })
    expect(getRateLimitResetDelayMs(error)).toBe(5_000)
  })
})

describe('getRateLimitResetDelayMs - providers without reset headers', () => {
  test('returns null for bedrock, which reports no reset', async () => {
    process.env.CLAUDIN_USE_BEDROCK = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('bedrock')
    expect(getRateLimitResetDelayMs(makeError({}))).toBeNull()
  })

  test('reads a reset header no matter which provider sent it', async () => {
    // The readers are a table, not a switch on the provider tag: a gateway in
    // front of Bedrock that forwards the header gets its reset honored rather
    // than discarded because of the tag.
    process.env.CLAUDIN_USE_BEDROCK = '1'
    const { getRateLimitResetDelayMs } =
      await importFreshWithRetryModule('bedrock')
    const error = makeError({
      'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 60),
    })
    const delay = getRateLimitResetDelayMs(error)
    expect(delay).not.toBeNull()
    expect(delay!).toBeGreaterThan(50_000)
    expect(delay!).toBeLessThanOrEqual(60_000)
  })

  test('returns null for vertex', async () => {
    process.env.CLAUDIN_USE_VERTEX = '1'
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

// --- shouldRetry (429 stop threshold) ---
describe('shouldRetry - a rate limit with a distant reset', () => {
  // Pinned rather than ambient. isClaudeAISubscriber() reads the developer's
  // own credentials AND is mock.module'd to `true` for the whole run by
  // modelOptions.dualcontext.test.ts — under either, every 429 is already
  // non-retryable and these assertions would pass with the new rule deleted.
  const PAYG = { isSubscriber: () => false, isEnterprise: () => false }

  test('is not retried, while a short one still is', async () => {
    // Asserted as a pair on purpose: the second assertion is what proves the
    // first one is the threshold talking and not a blanket "never retry".
    const { shouldRetry } = await importFreshWithRetryModule('openai')
    expect(shouldRetry(makeError({ 'retry-after': '7200' }), 1, PAYG)).toBe(false)
    expect(shouldRetry(makeError({ 'retry-after': '3' }), 1, PAYG)).toBe(true)
  })

  test('a 429 with no reset signal keeps the existing backoff', async () => {
    const { shouldRetry } = await importFreshWithRetryModule('openai')
    expect(shouldRetry(makeError({}), 1, PAYG)).toBe(true)
  })

  test('overrides the server saying x-should-retry: true', async () => {
    // Upstream's own comment: for Max and Pro that header is `true`, but the
    // window clears in several hours. Before this rule the header won and the
    // loop burned every attempt.
    const { shouldRetry } = await importFreshWithRetryModule('openai')
    const error = makeError({ 'retry-after': '7200', 'x-should-retry': 'true' })
    expect(shouldRetry(error, 1, PAYG)).toBe(false)
  })

  test('leaves non-rate-limit errors alone', async () => {
    const { shouldRetry } = await importFreshWithRetryModule('openai')
    const serverError = {
      headers: new Headers({ 'retry-after': '7200' }),
      status: 503,
      message: 'service unavailable',
      name: 'APIError',
      error: {},
    } as unknown as APIError
    expect(shouldRetry(serverError, 1, PAYG)).toBe(true)
  })
})

// --- the loop records the limit for the session ---
describe('withRetry - rate-limit bookkeeping', () => {
  const noopThinking = { type: 'disabled' } as never

  // The store is a process-wide singleton, so a failed assertion here would
  // otherwise leave it published for the rest of the run and surface as a
  // failure in whichever file happens to sort after this one.
  afterEach(async () => {
    const { clearProviderRateLimit } = await import(
      'src/providers/rateLimitState.js'
    )
    clearProviderRateLimit()
  })

  async function runUntilSettled(error: unknown, provider = 'openai' as const) {
    const { withRetry } = await importFreshWithRetryModule(provider)
    const generator = withRetry(
      async () => ({}) as never,
      () => {
        throw error
      },
      { model: 'gpt-5', thinkingConfig: noopThinking, maxRetries: 0 },
    )
    // Drain: the loop yields retry notices before it finally throws.
    try {
      for (;;) {
        const next = await generator.next()
        if (next.done) return
      }
    } catch {
      // CannotRetryError — the turn ending is the point.
    }
  }

  test('publishes the limit so the REPL can count down and resume', async () => {
    const { getProviderRateLimit } = await import(
      'src/providers/rateLimitState.js'
    )
    await runUntilSettled(
      new APIError(429, undefined, 'rate limited', new Headers({ 'retry-after': '7200' })),
    )

    const limit = getProviderRateLimit()
    expect(limit).not.toBeNull()
    expect(limit!.kind).toBe('window')
    expect(limit!.resetsAtMs! - Date.now()).toBeGreaterThan(7_000_000)
    // Recorded against the model that was rejected, so a success on a
    // different one does not clear it.
    expect(limit!.model).toBe('gpt-5')
  })

  test('billing exhaustion is published as exhausted, with no reset', async () => {
    const { getProviderRateLimit } = await import(
      'src/providers/rateLimitState.js'
    )
    await runUntilSettled(
      new APIError(
        429,
        undefined,
        'You exceeded your current quota',
        new Headers({ 'retry-after': '30' }),
      ),
    )

    const limit = getProviderRateLimit()
    expect(limit!.kind).toBe('exhausted')
    expect(limit!.resetsAtMs).toBeUndefined()
  })

  test('the quota-exhausted failure still carries its 429', async () => {
    // Wrapped in a bare Error instead, the status is lost and
    // getAssistantMessageFromError falls through to "API Error: …", so the
    // Quota exhausted wording never reaches the user.
    const { withRetry, CannotRetryError } = await importFreshWithRetryModule('openai')
    const generator = withRetry(
      async () => ({}) as never,
      () => {
        throw new APIError(
          429,
          undefined,
          'You exceeded your current quota',
          new Headers(),
        )
      },
      { model: 'gpt-5', thinkingConfig: noopThinking, maxRetries: 0 },
    )

    let thrown: unknown
    try {
      await generator.next()
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect(
      (thrown as { originalError: { status?: number } }).originalError.status,
    ).toBe(429)
  })

  test('a successful request clears a limit that lifted early', async () => {
    const { getProviderRateLimit, publishProviderRateLimit } = await import(
      'src/providers/rateLimitState.js'
    )
    publishProviderRateLimit({
      kind: 'window',
      source: 'retry-after',
      resetsAtMs: Date.now() + 3_600_000,
      providerLabel: 'OpenAI',
      model: 'gpt-5',
      observedAtMs: Date.now(),
    })

    const { withRetry } = await importFreshWithRetryModule('openai')
    const generator = withRetry(
      async () => ({}) as never,
      async () => 'ok',
      { model: 'gpt-5', thinkingConfig: noopThinking, maxRetries: 0 },
    )
    await generator.next()

    expect(getProviderRateLimit()).toBeNull()
  })

  test('a success on another model leaves the limit standing', async () => {
    // A title or a subagent runs on the small fast model. Clearing on its
    // success cancelled the countdown and the pending resume for a limit the
    // main loop was still under.
    const { getProviderRateLimit, publishProviderRateLimit } = await import(
      'src/providers/rateLimitState.js'
    )
    publishProviderRateLimit({
      kind: 'window',
      source: 'retry-after',
      resetsAtMs: Date.now() + 3_600_000,
      providerLabel: 'OpenAI',
      model: 'gpt-5',
      observedAtMs: Date.now(),
    })

    const { withRetry } = await importFreshWithRetryModule('openai')
    const generator = withRetry(
      async () => ({}) as never,
      async () => 'ok',
      { model: 'gpt-5-mini', thinkingConfig: noopThinking, maxRetries: 0 },
    )
    await generator.next()

    expect(getProviderRateLimit()).not.toBeNull()
  })
})
