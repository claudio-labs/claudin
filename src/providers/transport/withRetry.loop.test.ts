// Characterization of the withRetry generator body: what each error class does
// to the loop (retry, refresh the client, bail, fall back, adjust the request),
// pinned before the fallback triggers are widened.
//
// No mock.module: withRetry already takes getClient and operation, so every
// test drives it with a scripted operation that throws SDK-built errors. The
// active provider is pinned through its config source (the global config's
// provider profiles), never by mocking tryGetActiveProvider().
//
// Delays: every APIError carries `retry-after-ms: 0`, which getRetryDelay
// honours as a zero sleep. The only real backoffs are the ones a connection
// error or a plain Error cannot avoid (no headers): three of them, ~0.6 s each.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import type { SystemAPIErrorMessage } from 'src/shared/types/message.js'
import {
  getModelStrings as getModelStringsState,
  resetModelStringsForTestingOnly,
  setModelStrings,
} from 'src/platform/bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { clearOAuthTokenCache, isClaudeAISubscriber } from 'src/providers/auth/auth.js'
import { getModelStrings } from 'src/providers/model/modelStrings.js'
import { isNonCustomOpusModel } from 'src/providers/model/model.js'
import {
  clearFastModeCooldown,
  getFastModeRuntimeState,
  isFastModeCooldown,
  isFastModeEnabled,
} from 'src/providers/fastMode.js'
import { clearProviderRateLimit } from 'src/providers/rateLimitState.js'
import { _resetAdoptedBetaRejectionsForTesting } from 'src/providers/transport/adoptedBetas.js'
import { REPEATED_529_ERROR_MESSAGE } from 'src/providers/transport/errors.js'
import {
  CannotRetryError,
  FallbackTriggeredError,
  type RetryContext,
  withRetry,
} from 'src/providers/transport/withRetry.js'

// ---------------------------------------------------------------------------
// Process-global state this file touches, put back in afterAll.

const ENV_KEYS = [
  'FALLBACK_FOR_ALL_PRIMARY_MODELS',
  'IS_SANDBOX',
  'CLAUDIN_SIMPLE',
  'CLAUDIN_MAX_RETRIES',
  'CLAUDIN_DISABLE_FAST_MODE',
  'CLAUDE_CODE_REMOTE',
] as const
const savedEnv: Record<string, string | undefined> = {}
let savedProfiles: ReturnType<typeof getGlobalConfig>['providerProfiles']
let savedActiveProfileId: string | undefined
// The model strings are cached for the process by whichever provider is active
// the first time they are read (modelStrings.ts). Read here under the OpenAI
// profile, they turned `opus` into gpt-4o for every later file in CI's order
// (ModelPicker, opus55, haiku55), so they go back to what they were.
let savedModelStrings: ReturnType<typeof getModelStringsState>

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  savedModelStrings = getModelStringsState()
  const global = getGlobalConfig()
  savedProfiles = global.providerProfiles
  savedActiveProfileId = global.activeProviderProfileId
  // Bare mode: no OAuth tokens and no Anthropic account flow, so
  // isClaudeAISubscriber() is false and a 401 never reaches a real refresh.
  process.env.CLAUDIN_SIMPLE = '1'
  clearOAuthTokenCache()
})

beforeEach(() => {
  delete process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS
  delete process.env.IS_SANDBOX
  delete process.env.CLAUDIN_MAX_RETRIES
  delete process.env.CLAUDIN_DISABLE_FAST_MODE
  delete process.env.CLAUDE_CODE_REMOTE
  activate('openai')
})

afterEach(() => {
  clearProviderRateLimit()
  clearFastModeCooldown()
  _resetAdoptedBetaRejectionsForTesting()
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  clearOAuthTokenCache()
  saveGlobalConfig(c => ({
    ...c,
    providerProfiles: savedProfiles,
    activeProviderProfileId: savedActiveProfileId,
  }))
  invalidateActiveProviderCache()
  if (savedModelStrings === null) resetModelStringsForTestingOnly()
  else setModelStrings(savedModelStrings)
  clearProviderRateLimit()
  clearFastModeCooldown()
  _resetAdoptedBetaRejectionsForTesting()
})

