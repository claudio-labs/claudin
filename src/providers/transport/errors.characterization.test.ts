/**
 * Characterization of src/providers/transport/errors.ts — what it does TODAY.
 *
 * Written before the inherited-bugs round touches the OpenAI-category marker
 * branch of getAssistantMessageFromError. Every assertion here pins current
 * behaviour, including the parts a later commit means to change: the
 * `context_overflow` marker test below is expected to flip when the overflow
 * fix lands, and should be edited then, deliberately.
 *
 * No mock.module: the provider comes from a real profile in the in-memory
 * global config, the OAuth state from CLAUDE_CODE_OAUTH_TOKEN plus an empty
 * secure-storage override (so the developer's own keychain never decides a
 * branch), and SDK errors are built with the SDK's own constructors.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from '@anthropic-ai/sdk'

import {
  getIsInteractive,
  getModelStrings as getModelStringsState,
  resetModelStringsForTestingOnly,
  setIsInteractive,
  setModelStrings,
} from 'src/platform/bootstrap/state.js'
import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import { _setSecureStorageForTesting } from 'src/platform/secureStorage/index.js'
import { clearOAuthTokenCache } from 'src/providers/auth/auth.js'
import { getModelStrings } from 'src/providers/model/modelStrings.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { formatAPIError } from 'src/providers/transport/errorUtils.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  API_TIMEOUT_ERROR_MESSAGE,
  CCR_AUTH_ERROR_MESSAGE,
  CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
  INVALID_API_KEY_ERROR_MESSAGE,
  INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL,
  OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE,
  ORG_DISABLED_ERROR_MESSAGE_ENV_KEY,
  ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  REPEATED_529_ERROR_MESSAGE,
  TOKEN_REVOKED_ERROR_MESSAGE,
  categorizeRetryableAPIError,
  classifyAPIError,
  get3PModelFallbackSuggestion,
  getAssistantMessageFromError,
  getErrorMessageIfRefusal,
  getImageTooLargeErrorMessage,
  getOauthOrgNotAllowedErrorMessage,
  getPdfInvalidErrorMessage,
  getPdfPasswordProtectedErrorMessage,
  getPdfTooLargeErrorMessage,
  getPromptTooLongTokenGap,
  getRequestTooLargeErrorMessage,
  getTokenRevokedErrorMessage,
  isMediaSizeError,
  isPromptTooLongMessage,
  parsePromptTooLongTokenCounts,
  startsWithApiErrorPrefix,
} from 'src/providers/transport/errors.js'
import { ImageResizeError } from 'src/terminal/image/imageResizer.js'
import { ImageSizeError } from 'src/terminal/image/imageValidation.js'
import type { AssistantMessage, Message, UserMessage } from 'src/shared/types/message.js'
import type { SecureStorage } from 'src/platform/secureStorage/index.js'

// ── fixtures ────────────────────────────────────────────────────────────────

const ANTHROPIC_KEYED: ProviderProfile = {
  id: 'errchar-anthropic-key',
  name: 'Anthropic',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-5-5',
  apiKey: 'sk-ant-characterization',
}
const ANTHROPIC_OAUTH: ProviderProfile = {
  id: 'errchar-anthropic-oauth',
  name: 'Anthropic',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-5-5',
}
const OPENAI: ProviderProfile = {
  id: 'errchar-openai',
  name: 'Local Ollama',
  provider: 'openai',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen2.5-coder:7b',
  apiKey: 'ollama',
}
const VERTEX: ProviderProfile = {
  id: 'errchar-vertex',
  name: 'Vertex',
  provider: 'vertex',
  baseUrl: 'https://us-east5-aiplatform.googleapis.com',
  model: 'claude-opus-5-5',
}
const BEDROCK: ProviderProfile = {
  id: 'errchar-bedrock',
  name: 'Bedrock',
  provider: 'bedrock',
  baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
  model: 'llama-3',
}

const emptyStorage: SecureStorage = {
  name: 'errors-characterization-empty',
  read: () => null,
  readAsync: async () => null,
  update: () => ({ success: true }),
  delete: () => true,
}

const ENV_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_REMOTE',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_ENTRYPOINT',
] as const
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map(k => [k, process.env[k]]))
const savedInteractive = getIsInteractive()
const savedModelStrings = getModelStringsState()

function useProfile(profile: ProviderProfile): void {
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [profile],
    activeProviderProfileId: profile.id,
  }))
  invalidateActiveProviderCache()
  clearOAuthTokenCache()
}

/** An Anthropic profile with no key plus an inference OAuth token: a claude.ai subscriber. */
function useSubscriber(): void {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-characterization'
  useProfile(ANTHROPIC_OAUTH)
}

function nonInteractive(): void {
  setIsInteractive(false)
}

function apiError(status: number, message: string, headers: Record<string, string> = {}): APIError {
  return APIError.generate(status, undefined, message, new Headers(headers))
}

function textOf(message: AssistantMessage | undefined): string {
  const first = message?.message.content[0]
  if (!first || typeof first !== 'object' || !('text' in first)) return ''
  return typeof first.text === 'string' ? first.text : ''
}

function fromError(error: unknown, model = 'claude-opus-5-5'): AssistantMessage {
  return getAssistantMessageFromError(error, model)
}

beforeAll(() => {
  _setSecureStorageForTesting(emptyStorage)
})

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  setIsInteractive(true)
  useProfile(ANTHROPIC_KEYED)
})

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  setIsInteractive(savedInteractive)
  if (savedModelStrings === null) resetModelStringsForTestingOnly()
  else setModelStrings(savedModelStrings)
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
  clearOAuthTokenCache()
})

afterAll(() => {
  _setSecureStorageForTesting(null)
  clearOAuthTokenCache()
})

