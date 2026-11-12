export type OpenAICompatibilityFailureCategory =
  | 'connection_refused'
  | 'localhost_resolution_failed'
  | 'request_timeout'
  | 'network_error'
  | 'auth_invalid'
  | 'rate_limited'
  | 'model_not_found'
  | 'endpoint_not_found'
  | 'context_overflow'
  | 'tool_call_incompatible'
  | 'malformed_provider_response'
  | 'provider_unavailable'
  | 'unknown'

export type OpenAICompatibilityFailure = {
  source: 'network' | 'http'
  category: OpenAICompatibilityFailureCategory
  retryable: boolean
  message: string
  hint?: string
  code?: string
  status?: number
}

const OPENAI_CATEGORY_MARKER_PREFIX = '[openai_category='

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

const OPENAI_COMPATIBILITY_FAILURE_CATEGORIES: ReadonlySet<OpenAICompatibilityFailureCategory> =
  new Set<OpenAICompatibilityFailureCategory>([
    'connection_refused',
    'localhost_resolution_failed',
    'request_timeout',
    'network_error',
    'auth_invalid',
    'rate_limited',
    'model_not_found',
    'endpoint_not_found',
    'context_overflow',
    'tool_call_incompatible',
    'malformed_provider_response',
    'provider_unavailable',
    'unknown',
  ])

function isOpenAICompatibilityFailureCategory(
  value: string,
): value is OpenAICompatibilityFailureCategory {
  return OPENAI_COMPATIBILITY_FAILURE_CATEGORIES.has(
    value as OpenAICompatibilityFailureCategory,
  )
}

function getErrorCode(error: unknown): string | undefined {
  let current: unknown = error
  const maxDepth = 5

  for (let depth = 0; depth < maxDepth; depth++) {
    if (
      current &&
      typeof current === 'object' &&
      'code' in current &&
      typeof (current as { code?: unknown }).code === 'string'
    ) {
      return (current as { code: string }).code
    }

    if (
      current &&
      typeof current === 'object' &&
      'cause' in current &&
      (current as { cause?: unknown }).cause !== current
    ) {
      current = (current as { cause?: unknown }).cause
      continue
    }

    break
  }

  return undefined
}

function getHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function isLocalhostLikeHostname(hostname: string | null): boolean {
  if (!hostname) return false
  if (LOCALHOST_HOSTNAMES.has(hostname)) return true
  return /^127\./.test(hostname)
}

// How servers word a prompt over the context window: this classifier's
// original substrings, then the phrases opencode collected
// (packages/ai/src/provider-error.ts) for llama.cpp, vLLM, Bedrock,
// Cloudflare, TGI, LiteLLM, Z.ai and others.
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /too many tokens/i,
  /request too large/i,
  /request entity too large/i,
  /payload too large/i,
  /context length/i,
  /maximum context/i,
  /input length/i,
  /prompt is too long/i,
  /input is too long for (?:the )?(?:requested|selected) model/i,
  /too large for the model'?s configured input limit/i,
  /exceeded this model context window limit/i,
  /exceeds the context window/i,
  /input token count.*exceeds the maximum/i,
  /number of input tokens exceeds maximum length/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /exceeds (?:the )?maximum allowed input length/i,
  /is longer than the model'?s context length/i,
  // Only a token count: an image size, an image or a tool count share the wording.
  /exceeds the limit of [\d,]+ tokens/i,
  /exceeds the available context size/i,
  /`inputs` tokens \+ `max_new_tokens` must be <= \d+/i,
  /context window exceed/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /prompt (?:too long|exceeds max length|超长)/i,
  /but the configured context size is/i,
  /model_context_window_exceeded/i,
  /range of input length should be/i,
  /token limit exceeded/i,
  /request_too_large/i,
]