const PROFILES = {
  openai: { provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'gpt-5' },
  anthropic: { provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-4-7' },
  bedrock: { provider: 'bedrock', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com', model: 'claude-opus-4-7' },
  vertex: { provider: 'vertex', baseUrl: 'https://us-east5-aiplatform.googleapis.com', model: 'claude-opus-4-7' },
} as const

function activate(kind: keyof typeof PROFILES): void {
  const p = PROFILES[kind]
  saveGlobalConfig(c => ({
    ...c,
    providerProfiles: [{ id: `p-retry-${kind}`, name: `Retry ${kind}`, ...p }],
    activeProviderProfileId: `p-retry-${kind}`,
  }))
  invalidateActiveProviderCache()
}

// ---------------------------------------------------------------------------
// Errors, built the way the SDK builds them.

const ZERO_DELAY = { 'retry-after-ms': '0' }

function apiError(
  status: number,
  message: string,
  headers: Record<string, string> = ZERO_DELAY,
): APIError {
  return APIError.generate(status, { message }, message, new Headers(headers))
}

/** The streaming shape: the body is the raw error envelope, no top-level message. */
function overloadedInBody(status: number): APIError {
  return APIError.generate(
    status,
    { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    undefined,
    new Headers(ZERO_DELAY),
  )
}

const overloaded = () => apiError(529, 'Overloaded')
const thinkingMismatch = () =>
  apiError(400, 'messages.1.content.0: thinking blocks cannot be modified')
const overflow = (input: number, max: number, limit: number) =>
  apiError(400, `input length and \`max_tokens\` exceed context limit: ${input} + ${max} > ${limit}`)

// ---------------------------------------------------------------------------
// The scripted operation and the drain.

type Call = { attempt: number; context: RetryContext; client: number }

function scripted(steps: unknown[]) {
  const calls: Call[] = []
  let clients = 0
  const getClient = async () => {
    clients += 1
    return { id: clients } as never
  }
  const operation = async (client: unknown, attempt: number, context: RetryContext) => {
    calls.push({ attempt, context: { ...context }, client: (client as { id: number }).id })
    const step = steps[calls.length - 1]
    if (step === undefined) return 'ok'
    throw step
  }
  return { getClient, operation, calls, clients: () => clients }
}

type Outcome = { yielded: SystemAPIErrorMessage[]; result?: string; error?: unknown }

async function drain(gen: AsyncGenerator<SystemAPIErrorMessage, string>): Promise<Outcome> {
  const yielded: SystemAPIErrorMessage[] = []
  try {
    for (;;) {
      const next = await gen.next()
      if (next.done) return { yielded, result: next.value }
      yielded.push(next.value)
    }
  } catch (error) {
    return { yielded, error }
  }
}

const THINKING_OFF = { type: 'disabled' } as const

type Opts = Partial<Parameters<typeof withRetry>[2]>

async function run(steps: unknown[], opts: Opts = {}) {
  const s = scripted(steps)
  const outcome = await drain(
    withRetry(s.getClient, s.operation, {
      model: 'gpt-5',
      thinkingConfig: THINKING_OFF,
      maxRetries: 3,
      ...opts,
    } as Parameters<typeof withRetry>[2]),
  )
  return { ...outcome, calls: s.calls, clients: s.clients() }
}

function originalOf(error: unknown): unknown {
  expect(error).toBeInstanceOf(CannotRetryError)
  return (error as CannotRetryError).originalError
}

// ---------------------------------------------------------------------------

describe('withRetry - success and plain retries', () => {
  test('a first-attempt success returns the value, with one client and nothing yielded', async () => {
    const r = await run([])
    expect(r.result).toBe('ok')
    expect(r.calls.map(c => c.attempt)).toEqual([1])
    expect(r.clients).toBe(1)
    expect(r.yielded).toEqual([])
  })

  test('a 5xx is retried, the retry notice is yielded, and the client is reused', async () => {
    const e = apiError(500, 'Internal server error')
    const r = await run([e])
    expect(r.result).toBe('ok')
    expect(r.calls.map(c => c.attempt)).toEqual([1, 2])
    expect(r.calls.map(c => c.client)).toEqual([1, 1])
    expect(r.yielded).toHaveLength(1)
    const notice = r.yielded[0]!
    expect(notice.type).toBe('system')
    expect(notice.subtype).toBe('api_error')
    expect(notice.error).toBe(e)
    expect(notice.retryAttempt).toBe(1)
    expect(notice.maxRetries).toBe(3)
    expect(notice.retryInMs).toBe(0)
  })

  test('one notice per retry, numbered by attempt', async () => {
    const r = await run([apiError(502, 'bad gateway'), apiError(503, 'unavailable'), apiError(504, 'timeout')])
    expect(r.result).toBe('ok')
    expect(r.yielded.map(m => m.retryAttempt)).toEqual([1, 2, 3])
    expect(r.yielded.map(m => (m.error as APIError).status)).toEqual([502, 503, 504])
  })

  test('a connection error is retried on backoff without a new client', async () => {
    const e = new APIConnectionError({ message: 'Connection error.' })
    const r = await run([e])
    expect(r.result).toBe('ok')
    expect(r.clients).toBe(1)
    expect(r.yielded).toHaveLength(1)
    // No retry-after on a connection error: the first backoff step.
    expect(r.yielded[0]!.retryInMs).toBeGreaterThanOrEqual(500)
    expect(r.yielded[0]!.retryInMs).toBeLessThanOrEqual(625)
  })

  test('a stale keep-alive socket (ECONNRESET) gets a fresh client', async () => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    const r = await run([new APIConnectionError({ message: 'Connection error.', cause })])
    expect(r.result).toBe('ok')
    expect(r.calls.map(c => c.client)).toEqual([1, 2])
  })

  test('maxRetries falls back to CLAUDIN_MAX_RETRIES when the option is absent', async () => {
    process.env.CLAUDIN_MAX_RETRIES = '1'
    const r = await run([apiError(500, 'a'), apiError(500, 'b'), apiError(500, 'c')], { maxRetries: undefined })
    expect(r.calls).toHaveLength(2)
    expect(r.yielded.map(m => m.maxRetries)).toEqual([1])
    expect(originalOf(r.error)).toBeInstanceOf(APIError)
  })
})

describe('withRetry - giving up', () => {
  test('retries run out: attempt > maxRetries throws CannotRetryError with the last error', async () => {
    const last = apiError(503, 'third')
    const r = await run([apiError(503, 'first'), apiError(503, 'second'), last], { maxRetries: 2 })
    expect(r.calls.map(c => c.attempt)).toEqual([1, 2, 3])
    expect(r.yielded).toHaveLength(2)
    expect(originalOf(r.error)).toBe(last)
    expect((r.error as CannotRetryError).retryContext.model).toBe('gpt-5')
    expect((r.error as CannotRetryError).message).toBe('503 third')
  })

  test('maxRetries 0: one attempt, no notice', async () => {
    const e = apiError(500, 'boom')
    const r = await run([e], { maxRetries: 0 })
    expect(r.calls).toHaveLength(1)
    expect(r.yielded).toEqual([])
    expect(originalOf(r.error)).toBe(e)
  })

  test('a non-retriable 400 ends the turn on the first attempt', async () => {
    const e = apiError(400, 'messages: invalid role "system"')
    const r = await run([e])
    expect(r.calls).toHaveLength(1)
    expect(r.yielded).toEqual([])
    expect(originalOf(r.error)).toBe(e)
  })

  test('a non-SDK error ends the turn on the first attempt', async () => {
    const e = new TypeError('cannot read properties of undefined')
    const r = await run([e])
    expect(r.calls).toHaveLength(1)
    expect(originalOf(r.error)).toBe(e)
    // CannotRetryError keeps the original stack.
    expect((r.error as Error).stack).toBe(e.stack)
  })

  test('x-should-retry: false on a 5xx is obeyed', async () => {
    const e = apiError(500, 'no', { ...ZERO_DELAY, 'x-should-retry': 'false' })
    const r = await run([e])
    expect(r.calls).toHaveLength(1)
    expect(originalOf(r.error)).toBe(e)
  })

  test('a rate limit with a distant reset is not retried', async () => {
    const e = apiError(429, 'rate limited', { 'retry-after': '7200' })
    const r = await run([e])
    expect(r.calls).toHaveLength(1)
    expect(originalOf(r.error)).toBe(e)
  })

  test('billing exhaustion ends the turn before any retry logic', async () => {
    const e = apiError(429, 'You exceeded your current quota')
    const r = await run([e])
    expect(r.calls).toHaveLength(1)
    expect(originalOf(r.error)).toBe(e)
  })

  test('an already-aborted signal throws before the first request', async () => {
    const controller = new AbortController()
    controller.abort()
    const r = await run([], { signal: controller.signal })
    expect(r.error).toBeInstanceOf(APIUserAbortError)
    expect(r.calls).toEqual([])
  })
})

describe('withRetry - auth errors refresh the client', () => {
  test('a 401 gets a fresh client and is retried', async () => {
    const r = await run([apiError(401, 'invalid x-api-key')])
    expect(r.result).toBe('ok')
    expect(r.calls.map(c => c.client)).toEqual([1, 2])
    expect(r.yielded).toHaveLength(1)
  })

  test('a 403 "OAuth token has been revoked" gets a fresh client and is retried', async () => {
    const r = await run([apiError(403, 'OAuth token has been revoked')])
    expect(r.result).toBe('ok')
    expect(r.calls.map(c => c.client)).toEqual([1, 2])
  })

  test('any other 403 is final', async () => {
    const e = apiError(403, 'permission denied')
    const r = await run([e])
    expect(r.calls).toHaveLength(1)
    expect(originalOf(r.error)).toBe(e)
  })

  test('on Bedrock a 403 refreshes the client and is retried although shouldRetry says no', async () => {
    activate('bedrock')
    const r = await run([apiError(403, 'The security token included in the request is invalid')])
    expect(r.result).toBe('ok')
    expect(r.calls.map(c => c.client)).toEqual([1, 2])
  })

  test('on Vertex a 401 refreshes the client and is retried', async () => {
    activate('vertex')
    const r = await run([apiError(401, 'unauthenticated')])
    expect(r.result).toBe('ok')
    expect(r.calls.map(c => c.client)).toEqual([1, 2])
  })

  test('on Vertex a google-auth-library credential Error is retried, with no notice', async () => {
    activate('vertex')
    const r = await run([new Error('Could not refresh access token: invalid_grant')])
    expect(r.result).toBe('ok')
    expect(r.calls.map(c => c.client)).toEqual([1, 2])
    // Only SDK errors are yielded as retry notices.
    expect(r.yielded).toEqual([])
  })

  test('the same google-auth Error off Vertex is final', async () => {
    const e = new Error('Could not refresh access token: invalid_grant')
    const r = await run([e])
    expect(r.calls).toHaveLength(1)
    expect(originalOf(r.error)).toBe(e)
  })
})

describe('withRetry - the 529 streak', () => {
  test('three consecutive 529s with a fallback configured throw FallbackTriggeredError', async () => {
    process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS = '1'
    const r = await run([overloaded(), overloaded(), overloaded()], {
      fallbackModel: 'gpt-5-mini',
      maxRetries: 10,
    })
    expect(r.calls).toHaveLength(3)
    // The first two are ordinary retries; the third throws before its notice.
    expect(r.yielded).toHaveLength(2)
    expect(r.error).toBeInstanceOf(FallbackTriggeredError)
    const err = r.error as FallbackTriggeredError
    expect(err.originalModel).toBe('gpt-5')
    expect(err.fallbackModel).toBe('gpt-5-mini')
    expect(err.message).toBe('Model fallback triggered: gpt-5 -> gpt-5-mini')
    expect(err.name).toBe('FallbackTriggeredError')
  })

  test('two 529s then success: no fallback', async () => {
    process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS = '1'
    const r = await run([overloaded(), overloaded()], { fallbackModel: 'gpt-5-mini', maxRetries: 10 })
    expect(r.result).toBe('ok')
    expect(r.calls).toHaveLength(3)
  })

  test('without a fallback the streak ends in REPEATED_529', async () => {
    process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS = '1'
    const r = await run([overloaded(), overloaded(), overloaded(), overloaded()], { maxRetries: 10 })
    expect(r.calls).toHaveLength(3)
    const original = originalOf(r.error) as Error
    expect(original).not.toBeInstanceOf(APIError)
    expect(original.message).toBe(REPEATED_529_ERROR_MESSAGE)
  })

  test('under IS_SANDBOX the streak without a fallback keeps retrying until maxRetries', async () => {
    process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS = '1'
    process.env.IS_SANDBOX = '1'
    const steps = [overloaded(), overloaded(), overloaded(), overloaded(), overloaded()]
    const r = await run(steps, { maxRetries: 4 })
    expect(r.calls).toHaveLength(5)
    expect(originalOf(r.error)).toBe(steps[4])
  })

  test('the overloaded_error body counts as a 529 even under another status', async () => {
    process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS = '1'
    const r = await run([overloadedInBody(500), overloadedInBody(500), overloadedInBody(500)], {
      fallbackModel: 'gpt-5-mini',
      maxRetries: 10,
    })
    expect(r.calls).toHaveLength(3)
    expect(r.error).toBeInstanceOf(FallbackTriggeredError)
  })

  test('the streak is not reset by a different error in between (current behavior)', async () => {
    // consecutive529Errors is never zeroed on a non-529 error, so "consecutive"
    // means "in this retry loop".
    process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS = '1'
    const r = await run([overloaded(), apiError(500, 'x'), overloaded(), overloaded()], {
      fallbackModel: 'gpt-5-mini',
      maxRetries: 10,
    })
    expect(r.calls).toHaveLength(4)
    expect(r.error).toBeInstanceOf(FallbackTriggeredError)
  })

  test('initialConsecutive529Errors pre-seeds the streak', async () => {
    process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS = '1'
    const r = await run([overloaded()], {
      fallbackModel: 'gpt-5-mini',
      initialConsecutive529Errors: 2,
      maxRetries: 10,
    })
    expect(r.calls).toHaveLength(1)
    expect(r.yielded).toEqual([])
    expect(r.error).toBeInstanceOf(FallbackTriggeredError)
  })

  test('a configured fallback counts the streak for any primary, without FALLBACK_FOR_ALL_PRIMARY_MODELS', async () => {
    const r = await run([overloaded(), overloaded(), overloaded()], { model: 'gpt-5', fallbackModel: 'gpt-5-mini', maxRetries: 4 })
    expect(r.calls).toHaveLength(3)
    expect(r.error).toBeInstanceOf(FallbackTriggeredError)
    expect((r.error as FallbackTriggeredError).reason).toBe('overloaded')
  })

  test('the gate without a fallback: a non-Opus primary retries all the way, no REPEATED_529', async () => {
    const steps = [overloaded(), overloaded(), overloaded(), overloaded(), overloaded()]
    const r = await run(steps, { model: 'gpt-5', maxRetries: 4 })
    expect(r.calls).toHaveLength(5)
    expect(r.yielded).toHaveLength(4)
    expect(originalOf(r.error)).toBe(steps[4])
  })

  test('the gate without a fallback: a non-custom Opus primary stops at REPEATED_529 for a non-subscriber', async () => {
    const opus = getModelStrings().opus47
    expect(isNonCustomOpusModel(opus)).toBe(true)
    const steps = [overloaded(), overloaded(), overloaded(), overloaded()]
    const r = await run(steps, { model: opus, maxRetries: 3 })
    if (isClaudeAISubscriber()) {
      // Only reachable when another suite has mock.module'd auth.js to a
      // subscriber: the gate stays shut and the loop just runs out.
      expect(r.calls).toHaveLength(4)
      expect(originalOf(r.error)).toBe(steps[3])
    } else {
      expect(r.calls).toHaveLength(3)
      expect((originalOf(r.error) as Error).message).toBe(REPEATED_529_ERROR_MESSAGE)
    }
  })

  test('server errors that outlast every retry fall back, naming the reason', async () => {
    const r = await run([apiError(503, 'a'), apiError(502, 'b'), apiError(500, 'c')], { fallbackModel: 'gpt-5-mini', maxRetries: 2 })
    expect(r.calls).toHaveLength(3)
    expect(r.yielded).toHaveLength(2)
    expect(r.error).toBeInstanceOf(FallbackTriggeredError)
    expect((r.error as FallbackTriggeredError).reason).toBe('server_error')
  })

  test('a 5xx the server says not to retry falls back at once', async () => {
    const r = await run([apiError(500, 'no', { ...ZERO_DELAY, 'x-should-retry': 'false' })], { fallbackModel: 'gpt-5-mini' })
    expect(r.calls).toHaveLength(1)
    expect((r.error as FallbackTriggeredError).reason).toBe('server_error')
  })

  test('a rate limit with a distant reset falls back instead of ending the turn', async () => {
    const r = await run([apiError(429, 'rate limited', { 'retry-after': '7200' })], { fallbackModel: 'gpt-5-mini' })
    expect(r.calls).toHaveLength(1)
    expect(r.error).toBeInstanceOf(FallbackTriggeredError)
    expect((r.error as FallbackTriggeredError).reason).toBe('rate_limited')
  })

  test('auth, bad requests and billing exhaustion never fall back', async () => {
    for (const e of [apiError(400, 'messages: invalid role "system"'), apiError(429, 'You exceeded your current quota')]) {
      const r = await run([e], { fallbackModel: 'gpt-5-mini' })
      expect(originalOf(r.error)).toBe(e)
    }
    const forbidden = apiError(403, 'forbidden')
    const r = await run([forbidden, forbidden, forbidden, forbidden], { fallbackModel: 'gpt-5-mini' })
    expect(r.error).not.toBeInstanceOf(FallbackTriggeredError)
  })

  test('a background query source bails on the first 529, fallback or not', async () => {
    process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS = '1'
    const e = overloaded()
    const r = await run([e], {
      querySource: 'generate_session_title',
      fallbackModel: 'gpt-5-mini',
      initialConsecutive529Errors: 2,
    })
    expect(r.calls).toHaveLength(1)
    expect(originalOf(r.error)).toBe(e)
  })

  test('a background query source still retries a non-529 error', async () => {
    const r = await run([apiError(500, 'x')], { querySource: 'generate_session_title' })
    expect(r.result).toBe('ok')
  })

  test.each(['repl_main_thread', 'sdk', 'compact', 'agent:custom', 'auto_mode'] as const)(
    'the foreground source %s retries a 529',
    async querySource => {
      const r = await run([overloaded()], { querySource })
      expect(r.result).toBe('ok')
      expect(r.calls).toHaveLength(2)
    },
  )
})

describe('withRetry - request adjustments that retry without a notice', () => {
  test('an adopted beta the API rejects is dropped and the request resent at once', async () => {
    const r = await run([apiError(400, "thinking.adaptive.display: Input should be 'summarized', 'omitted'")])
    expect(r.result).toBe('ok')
    expect(r.calls).toHaveLength(2)
    expect(r.yielded).toEqual([])
  })

  test('a thinking-block mismatch strips thinking from history once', async () => {
    const r = await run([thinkingMismatch()])
    expect(r.result).toBe('ok')
    expect(r.calls.map(c => c.context.stripThinkingFromHistory === true)).toEqual([false, true])
    expect(r.yielded).toEqual([])
  })

  test('a second mismatch after the strip falls through to an ordinary retry (current behavior)', async () => {
    const r = await run([thinkingMismatch(), thinkingMismatch()])
    expect(r.result).toBe('ok')
    expect(r.calls).toHaveLength(3)
    expect(r.yielded).toHaveLength(1)
    expect(r.calls[2]!.context.stripThinkingFromHistory).toBe(true)
  })

  test('a max_tokens context overflow lowers max_tokens to what fits', async () => {
    const r = await run([overflow(188059, 20000, 200000)])
    expect(r.result).toBe('ok')
    expect(r.calls[0]!.context.maxTokensOverride).toBeUndefined()
    // 200000 - 188059 - 1000 (safety buffer)
    expect(r.calls[1]!.context.maxTokensOverride).toBe(10941)
    expect(r.yielded).toEqual([])
  })

  test('the override leaves room for an enabled thinking budget', async () => {
    const r = await run([overflow(188059, 20000, 200000)], {
      thinkingConfig: { type: 'enabled', budgetTokens: 15000 },
    })
    expect(r.calls[1]!.context.maxTokensOverride).toBe(15001)
  })

  test('below the 3000-token floor the raw error is rethrown, not wrapped', async () => {
    const e = overflow(196500, 20000, 200000)
    const r = await run([e])
    expect(r.calls).toHaveLength(1)
    expect(r.error).toBe(e)
    expect(r.error).not.toBeInstanceOf(CannotRetryError)
  })

  test('exactly at the floor the override is applied', async () => {
    // 200000 - 196000 - 1000 = 3000
    const r = await run([overflow(196000, 20000, 200000)])
    expect(r.calls[1]!.context.maxTokensOverride).toBe(3000)
  })
})

describe('withRetry - fast mode', () => {
  beforeEach(() => {
    activate('anthropic')
  })

  test('the retry context carries fastMode only where fast mode exists', async () => {
    expect(isFastModeEnabled()).toBe(true)
    const r = await run([], { fastMode: true, model: 'claude-opus-4-7' })
    expect(r.calls[0]!.context.fastMode).toBe(true)

    activate('openai')
    const off = await run([], { fastMode: true })
    expect('fastMode' in off.calls[0]!.context).toBe(false)
  })

  test('a short retry-after on a 529 waits and keeps fast mode', async () => {
    const r = await run([overloaded()], { fastMode: true, model: 'claude-opus-4-7' })
    expect(r.result).toBe('ok')
    expect(r.calls.map(c => c.context.fastMode)).toEqual([true, true])
    expect(r.yielded).toEqual([])
    expect(isFastModeCooldown()).toBe(false)
  })

  test('a 429 with no retry-after enters the cooldown and drops to standard speed', async () => {
    const r = await run([apiError(429, 'rate limited', {})], { fastMode: true, model: 'claude-opus-4-7' })
    expect(r.result).toBe('ok')
    expect(r.calls.map(c => c.context.fastMode)).toEqual([true, false])
    expect(r.yielded).toEqual([])
    const state = getFastModeRuntimeState()
    expect(state.status).toBe('cooldown')
    if (state.status === 'cooldown') {
      expect(state.reason).toBe('rate_limit')
      // The 30-minute default hold.
      expect(state.resetAt - Date.now()).toBeGreaterThan(29 * 60 * 1000)
    }
  })

  test('a long retry-after on a 529 enters an overloaded cooldown of at least 10 minutes', async () => {
    const r = await run([apiError(529, 'Overloaded', { 'retry-after': '60' })], {
      fastMode: true,
      model: 'claude-opus-4-7',
    })
    expect(r.result).toBe('ok')
    const state = getFastModeRuntimeState()
    expect(state.status).toBe('cooldown')
    if (state.status === 'cooldown') {
      expect(state.reason).toBe('overloaded')
      expect(state.resetAt - Date.now()).toBeGreaterThan(9 * 60 * 1000)
      expect(state.resetAt - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000)
    }
  })

  test('an overage-disabled 429 turns fast mode off for the retry', async () => {
    // out_of_credits is the reason that does not persist anything to settings.
    const e = apiError(429, 'rate limited', {
      ...ZERO_DELAY,
      'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits',
    })
    const r = await run([e], { fastMode: true, model: 'claude-opus-4-7' })
    expect(r.result).toBe('ok')
    expect(r.calls.map(c => c.context.fastMode)).toEqual([true, false])
    expect(isFastModeCooldown()).toBe(false)
  })

  test('with fast mode off for the request, a 529 is an ordinary retry', async () => {
    const r = await run([overloaded()], { fastMode: false, model: 'claude-opus-4-7' })
    expect(r.result).toBe('ok')
    expect(r.yielded).toHaveLength(1)
    expect(isFastModeCooldown()).toBe(false)
  })
})