// ── constants and small predicates ──────────────────────────────────────────

describe('exported constants', () => {
  test('pin the user-facing strings other modules match on', () => {
    expect(API_ERROR_MESSAGE_PREFIX).toBe('API Error')
    expect(PROMPT_TOO_LONG_ERROR_MESSAGE).toBe('Prompt is too long')
    expect(API_TIMEOUT_ERROR_MESSAGE).toBe('Request timed out')
    expect(REPEATED_529_ERROR_MESSAGE).toBe('Repeated 529 Overloaded errors')
    expect(CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE).toBe('Credit balance is too low')
    expect(INVALID_API_KEY_ERROR_MESSAGE).toBe('Not logged in · Please run /login')
    expect(INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL).toBe('Invalid API key · Fix external API key')
    expect(TOKEN_REVOKED_ERROR_MESSAGE).toBe('OAuth token revoked · Please run /login')
    expect(CCR_AUTH_ERROR_MESSAGE).toBe(
      'Authentication error · This may be a temporary network issue, please try again',
    )
    expect(OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE).toBe(
      'Your account does not have access to Claudin. Please run /login.',
    )
  })
})

describe('startsWithApiErrorPrefix', () => {
  test.each([
    ['API Error: 500 boom', true],
    ['API Error', true],
    ['Please run /login · API Error: 401 nope', true],
    ['Failed to authenticate. API Error: 401', false],
    ['api error: lower case', false],
    ['', false],
  ])('%p → %p', (text, expected) => {
    expect(startsWithApiErrorPrefix(text)).toBe(expected)
  })
})

describe('isPromptTooLongMessage', () => {
  test('true for an API error message whose text starts with the PTL string', () => {
    const msg = fromError(new Error('prompt is too long: 10 tokens > 5 maximum'))
    expect(isPromptTooLongMessage(msg)).toBe(true)
  })

  test('false for a non-API-error message even with PTL text', () => {
    const msg = { ...fromError(new Error('prompt is too long')), isApiErrorMessage: false }
    expect(isPromptTooLongMessage(msg as AssistantMessage)).toBe(false)
  })

  test('false when content is a string rather than a block array', () => {
    const base = fromError(new Error('prompt is too long'))
    const msg = { ...base, message: { ...base.message, content: PROMPT_TOO_LONG_ERROR_MESSAGE } }
    expect(isPromptTooLongMessage(msg as unknown as AssistantMessage)).toBe(false)
  })

  test('false when the PTL string is present but not at the start', () => {
    const msg = fromError(new Error('something else entirely'))
    expect(textOf(msg)).toBe('API Error: something else entirely')
    expect(isPromptTooLongMessage(msg)).toBe(false)
  })
})

describe('parsePromptTooLongTokenCounts', () => {
  test.each([
    ['prompt is too long: 137500 tokens > 135000 maximum', 137500, 135000],
    ['Prompt is too long: 200001 tokens > 200000 maximum', 200001, 200000],
    ['400 {"type":"error","error":{"message":"prompt is too long: 9 token > 8"}}', 9, 8],
    ['prompt is too long', undefined, undefined],
    ['137500 tokens > 135000', undefined, undefined],
    ['maximum context length is 8192 tokens', undefined, undefined],
  ])('%p', (raw, actual, limit) => {
    expect(parsePromptTooLongTokenCounts(raw)).toEqual({
      actualTokens: actual,
      limitTokens: limit,
    })
  })
})

describe('getPromptTooLongTokenGap', () => {
  test('the gap a raw PTL error reports, end to end through getAssistantMessageFromError', () => {
    const msg = fromError(new Error('prompt is too long: 137500 tokens > 135000 maximum'))
    expect(getPromptTooLongTokenGap(msg)).toBe(2500)
  })

  test('undefined for a message that is not PTL', () => {
    const msg = fromError(new Error('boom'))
    expect(getPromptTooLongTokenGap(msg)).toBeUndefined()
  })

  test('undefined when a PTL message carries no errorDetails', () => {
    const msg = { ...fromError(new Error('prompt is too long')), errorDetails: undefined }
    expect(getPromptTooLongTokenGap(msg)).toBeUndefined()
  })

  test('undefined when errorDetails has no token counts', () => {
    const msg = fromError(new Error('Prompt is too long'))
    expect(msg.errorDetails).toBe('Prompt is too long')
    expect(getPromptTooLongTokenGap(msg)).toBeUndefined()
  })

  test('undefined when the reported count is not over the limit', () => {
    const msg = fromError(new Error('prompt is too long: 100 tokens > 100 maximum'))
    expect(getPromptTooLongTokenGap(msg)).toBeUndefined()
  })
})

describe('isMediaSizeError', () => {
  test.each([
    ['image exceeds 5 MB maximum: 5316852 bytes > 5242880 bytes', true],
    ['image exceeds the limit', false],
    ['image dimensions exceed max allowed size for many-image requests: 2000 pixels', true],
    ['image dimensions exceed 8000 pixels', false],
    ['A maximum of 100 PDF pages may be provided.', true],
    ['maximum of many PDF pages', false],
    ['prompt is too long', false],
  ])('%p → %p', (raw, expected) => {
    expect(isMediaSizeError(raw)).toBe(expected)
  })
})

// ── session-dependent message builders ──────────────────────────────────────