// A throttle or a usage quota that borrows overflow wording: compacting cannot
// fix it. Unanchored, since most bodies are a JSON envelope around the words.
const CONTEXT_OVERFLOW_EXCLUSIONS: readonly RegExp[] = [
  /(?:throttling error|service unavailable):/i,
  /rate limit/i,
  /too many requests/i,
  /max[_ ]tokens must be less than/i,
  /too many tokens(?: per day)?, please wait/i,
  /(?:hourly|daily|weekly|monthly) token limit/i,
]

function isContextOverflowMessage(body: string): boolean {
  return (
    !CONTEXT_OVERFLOW_EXCLUSIONS.some(pattern => pattern.test(body)) &&
    CONTEXT_OVERFLOW_PATTERNS.some(pattern => pattern.test(body))
  )
}

function isToolCompatibilityMessage(body: string): boolean {
  const lower = body.toLowerCase()
  return (
    lower.includes('tool_calls') ||
    lower.includes('tool_call') ||
    lower.includes('tool_use') ||
    lower.includes('tool_result') ||
    lower.includes('function calling') ||
    lower.includes('function call')
  )
}

function isMalformedProviderResponse(body: string): boolean {
  const lower = body.toLowerCase()
  return (
    lower.includes('<!doctype html') ||
    lower.includes('<html') ||
    lower.includes('invalid json') ||
    lower.includes('malformed') ||
    lower.includes('unexpected token') ||
    lower.includes('cannot parse') ||
    lower.includes('not valid json')
  )
}

// Codes and types servers put in a JSON error for a throttle, lowercased.
const RATE_LIMIT_ERROR_CODES: ReadonlySet<string> = new Set([
  'rate_limit_exceeded',
  'rate_limit_error',
  'rate_limited',
  'too_many_requests',
  'throttled',
  'throttlingexception',
])

/**
 * Whether a 403 is a throttle. Only a structured signal counts — Retry-After,
 * x-should-retry: true, or a rate-limit code or type in the JSON error —
 * because "rate limit" also turns up in the prose of a real refusal.
 */