describe('message builders, interactive vs non-interactive', () => {
  test('interactive wording', () => {
    expect(getPdfTooLargeErrorMessage()).toBe(
      'PDF too large (max 100 pages, 20MB). Double press esc to go back and try again, or use pdftotext to convert to text first.',
    )
    expect(getPdfPasswordProtectedErrorMessage()).toBe(
      'PDF is password protected. Please double press esc to edit your message and try again.',
    )
    expect(getPdfInvalidErrorMessage()).toBe(
      'The PDF file was not valid. Double press esc to go back and try again with a different file.',
    )
    expect(getImageTooLargeErrorMessage()).toBe(
      'Image was too large. Double press esc to go back and try again with a smaller image.',
    )
    expect(getRequestTooLargeErrorMessage()).toBe(
      'Request too large (max 20MB). Double press esc to go back and try with a smaller file.',
    )
    expect(getTokenRevokedErrorMessage()).toBe(TOKEN_REVOKED_ERROR_MESSAGE)
    expect(getOauthOrgNotAllowedErrorMessage()).toBe(OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE)
  })

  test('non-interactive wording', () => {
    nonInteractive()
    expect(getPdfTooLargeErrorMessage()).toBe(
      'PDF too large (max 100 pages, 20MB). Try reading the file a different way (e.g., extract text with pdftotext).',
    )
    expect(getPdfPasswordProtectedErrorMessage()).toBe(
      'PDF is password protected. Try using a CLI tool to extract or convert the PDF.',
    )
    expect(getPdfInvalidErrorMessage()).toBe(
      'The PDF file was not valid. Try converting it to text first (e.g., pdftotext).',
    )
    expect(getImageTooLargeErrorMessage()).toBe(
      'Image was too large. Try resizing the image or using a different approach.',
    )
    expect(getRequestTooLargeErrorMessage()).toBe(
      'Request too large (max 20MB). Try with a smaller file.',
    )
    expect(getTokenRevokedErrorMessage()).toBe(
      'Your account does not have access to Claudin. Please login again or contact your administrator.',
    )
    expect(getOauthOrgNotAllowedErrorMessage()).toBe(
      'Your organization does not have access to Claudin. Please login again or contact your administrator.',
    )
  })
})

// ── getAssistantMessageFromError ────────────────────────────────────────────

describe('getAssistantMessageFromError — timeouts and pre-flight image errors', () => {
  test('an SDK timeout error becomes the bare timeout message', () => {
    const msg = fromError(new APIConnectionTimeoutError())
    expect(textOf(msg)).toBe(API_TIMEOUT_ERROR_MESSAGE)
    expect(msg.error).toBe('unknown')
    expect(msg.isApiErrorMessage).toBe(true)
  })

  test('a connection error whose message mentions timeout is treated as a timeout', () => {
    const msg = fromError(new APIConnectionError({ message: 'socket Timeout while connecting' }))
    expect(textOf(msg)).toBe(API_TIMEOUT_ERROR_MESSAGE)
  })

  test('ImageSizeError and ImageResizeError become the image-too-large message with no error tag', () => {
    const size = fromError(new ImageSizeError([{ index: 0, size: 6_000_000 }] as never, 5_242_880))
    const resize = fromError(new ImageResizeError('could not resize'))
    expect(textOf(size)).toBe(getImageTooLargeErrorMessage())
    expect(textOf(resize)).toBe(getImageTooLargeErrorMessage())
    expect(size.error).toBeUndefined()
    expect(resize.error).toBeUndefined()
  })
})

describe('getAssistantMessageFromError — 429', () => {
  test('the long-context entitlement 429 names --model in a non-interactive session', () => {
    nonInteractive()
    const msg = fromError(apiError(429, 'Extra usage is required for long context'))
    expect(textOf(msg)).toBe(
      'API Error: Extra usage is required for 1M context · enable extra usage at claude.ai/settings/usage, or use --model to switch to standard context',
    )
    expect(msg.error).toBe('rate_limit')
  })

  test('the long-context entitlement 429 names /model interactively', () => {
    const msg = fromError(apiError(429, 'Extra usage is required for long context'))
    expect(textOf(msg)).toContain('or /model to switch to standard context')
  })

  test('a subscriber 429 with the unified claim header gets the window-limit message', () => {
    useSubscriber()
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600 + 5 * 60
    const msg = fromError(
      apiError(429, 'rate limited', {
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-reset': String(resetsAt),
      }),
    )
    expect(msg.error).toBe('rate_limit')
    // The clock time in the middle depends on the machine's zone; the countdown does not.
    expect(textOf(msg)).toMatch(/^Anthropic · session limit reached · resets .+ \(in 3h [45]m\)$/)
  })

  test('a subscriber 429 with overage rejected for lack of credits says so', () => {
    useSubscriber()
    const resetsAt = Math.floor(Date.now() / 1000) + 3600
    const msg = fromError(
      apiError(429, 'rate limited', {
        'anthropic-ratelimit-unified-overage-status': 'rejected',
        'anthropic-ratelimit-unified-overage-reset': String(resetsAt),
        'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits',
      }),
    )
    expect(textOf(msg)).toMatch(/^Anthropic · out of extra usage/)
  })

  test('the unified claim headers are ignored for a non-subscriber', () => {
    const msg = fromError(
      apiError(429, 'rate limited', {
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      }),
    )
    expect(textOf(msg)).toMatch(/^[^·\n]+ · rate limit reached · /)
    expect(textOf(msg)).not.toContain('5h limit')
  })
})

describe('getAssistantMessageFromError — OpenAI-compatibility category markers', () => {
  // One row per category, as the marker branch maps it. A context_overflow is
  // the prompt-too-long message, so the compaction retry that keys on it
  // works for an OpenAI-compatible server too. The HTTP categories keep the
  // server's own words after the hint (here "raw text"): errorDetails is not
  // shown anywhere, so the line is the only place the user can read them.
  const rows: Array<[string, number, string, string | undefined]> = [
    [
      'connection_refused',
      503,
      'Could not connect to the local OpenAI-compatible provider. Ensure the local server is running, then use OPENAI_BASE_URL=http://127.0.0.1:11434/v1 for Ollama.',
      'unknown',
    ],
    [
      'localhost_resolution_failed',
      503,
      'Could not connect to the local OpenAI-compatible provider. Ensure the local server is running, then use OPENAI_BASE_URL=http://127.0.0.1:11434/v1 for Ollama.',
      'unknown',
    ],
    [
      'endpoint_not_found',
      404,
      'Provider endpoint was not found. Confirm OPENAI_BASE_URL targets an OpenAI-compatible /v1 endpoint (for Ollama: http://127.0.0.1:11434/v1). · raw text',
      'invalid_request',
    ],
    [
      'model_not_found',
      404,
      'The selected model (qwen2.5-coder:7b) is not available on this provider. Run /model to choose another model, or verify installed local models (for Ollama: ollama list). · raw text',
      'invalid_request',
    ],
    [
      'auth_invalid',
      401,
      'API Error: Authentication failed for your OpenAI-compatible provider. Verify OPENAI_API_KEY and endpoint-specific auth requirements. · raw text',
      'authentication_failed',
    ],
    [
      'request_timeout',
      504,
      'API Error: Provider request timed out. Local models may be loading or overloaded; retry shortly or increase API_TIMEOUT_MS.',
      'unknown',
    ],
    ['context_overflow', 400, 'Prompt is too long', 'invalid_request'],
    [
      'tool_call_incompatible',
      400,
      'The selected provider/model rejected tool-calling payloads. Try /model to pick a tool-capable model or continue without tools. · raw text',
      'invalid_request',
    ],
    [
      'malformed_provider_response',
      502,
      'API Error: Provider returned a malformed response. Confirm endpoint compatibility and check local proxy/network middleware.',
      'unknown',
    ],
    [
      'provider_unavailable',
      503,
      'API Error: Provider is temporarily unavailable. Retry in a moment. · raw text',
      'unknown',
    ],
  ]

  test.each(rows)('%s (interactive)', (category, status, expected, errorTag) => {
    useProfile(OPENAI)
    const msg = fromError(
      apiError(status, `OpenAI API error ${status}: raw text [openai_category=${category}]`),
      'qwen2.5-coder:7b',
    )
    expect(textOf(msg)).toBe(expected)
    expect(msg.error).toBe(errorTag as AssistantMessage['error'])
  })

  test('context_overflow is prompt-too-long, with the raw text as details for the token gap', () => {
    useProfile(OPENAI)
    const msg = fromError(
      apiError(
        400,
        'OpenAI API error 400: prompt is too long: 140000 tokens > 131072 maximum [openai_category=context_overflow]',
      ),
      'qwen2.5-coder:7b',
    )
    expect(textOf(msg)).toBe('Prompt is too long')
    expect(isPromptTooLongMessage(msg)).toBe(true)
    expect(msg.errorDetails).toContain('140000 tokens > 131072 maximum')
    expect(getPromptTooLongTokenGap(msg)).toBe(140000 - 131072)
  })

  test('model_not_found and tool_call_incompatible switch their hint headless; an overflow is prompt-too-long either way', () => {
    useProfile(OPENAI)
    nonInteractive()
    const overflow = fromError(apiError(400, 'x [openai_category=context_overflow]'), 'm')
    const missing = fromError(apiError(404, 'x [openai_category=model_not_found]'), 'm')
    const tools = fromError(apiError(400, 'x [openai_category=tool_call_incompatible]'), 'm')
    expect(textOf(overflow)).toBe('Prompt is too long')
    expect(textOf(missing)).toContain('Run --model to choose another model')
    expect(textOf(tools)).toContain('Try --model to pick a tool-capable model')
  })

  test('malformed_provider_response keeps the raw text, marker stripped, as errorDetails', () => {
    useProfile(OPENAI)
    const msg = fromError(
      apiError(502, 'OpenAI API error 502: unexpected token <  [openai_category=malformed_provider_response]  Hint: proxy'),
    )
    expect(msg.errorDetails).toBe('502 OpenAI API error 502: unexpected token < Hint: proxy')
  })

  test('rate_limited without a 429 gets the provider burst message', () => {
    useProfile(OPENAI)
    const msg = fromError(apiError(503, 'OpenAI API error 503: slow down [openai_category=rate_limited]'))
    expect(msg.error).toBe('rate_limit')
    expect(textOf(msg)).toMatch(/^Local Ollama · rate limit reached · /)
  })

  // A 403 the shim marked rate_limited is retried like a 429 and stops at the
  // same reset; saying "no reset time reported" when its Retry-After gave one
  // sent the user back before the window cleared.
  test('a rate_limited 403 with a Retry-After names the reset', () => {
    useProfile(OPENAI)
    const msg = fromError(
      apiError(403, 'OpenAI API error 403: slow down [openai_category=rate_limited]', {
        'retry-after': '28800',
      }),
    )
    expect(msg.error).toBe('rate_limit')
    expect(textOf(msg)).not.toContain('no reset time reported')
    expect(textOf(msg)).toMatch(/^Local Ollama · rate limit reached · /)
  })

  test.each(['network_error', 'unknown'])('%s echoes the raw message with the marker stripped', category => {
    useProfile(OPENAI)
    const msg = fromError(apiError(500, `OpenAI API error 500:  socket hang up [openai_category=${category}] tail`))
    expect(textOf(msg)).toBe('API Error: 500 OpenAI API error 500: socket hang up tail')
    expect(msg.error).toBe('unknown')
  })

  test('an unrecognised marker value is ignored and later branches decide', () => {
    useProfile(OPENAI)
    const msg = fromError(apiError(404, 'OpenAI API error 404: gone [openai_category=bogus_value]'), 'gpt-x')
    expect(textOf(msg)).toBe(
      "There's an issue with the selected model (gpt-x). It may not exist or you may not have access to it. Run /model to pick a different model.",
    )
  })

  test('a marker on a plain Error (not an SDK APIError) is not read', () => {
    const msg = fromError(new Error('boom [openai_category=context_overflow]'))
    expect(textOf(msg)).toBe('API Error: boom [openai_category=context_overflow]')
  })
})