function hasRateLimitSignal(body: string, headers: Headers | undefined): boolean {
  if (headers?.has('retry-after') || headers?.get('x-should-retry') === 'true') {
    return true
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object') return false
  const record = parsed as Record<string, unknown>
  const error =
    record.error && typeof record.error === 'object'
      ? (record.error as Record<string, unknown>)
      : record
  return [error.code, error.type].some(
    value =>
      typeof value === 'string' && RATE_LIMIT_ERROR_CODES.has(value.toLowerCase()),
  )
}

function isModelNotFoundMessage(body: string): boolean {
  const lower = body.toLowerCase()
  return (
    lower.includes('model') &&
    (
      lower.includes('not found') ||
      lower.includes('does not exist') ||
      lower.includes('unknown model') ||
      lower.includes('unavailable model')
    )
  )
}

export function formatOpenAICategoryMarker(
  category: OpenAICompatibilityFailureCategory,
): string {
  return `${OPENAI_CATEGORY_MARKER_PREFIX}${category}]`
}

export function extractOpenAICategoryMarker(
  message: string,
): OpenAICompatibilityFailureCategory | undefined {
  const match = message.match(/\[openai_category=([a-z_]+)]/)
  const category = match?.[1]

  if (!category || !isOpenAICompatibilityFailureCategory(category)) {
    return undefined
  }

  return category
}

export function buildOpenAICompatibilityErrorMessage(
  baseMessage: string,
  failure: Pick<OpenAICompatibilityFailure, 'category' | 'hint'>,
): string {
  const marker = formatOpenAICategoryMarker(failure.category)
  const hint = failure.hint ? ` Hint: ${failure.hint}` : ''
  return `${baseMessage} ${marker}${hint}`
}

export function classifyOpenAINetworkFailure(
  error: unknown,
  options: { url: string },
): OpenAICompatibilityFailure {
  const message = error instanceof Error ? error.message : String(error)
  const lowerMessage = message.toLowerCase()
  const code = getErrorCode(error)
  const hostname = getHostname(options.url)
  const isLocalHost = isLocalhostLikeHostname(hostname)

  if (
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('timed out') ||
    lowerMessage.includes('aborterror')
  ) {
    return {
      source: 'network',
      category: 'request_timeout',
      retryable: true,
      message,
      code,
      hint: 'The provider took too long to respond. Check local model load time or increase API timeout.',
    }
  }

  if (
    isLocalHost &&
    (
      code === 'ENOTFOUND' ||
      code === 'EAI_AGAIN' ||
      lowerMessage.includes('getaddrinfo') ||
      (code === undefined && lowerMessage.includes('fetch failed'))
    )
  ) {
    return {
      source: 'network',
      category: 'localhost_resolution_failed',
      retryable: true,
      message,
      code,
      hint: 'Localhost failed for this request. Retry with 127.0.0.1 and confirm Ollama is serving on the configured port.',
    }
  }

  if (code === 'ECONNREFUSED') {
    return {
      source: 'network',
      category: 'connection_refused',
      retryable: true,
      message,
      code,
      hint: isLocalHost
        ? 'Connection to the local provider was refused. Ensure the local server is running and listening on the configured port.'
        : 'Connection was refused by the provider endpoint. Ensure the server is running and the port is correct.',
    }
  }

  return {
    source: 'network',
    category: 'network_error',
    retryable: true,
    message,
    code,
    hint: 'Network transport failed before a provider response was received.',
  }
}

export function classifyOpenAIHttpFailure(options: {
  status: number
  body: string
  headers?: Headers
}): OpenAICompatibilityFailure {
  const body = options.body ?? ''

  if (
    options.status === 429 ||
    (options.status === 403 && hasRateLimitSignal(body, options.headers))
  ) {
    return {
      source: 'http',
      category: 'rate_limited',
      retryable: true,
      status: options.status,
      message: body,
      hint: 'Provider rate-limited the request. Retry after backoff.',
    }
  }

  if (options.status === 401 || options.status === 403) {
    return {
      source: 'http',
      category: 'auth_invalid',
      retryable: false,
      status: options.status,
      message: body,
      hint: 'Authentication failed. Verify API key, token source, and endpoint-specific auth headers.',
    }
  }

  if (options.status === 404 && isModelNotFoundMessage(body)) {
    return {
      source: 'http',
      category: 'model_not_found',
      retryable: false,
      status: options.status,
      message: body,
      hint: 'The selected model is not installed or not available on this endpoint.',
    }
  }

  if (options.status === 404) {
    return {
      source: 'http',
      category: 'endpoint_not_found',
      retryable: false,
      status: options.status,
      message: body,
      hint: 'Endpoint was not found. Confirm OPENAI_BASE_URL includes /v1 for OpenAI-compatible local providers.',
    }
  }

  if (
    options.status === 413 ||
    ((options.status === 400 || options.status >= 500) &&
      isContextOverflowMessage(body))
  ) {
    return {
      source: 'http',
      category: 'context_overflow',
      retryable: false,
      status: options.status,
      message: body,
      hint: 'Prompt context exceeded model/server limits. Reduce context or increase provider context length.',
    }
  }

  if (options.status === 400 && isToolCompatibilityMessage(body)) {
    return {
      source: 'http',
      category: 'tool_call_incompatible',
      retryable: false,
      status: options.status,
      message: body,
      hint: 'Provider/model rejected tool-calling payload. Retry without tools or use a tool-capable model.',
    }
  }

  if (options.status >= 400 && isMalformedProviderResponse(body)) {
    return {
      source: 'http',
      category: 'malformed_provider_response',
      retryable: false,
      status: options.status,
      message: body,
      hint: 'Provider returned malformed or non-JSON response where JSON was expected.',
    }
  }

  if (options.status >= 500) {
    return {
      source: 'http',
      category: 'provider_unavailable',
      retryable: true,
      status: options.status,
      message: body,
      hint: 'Provider reported a server-side failure. Retry after a short delay.',
    }
  }

  return {
    source: 'http',
    category: 'unknown',
    retryable: false,
    status: options.status,
    message: body,
  }
}