describe('getAssistantMessageFromError — prompt too long and media', () => {
  test('a raw PTL error keeps the generic content and the raw text as errorDetails', () => {
    const raw = 'prompt is too long: 137500 tokens > 135000 maximum'
    const msg = fromError(apiError(400, raw))
    expect(textOf(msg)).toBe(PROMPT_TOO_LONG_ERROR_MESSAGE)
    expect(msg.error).toBe('invalid_request')
    expect(msg.errorDetails).toBe(`400 ${raw}`)
    expect(isPromptTooLongMessage(msg)).toBe(true)
  })

  test("Vertex's capitalised wording on a 413 is matched case-insensitively", () => {
    const msg = fromError(apiError(413, 'Prompt is too long'))
    expect(textOf(msg)).toBe(PROMPT_TOO_LONG_ERROR_MESSAGE)
  })

  test('PDF page limit', () => {
    const raw = 'A maximum of 100 PDF pages may be provided.'
    const msg = fromError(apiError(400, raw))
    expect(textOf(msg)).toBe(getPdfTooLargeErrorMessage())
    expect(msg.errorDetails).toBe(`400 ${raw}`)
    expect(isMediaSizeError(msg.errorDetails!)).toBe(true)
  })

  test('password-protected PDF', () => {
    const msg = fromError(new Error('The PDF specified is password protected'))
    expect(textOf(msg)).toBe(getPdfPasswordProtectedErrorMessage())
    expect(msg.error).toBe('invalid_request')
  })

  test('invalid PDF', () => {
    const msg = fromError(new Error('The PDF specified was not valid'))
    expect(textOf(msg)).toBe(getPdfInvalidErrorMessage())
  })

  test('image exceeds maximum on a 400', () => {
    const raw = 'image exceeds 5 MB maximum: 5316852 bytes > 5242880 bytes'
    const msg = fromError(apiError(400, raw))
    expect(textOf(msg)).toBe(getImageTooLargeErrorMessage())
    expect(msg.error).toBeUndefined()
    expect(isMediaSizeError(msg.errorDetails!)).toBe(true)
  })

  test('image exceeds maximum on a non-400 status is not the image branch', () => {
    const msg = fromError(apiError(422, 'image exceeds 5 MB maximum'))
    expect(textOf(msg)).toBe('API Error: 422 image exceeds 5 MB maximum')
  })

  test('many-image dimension limit, interactive and headless', () => {
    const raw = 'image dimensions exceed max allowed size for many-image requests: 2000 pixels'
    const interactive = fromError(apiError(400, raw))
    expect(textOf(interactive)).toBe(
      'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Run /compact to remove old images from context, or start a new session.',
    )
    expect(interactive.errorDetails).toBe(`400 ${raw}`)
    nonInteractive()
    expect(textOf(fromError(apiError(400, raw)))).toBe(
      'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.',
    )
  })

  test('the afk-mode beta rejection is inert under bun test (AFK_MODE_BETA_HEADER is empty)', () => {
    const raw = 'anthropic-beta: afk-mode-2026-01-31 is not enabled for this organization'
    const msg = fromError(apiError(400, raw))
    expect(textOf(msg)).toBe(`API Error: 400 ${raw}`)
  })

  test('a 413 without a more specific match is "request too large"', () => {
    const msg = fromError(apiError(413, 'Payload Too Large'))
    expect(textOf(msg)).toBe(getRequestTooLargeErrorMessage())
    expect(msg.error).toBe('invalid_request')
  })
})

describe('getAssistantMessageFromError — tool_use pairing errors', () => {
  const MISMATCH =
    'messages.3: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01Abc. Each `tool_use` block must have a corresponding `tool_result` block in the next message.'

  test('the concurrency message, interactive and headless', () => {
    expect(textOf(fromError(apiError(400, MISMATCH)))).toBe(
      'API Error: 400 due to tool use concurrency issues. Run /rewind to recover the conversation.',
    )
    nonInteractive()
    expect(textOf(fromError(apiError(400, MISMATCH)))).toBe(
      'API Error: 400 due to tool use concurrency issues.',
    )
  })

  test('with message context the mismatch logger walks both histories and the result is unchanged', () => {
    const block = (b: Record<string, unknown>) => b
    const messagesForAPI = [
      { type: 'assistant', message: { role: 'assistant', content: [block({ type: 'text', text: 'a' }), block({ type: 'tool_use', id: 'toolu_01Abc', name: 'Read', input: {} })] } },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            block({ type: 'tool_result', tool_use_id: 'toolu_01Abc', content: 'x' }),
            block({ type: 'text', text: 't' }),
            block({ type: 'thinking', thinking: 't' }),
            block({ type: 'image', source: {} }),
            block({ type: 'tool_use', id: 'toolu_02', name: 'Bash', input: {} }),
            block({ type: 'document', source: {} }),
          ],
        },
      },
      { type: 'user', message: { role: 'user', content: 'plain string' } },
      undefined,
    ] as unknown as (UserMessage | AssistantMessage)[]
    const messages = [
      { type: 'assistant', message: { role: 'assistant', content: 'no blocks' } },
      { type: 'assistant', message: { role: 'assistant', content: [block({ type: 'tool_use', id: 'toolu_01Abc', name: 'Read', input: {} })] } },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            block({ type: 'tool_result', tool_use_id: 'toolu_01Abc', content: 'x' }),
            block({ type: 'text', text: 't' }),
            block({ type: 'thinking', thinking: 't' }),
            block({ type: 'image', source: {} }),
            block({ type: 'tool_use', id: 'toolu_02', name: 'Bash', input: {} }),
            block({ type: 'document', source: {} }),
          ],
        },
      },
      { type: 'user', message: { role: 'user', content: 'plain string' } },
      { type: 'attachment', attachment: { type: 'todo' } },
      { type: 'system', subtype: 'informational' },
      { type: 'progress', progress: { type: 'bash_progress' } },
      { type: 'progress', progress: null },
      undefined,
    ] as unknown as Message[]

    const msg = getAssistantMessageFromError(apiError(400, MISMATCH), 'claude-opus-5-5', {
      messages,
      messagesForAPI,
    })
    expect(textOf(msg)).toBe(
      'API Error: 400 due to tool use concurrency issues. Run /rewind to recover the conversation.',
    )
  })

  test('the mismatch logger swallows a malformed history', () => {
    const msg = getAssistantMessageFromError(apiError(400, MISMATCH), 'claude-opus-5-5', {
      messages: [],
      messagesForAPI: [{}] as unknown as (UserMessage | AssistantMessage)[],
    })
    expect(msg.error).toBe('invalid_request')
  })

  test('without a toolu_ id in the text the logger is skipped', () => {
    const raw = '`tool_use` ids were found without `tool_result` blocks immediately after'
    const msg = getAssistantMessageFromError(apiError(400, raw), 'claude-opus-5-5', {
      messages: [],
      messagesForAPI: [],
    })
    expect(msg.error).toBe('invalid_request')
  })

  test('duplicate tool_use ids, interactive and headless', () => {
    const raw = 'messages.5.content.1: `tool_use` ids must be unique'
    const interactive = fromError(apiError(400, raw))
    expect(textOf(interactive)).toBe(
      'API Error: 400 duplicate tool_use ID in conversation history. Run /rewind to recover the conversation.',
    )
    expect(interactive.errorDetails).toBe(`400 ${raw}`)
    nonInteractive()
    expect(textOf(fromError(apiError(400, raw)))).toBe(
      'API Error: 400 duplicate tool_use ID in conversation history.',
    )
  })
})

describe('getAssistantMessageFromError — account and auth', () => {
  test('invalid model name for a subscriber on opus explains the Pro plan', () => {
    useSubscriber()
    const msg = fromError(apiError(400, 'invalid model name'), 'opus')
    expect(textOf(msg)).toBe(
      'Claude Opus is not available with the Claude Pro plan. If you have updated your subscription plan recently, run /logout and /login for the plan to take effect.',
    )
  })

  test('invalid model name for a non-subscriber is the generic line', () => {
    const msg = fromError(apiError(400, 'Invalid model name'), 'opus')
    expect(textOf(msg)).toBe('API Error: 400 Invalid model name')
  })

  test('credit balance too low', () => {
    const msg = fromError(new Error('Your credit balance is too low to access the API'))
    expect(textOf(msg)).toBe(CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE)
    expect(msg.error).toBe('billing_error')
  })

  test('organization disabled with an explicit key and no stored OAuth', () => {
    const msg = fromError(apiError(400, 'This organization has been disabled.'))
    expect(textOf(msg)).toBe(ORG_DISABLED_ERROR_MESSAGE_ENV_KEY)
    expect(msg.error).toBe('invalid_request')
  })

  test('organization disabled with an explicit key and an OAuth token on hand', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-characterization'
    clearOAuthTokenCache()
    const msg = fromError(apiError(400, 'This organization has been disabled.'))
    expect(textOf(msg)).toBe(ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH)
  })

  test('organization disabled without an explicit key falls through to the generic line', () => {
    useSubscriber()
    const msg = fromError(apiError(400, 'This organization has been disabled.'))
    expect(textOf(msg)).toBe('API Error: 400 This organization has been disabled.')
  })

  test('an x-api-key rejection with a profile key blames the external key', () => {
    const msg = fromError(new Error('invalid x-api-key'))
    expect(textOf(msg)).toBe(INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL)
    expect(msg.error).toBe('authentication_failed')
  })

  test('an x-api-key rejection with no key asks for /login', () => {
    useSubscriber()
    const msg = fromError(new Error('invalid x-api-key'))
    expect(textOf(msg)).toBe(INVALID_API_KEY_ERROR_MESSAGE)
  })

  test('an x-api-key rejection in CCR mode is the transient-auth message', () => {
    process.env.CLAUDE_CODE_REMOTE = '1'
    const msg = fromError(new Error('invalid x-api-key'))
    expect(textOf(msg)).toBe(CCR_AUTH_ERROR_MESSAGE)
  })

  test('an x-api-key text off first-party is not the key branch', () => {
    useProfile(OPENAI)
    const msg = fromError(new Error('invalid x-api-key'))
    expect(textOf(msg)).toBe('API Error: invalid x-api-key')
  })

  test('403 OAuth token revoked', () => {
    const msg = fromError(apiError(403, 'OAuth token has been revoked'))
    expect(textOf(msg)).toBe(TOKEN_REVOKED_ERROR_MESSAGE)
    expect(msg.error).toBe('authentication_failed')
  })

  test.each([401, 403])('%i OAuth organization not allowed', status => {
    const msg = fromError(
      apiError(status, 'OAuth authentication is currently not allowed for this organization'),
    )
    expect(textOf(msg)).toBe(OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE)
  })

  test('a generic 401 asks for /login interactively', () => {
    const msg = fromError(apiError(401, 'unauthorized'))
    expect(textOf(msg)).toBe('Please run /login · API Error: 401 unauthorized')
    expect(startsWithApiErrorPrefix(textOf(msg))).toBe(true)
  })

  test('a generic 403 headless says it failed to authenticate', () => {
    nonInteractive()
    const msg = fromError(apiError(403, 'forbidden'))
    expect(textOf(msg)).toBe('Failed to authenticate. API Error: 403 forbidden')
  })

  test('a generic 401 in CCR mode is the transient-auth message', () => {
    process.env.CLAUDE_CODE_REMOTE = 'true'
    const msg = fromError(apiError(401, 'unauthorized'))
    expect(textOf(msg)).toBe(CCR_AUTH_ERROR_MESSAGE)
  })
})

describe('getAssistantMessageFromError — model availability and overflow', () => {
  test('Bedrock "model ID" errors without a fallback suggestion', () => {
    useProfile(BEDROCK)
    const raw = "You don't have access to the model with the specified model ID."
    const msg = fromError(new Error(raw), 'llama-3')
    expect(textOf(msg)).toBe(`API Error (llama-3): ${raw}. Run /model to pick a different model.`)
    nonInteractive()
    expect(textOf(fromError(new Error(raw), 'llama-3'))).toContain('Run --model to pick')
  })

  test('a first-party 404 has no fallback suggestion', () => {
    const msg = fromError(apiError(404, 'not_found_error'), 'claude-x')
    expect(textOf(msg)).toBe(
      "There's an issue with the selected model (claude-x). It may not exist or you may not have access to it. Run /model to pick a different model.",
    )
  })

  test('a 3P 404 suggests the previous generation', () => {
    useProfile(VERTEX)
    const msg = fromError(apiError(404, 'not found'), 'claude-opus-5-5')
    expect(textOf(msg)).toBe(
      `The model claude-opus-5-5 is not available on your vertex deployment. Try /model to switch to ${getModelStrings().opus5}, or ask your admin to enable this model.`,
    )
    nonInteractive()
    expect(textOf(fromError(apiError(404, 'not found'), 'claude-opus-5-5'))).toContain(
      'Try --model to switch to',
    )
  })

  test.each([
    'too many tokens',
    'Request too large',
    'exceeds the context length',
    'maximum context reached',
    'input length exceeded',
    'Payload Too Large',
  ])('a 5xx mentioning %p is a context overflow', phrase => {
    const msg = fromError(apiError(500, phrase))
    expect(textOf(msg)).toBe(
      'The conversation has grown too large for the API to process. Press esc twice to go up a few messages, or run /compact to reduce context. Alternatively, start a new session with /new.',
    )
    expect(msg.errorDetails).toBe(`Context overflow (500): 500 ${phrase}`)
  })

  test('the 5xx overflow message drops the rewind hint headless', () => {
    nonInteractive()
    const msg = fromError(apiError(503, 'too many tokens'))
    expect(textOf(msg)).toBe(
      'The conversation has grown too large for the API to process. Alternatively, start a new session with /new.',
    )
  })

  test('a 400 mentioning context length is NOT the 5xx overflow branch', () => {
    const msg = fromError(apiError(400, 'maximum context length exceeded'))
    expect(textOf(msg)).toBe('API Error: 400 maximum context length exceeded')
  })
})

describe('getAssistantMessageFromError — fallbacks', () => {
  test('a non-timeout connection error is formatted through formatAPIError', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
      code: 'ECONNREFUSED',
    })
    const error = new APIConnectionError({ message: 'Connection error.', cause })
    const msg = fromError(error)
    expect(textOf(msg)).toBe(`API Error: ${formatAPIError(error)}`)
    expect(msg.error).toBe('unknown')
  })

  test('any other Error echoes its message', () => {
    expect(textOf(fromError(new Error('weird')))).toBe('API Error: weird')
  })

  test('a non-Error value is the bare prefix', () => {
    const msg = fromError('string thrown')
    expect(textOf(msg)).toBe('API Error')
    expect(msg.error).toBe('unknown')
  })
})

// ── get3PModelFallbackSuggestion ────────────────────────────────────────────

describe('get3PModelFallbackSuggestion', () => {
  test('first-party never suggests', () => {
    expect(get3PModelFallbackSuggestion('claude-opus-5-5')).toBeUndefined()
  })

  test('each family on a 3P provider falls back one step', () => {
    useProfile(VERTEX)
    const ms = getModelStrings()
    const cases: Array<[string, string | undefined]> = [
      ['claude-fable-5-2@20260101', ms.fable51],
      ['claude_fable_5_2', ms.fable51],
      ['claude-fable-5-1', ms.opus48],
      ['claude-opus-5-5', ms.opus5],
      ['Claude_Opus_5_5', ms.opus5],
      ['claude-opus-5', ms.opus48],
      ['claude-opus-4-7', ms.opus46],
      ['claude-opus-4-6', ms.opus41],
      ['claude-sonnet-5-5', ms.sonnet5],
      ['claude-sonnet-5', ms.sonnet46],
      ['claude-sonnet-4-6', ms.sonnet45],
      ['claude-sonnet-4-5', ms.sonnet40],
      ['claude-haiku-5-5', ms.haiku45],
      ['claude-haiku-4-5', undefined],
      ['gpt-5', undefined],
    ]
    for (const [model, expected] of cases) {
      expect([model, get3PModelFallbackSuggestion(model)]).toEqual([model, expected])
    }
  })
})

// ── classifyAPIError ────────────────────────────────────────────────────────

describe('classifyAPIError', () => {
  test.each<[string, () => unknown, string]>([
    ['aborted', () => new Error('Request was aborted.'), 'aborted'],
    ['SDK timeout', () => new APIConnectionTimeoutError(), 'api_timeout'],
    ['connection timeout text', () => new APIConnectionError({ message: 'timeout reached' }), 'api_timeout'],
    ['repeated 529', () => new Error(`${REPEATED_529_ERROR_MESSAGE} after 3 tries`), 'repeated_529'],
    ['429', () => apiError(429, 'slow down'), 'rate_limit'],
    ['529', () => apiError(529, 'overloaded'), 'server_overload'],
    ['overloaded_error body on a 500', () => apiError(500, '{"type":"overloaded_error"}'), 'server_overload'],
    ['prompt too long', () => new Error('Prompt is too long'), 'prompt_too_long'],
    ['pdf pages', () => new Error('maximum of 100 PDF pages'), 'pdf_too_large'],
    ['pdf password', () => new Error('The PDF specified is password protected'), 'pdf_password_protected'],
    ['image exceeds', () => apiError(400, 'image exceeds 5 MB maximum'), 'image_too_large'],
    ['many-image', () => apiError(400, 'image dimensions exceed many-image limit'), 'image_too_large'],
    [
      'tool_use mismatch',
      () => apiError(400, '`tool_use` ids were found without `tool_result` blocks immediately after'),
      'tool_use_mismatch',
    ],
    [
      'unexpected tool_result',
      () => apiError(400, 'unexpected `tool_use_id` found in `tool_result` blocks'),
      'unexpected_tool_result',
    ],
    ['duplicate ids', () => apiError(400, '`tool_use` ids must be unique'), 'duplicate_tool_use_id'],
    ['invalid model', () => apiError(400, 'Invalid model name'), 'invalid_model'],
    ['credit', () => new Error('Your credit balance is too low'), 'credit_balance_low'],
    ['x-api-key', () => new Error('invalid X-Api-Key'), 'invalid_api_key'],
    // Unlike getAssistantMessageFromError, the classifier does not know the
    // SDK 1.x no-credential wording (which no longer names X-Api-Key).
    [
      'SDK 1.x no-credential',
      () => new Error('Could not resolve authentication method. Expected one of apiKey, authToken'),
      'unknown',
    ],
    ['token revoked', () => apiError(403, 'OAuth token has been revoked'), 'token_revoked'],
    [
      'oauth org',
      () => apiError(401, 'OAuth authentication is currently not allowed for this organization'),
      'oauth_org_not_allowed',
    ],
    ['generic 401', () => apiError(401, 'nope'), 'auth_error'],
    ['generic 403', () => apiError(403, 'nope'), 'auth_error'],
    ['5xx', () => apiError(502, 'bad gateway'), 'server_error'],
    ['4xx', () => apiError(418, 'teapot'), 'client_error'],
    [
      'ssl connection',
      () =>
        new APIConnectionError({
          message: 'Connection error.',
          cause: Object.assign(new Error('cert'), { code: 'CERT_HAS_EXPIRED' }),
        }),
      'ssl_cert_error',
    ],
    ['plain connection', () => new APIConnectionError({ message: 'Connection error.' }), 'connection_error'],
    ['plain Error', () => new Error('whatever'), 'unknown'],
    ['non-Error', () => 42, 'unknown'],
  ])('%s', (_name, make, expected) => {
    expect(classifyAPIError(make())).toBe(expected)
  })

  test('bedrock model access only under a bedrock profile', () => {
    const err = new Error('The provided model ID is not supported')
    expect(classifyAPIError(err)).toBe('unknown')
    useProfile(BEDROCK)
    expect(classifyAPIError(err)).toBe('bedrock_model_access')
  })
})

// ── categorizeRetryableAPIError ─────────────────────────────────────────────

describe('categorizeRetryableAPIError', () => {
  test.each<[number, string, string]>([
    [529, 'overloaded', 'rate_limit'],
    [500, '{"type":"overloaded_error"}', 'rate_limit'],
    [429, 'slow down', 'rate_limit'],
    [401, 'nope', 'authentication_failed'],
    [403, 'nope', 'authentication_failed'],
    [408, 'timeout', 'server_error'],
    [409, 'conflict', 'server_error'],
    [413, 'too large', 'server_error'],
    [500, 'boom', 'server_error'],
    [400, 'bad', 'unknown'],
    [404, 'missing', 'unknown'],
  ])('%i %p → %p', (status, message, expected) => {
    expect(categorizeRetryableAPIError(apiError(status, message))).toBe(expected as never)
  })

  test('a status-less SDK error is unknown', () => {
    const err = new APIError(undefined, undefined, 'no status', undefined)
    expect(categorizeRetryableAPIError(err)).toBe('unknown')
  })
})

// ── getErrorMessageIfRefusal (cases the refusal suite does not reach) ──────

describe('getErrorMessageIfRefusal', () => {
  test('headless wording on a 3P provider names the provider policy', () => {
    useProfile(VERTEX)
    nonInteractive()
    const msg = getErrorMessageIfRefusal('refusal', 'claude-sonnet-4-20250514')
    expect(textOf(msg)).toBe(
      "API Error: Claudin is unable to respond to this request, which appears to violate our Usage Policy (your provider's acceptable use policy). Try rephrasing the request or attempting a different approach.",
    )
    expect(msg?.error).toBe('invalid_request')
  })

  test('first-party interactive wording links the AUP', () => {
    const msg = getErrorMessageIfRefusal('refusal', 'claude-sonnet-4-20250514')
    expect(textOf(msg)).toContain('(https://www.anthropic.com/legal/aup)')
    expect(textOf(msg)).toContain('Please double press esc to edit your last message')
  })
})
