// Characterization suite: pins what openaiErrorClassification.ts does TODAY,
// quirks included, before the overflow / 403 / retry fixes touch it. A test
// here that a later commit flips on purpose says so in its name.
import { describe, expect, test } from 'bun:test'

import {
  buildOpenAICompatibilityErrorMessage,
  classifyOpenAIHttpFailure,
  classifyOpenAINetworkFailure,
  extractOpenAICategoryMarker,
  formatOpenAICategoryMarker,
  type OpenAICompatibilityFailureCategory,
} from 'src/providers/shims/openaiErrorClassification.js'

const LOCAL_URL = 'http://localhost:11434/v1/chat/completions'
const REMOTE_URL = 'https://api.example.com/v1/chat/completions'

function withCode(message: string, code: unknown, cause?: unknown): Error {
  return Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) })
}

const ALL_CATEGORIES: OpenAICompatibilityFailureCategory[] = [
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
]

describe('category marker', () => {
  test('formats as [openai_category=<category>]', () => {
    expect(formatOpenAICategoryMarker('context_overflow')).toBe(
      '[openai_category=context_overflow]',
    )
  })

  test('round-trips every category through format and extract', () => {
    for (const category of ALL_CATEGORIES) {
      expect(
        extractOpenAICategoryMarker(`boom ${formatOpenAICategoryMarker(category)} tail`),
      ).toBe(category)
    }
  })

  test('returns undefined when no marker is present', () => {
    expect(extractOpenAICategoryMarker('plain error')).toBeUndefined()
  })

  test('returns undefined for a well-formed marker with an unknown category', () => {
    expect(extractOpenAICategoryMarker('[openai_category=made_up]')).toBeUndefined()
  })

  test('does not match an uppercase category', () => {
    expect(extractOpenAICategoryMarker('[openai_category=AUTH_INVALID]')).toBeUndefined()
  })

  test('takes the first marker when several are present', () => {
    expect(
      extractOpenAICategoryMarker(
        '[openai_category=rate_limited] then [openai_category=auth_invalid]',
      ),
    ).toBe('rate_limited')
  })

  test('buildOpenAICompatibilityErrorMessage appends marker and hint', () => {
    expect(
      buildOpenAICompatibilityErrorMessage('Request failed', {
        category: 'rate_limited',
        hint: 'Back off.',
      }),
    ).toBe('Request failed [openai_category=rate_limited] Hint: Back off.')
  })

  test('buildOpenAICompatibilityErrorMessage omits an empty hint', () => {
    expect(
      buildOpenAICompatibilityErrorMessage('Request failed', {
        category: 'unknown',
        hint: '',
      }),
    ).toBe('Request failed [openai_category=unknown]')
  })
})

describe('classifyOpenAINetworkFailure', () => {
  describe('request_timeout', () => {
    test('ETIMEDOUT code', () => {
      const failure = classifyOpenAINetworkFailure(withCode('connect', 'ETIMEDOUT'), {
        url: REMOTE_URL,
      })
      expect(failure).toEqual({
        source: 'network',
        category: 'request_timeout',
        retryable: true,
        message: 'connect',
        code: 'ETIMEDOUT',
        hint: 'The provider took too long to respond. Check local model load time or increase API timeout.',
      })
    })

    test('UND_ERR_CONNECT_TIMEOUT code', () => {
      const failure = classifyOpenAINetworkFailure(
        withCode('fetch failed', 'UND_ERR_CONNECT_TIMEOUT'),
        { url: REMOTE_URL },
      )
      expect(failure.category).toBe('request_timeout')
    })

    test.each([
      ['Request Timeout'],
      ['The operation timed out'],
      ['AbortError: aborted'],
    ])('message %p', message => {
      const failure = classifyOpenAINetworkFailure(new Error(message), { url: REMOTE_URL })
      expect(failure.category).toBe('request_timeout')
      expect(failure.code).toBeUndefined()
    })

    test('an AbortError whose message lacks the word is NOT a timeout', () => {
      const error = new Error('This operation was aborted')
      error.name = 'AbortError'
      const failure = classifyOpenAINetworkFailure(error, { url: REMOTE_URL })
      expect(failure.category).toBe('network_error')
    })

    test('timeout wins over ECONNREFUSED and over localhost resolution', () => {
      expect(
        classifyOpenAINetworkFailure(withCode('timeout', 'ECONNREFUSED'), { url: LOCAL_URL })
          .category,
      ).toBe('request_timeout')
      expect(
        classifyOpenAINetworkFailure(withCode('getaddrinfo timed out', 'ENOTFOUND'), {
          url: LOCAL_URL,
        }).category,
      ).toBe('request_timeout')
    })

    test('ETIMEDOUT found on the cause chain', () => {
      const error = new TypeError('fetch failed', {
        cause: withCode('connect', 'ETIMEDOUT'),
      })
      const failure = classifyOpenAINetworkFailure(error, { url: REMOTE_URL })
      expect(failure.category).toBe('request_timeout')
      expect(failure.code).toBe('ETIMEDOUT')
    })
  })

  describe('localhost_resolution_failed', () => {
    test.each([
      ['http://localhost:11434/v1'],
      ['http://LOCALHOST:11434/v1'],
      ['http://127.0.0.1:1234/v1'],
      ['http://127.4.5.6:1234/v1'],
    ])('ENOTFOUND on %p', url => {
      const failure = classifyOpenAINetworkFailure(withCode('x', 'ENOTFOUND'), { url })
      expect(failure).toEqual({
        source: 'network',
        category: 'localhost_resolution_failed',
        retryable: true,
        message: 'x',
        code: 'ENOTFOUND',
        hint: 'Localhost failed for this request. Retry with 127.0.0.1 and confirm Ollama is serving on the configured port.',
      })
    })

    test('EAI_AGAIN on localhost', () => {
      expect(
        classifyOpenAINetworkFailure(withCode('x', 'EAI_AGAIN'), { url: LOCAL_URL }).category,
      ).toBe('localhost_resolution_failed')
    })

    test('getaddrinfo in the message with no code', () => {
      expect(
        classifyOpenAINetworkFailure(new Error('getaddrinfo failed'), { url: LOCAL_URL })
          .category,
      ).toBe('localhost_resolution_failed')
    })

    test('a codeless "fetch failed" on localhost is treated as resolution failure', () => {
      expect(
        classifyOpenAINetworkFailure(new TypeError('fetch failed'), { url: LOCAL_URL })
          .category,
      ).toBe('localhost_resolution_failed')
    })

    test('"fetch failed" with a code is not resolution failure', () => {
      expect(
        classifyOpenAINetworkFailure(withCode('fetch failed', 'ECONNRESET'), {
          url: LOCAL_URL,
        }).category,
      ).toBe('network_error')
    })

    test('[::1] is NOT treated as localhost (URL.hostname keeps the brackets)', () => {
      const failure = classifyOpenAINetworkFailure(withCode('x', 'ENOTFOUND'), {
        url: 'http://[::1]:11434/v1',
      })
      expect(failure.category).toBe('network_error')
    })

    test('ENOTFOUND on a remote host is a generic network_error', () => {
      expect(
        classifyOpenAINetworkFailure(withCode('x', 'ENOTFOUND'), { url: REMOTE_URL })
          .category,
      ).toBe('network_error')
    })

    test('an unparseable url is never localhost', () => {
      expect(
        classifyOpenAINetworkFailure(new TypeError('fetch failed'), { url: 'not a url' })
          .category,
      ).toBe('network_error')
    })
  })

  describe('connection_refused', () => {
    test('remote ECONNREFUSED carries the remote hint', () => {
      const failure = classifyOpenAINetworkFailure(withCode('refused', 'ECONNREFUSED'), {
        url: REMOTE_URL,
      })
      expect(failure).toEqual({
        source: 'network',
        category: 'connection_refused',
        retryable: true,
        message: 'refused',
        code: 'ECONNREFUSED',
        hint: 'Connection was refused by the provider endpoint. Ensure the server is running and the port is correct.',
      })
    })

    test('localhost ECONNREFUSED carries the local hint', () => {
      const failure = classifyOpenAINetworkFailure(withCode('refused', 'ECONNREFUSED'), {
        url: 'http://127.0.0.1:8080/v1',
      })
      expect(failure.hint).toBe(
        'Connection to the local provider was refused. Ensure the local server is running and listening on the configured port.',
      )
    })

    test('ECONNREFUSED on the cause of a localhost "fetch failed"', () => {
      const error = new TypeError('fetch failed', {
        cause: withCode('connect ECONNREFUSED', 'ECONNREFUSED'),
      })
      expect(classifyOpenAINetworkFailure(error, { url: LOCAL_URL }).category).toBe(
        'connection_refused',
      )
    })
  })

  describe('error code lookup (getErrorCode)', () => {
    test('walks up to five levels of cause', () => {
      const deep = withCode('leaf', 'ECONNREFUSED')
      let error: unknown = deep
      for (let i = 0; i < 4; i++) error = new Error(`level ${i}`, { cause: error })
      // 4 wrappers + leaf = depth 5 → found
      expect(classifyOpenAINetworkFailure(error, { url: REMOTE_URL }).code).toBe(
        'ECONNREFUSED',
      )
    })

    test('stops after five levels', () => {
      let error: unknown = withCode('leaf', 'ECONNREFUSED')
      for (let i = 0; i < 5; i++) error = new Error(`level ${i}`, { cause: error })
      const failure = classifyOpenAINetworkFailure(error, { url: REMOTE_URL })
      expect(failure.code).toBeUndefined()
      expect(failure.category).toBe('network_error')
    })

    test('skips a non-string code and keeps walking to the cause', () => {
      const error = withCode('outer', 42, withCode('inner', 'ECONNREFUSED'))
      expect(classifyOpenAINetworkFailure(error, { url: REMOTE_URL }).code).toBe(
        'ECONNREFUSED',
      )
    })

    test('a self-referencing cause terminates', () => {
      const error = new Error('loop') as Error & { cause?: unknown }
      error.cause = error
      const failure = classifyOpenAINetworkFailure(error, { url: REMOTE_URL })
      expect(failure.code).toBeUndefined()
      expect(failure.category).toBe('network_error')
    })

    test('a cycle of two keeps bouncing until the depth cap', () => {
      const a = new Error('a') as Error & { cause?: unknown }
      const b = new Error('b', { cause: a })
      a.cause = b
      expect(classifyOpenAINetworkFailure(a, { url: REMOTE_URL }).code).toBeUndefined()
    })

    test('a null cause stops the walk', () => {
      const error = new Error('x', { cause: null })
      expect(classifyOpenAINetworkFailure(error, { url: REMOTE_URL }).code).toBeUndefined()
    })
  })

  describe('network_error fallback', () => {
    test('full shape', () => {
      expect(
        classifyOpenAINetworkFailure(withCode('socket hang up', 'ECONNRESET'), {
          url: REMOTE_URL,
        }),
      ).toEqual({
        source: 'network',
        category: 'network_error',
        retryable: true,
        message: 'socket hang up',
        code: 'ECONNRESET',
        hint: 'Network transport failed before a provider response was received.',
      })
    })

    test('a non-Error value is stringified', () => {
      const failure = classifyOpenAINetworkFailure('raw string failure', { url: REMOTE_URL })
      expect(failure.message).toBe('raw string failure')
      expect(failure.code).toBeUndefined()
      expect(failure.category).toBe('network_error')
    })

    test('a plain object with a string code is read, message is [object Object]', () => {
      const failure = classifyOpenAINetworkFailure(
        { code: 'ECONNREFUSED' },
        { url: REMOTE_URL },
      )
      expect(failure.category).toBe('connection_refused')
      expect(failure.message).toBe('[object Object]')
    })

    test('null and undefined do not throw', () => {
      expect(classifyOpenAINetworkFailure(null, { url: REMOTE_URL }).message).toBe('null')
      expect(classifyOpenAINetworkFailure(undefined, { url: REMOTE_URL }).message).toBe(
        'undefined',
      )
    })
  })
})

describe('classifyOpenAIHttpFailure', () => {
  const AUTH_HINT =
    'Authentication failed. Verify API key, token source, and endpoint-specific auth headers.'

  describe('401 / 403 → auth_invalid', () => {
    test.each([401, 403])('%p full shape', status => {
      expect(classifyOpenAIHttpFailure({ status, body: 'nope' })).toEqual({
        source: 'http',
        category: 'auth_invalid',
        retryable: false,
        status,
        message: 'nope',
        hint: AUTH_HINT,
      })
    })

    // Prose is not a signal: "rate limit" also shows up in auth refusals.
    test.each([['rate limit exceeded'], ['Too Many Requests'], ['throttled']])(
      '403 whose body only says %p in prose stays auth_invalid',
      body => {
        const failure = classifyOpenAIHttpFailure({ status: 403, body })
        expect(failure.category).toBe('auth_invalid')
        expect(failure.retryable).toBe(false)
      },
    )

    test.each([
      ['{"error":{"code":"rate_limit_exceeded","message":"slow down"}}'],
      ['{"error":{"type":"rate_limit_error"}}'],
      ['{"error":{"code":"too_many_requests"}}'],
      ['{"code":"throttled"}'],
    ])('403 with a structured rate-limit code %p is rate_limited', body => {
      const failure = classifyOpenAIHttpFailure({ status: 403, body })
      expect(failure.category).toBe('rate_limited')
      expect(failure.retryable).toBe(true)
    })

    test('403 with Retry-After is rate_limited', () => {
      expect(
        classifyOpenAIHttpFailure({
          status: 403,
          body: 'Forbidden',
          headers: new Headers({ 'retry-after': '2' }),
        }).category,
      ).toBe('rate_limited')
    })

    test('401 with a rate-limit code stays auth_invalid', () => {
      expect(
        classifyOpenAIHttpFailure({
          status: 401,
          body: '{"error":{"code":"rate_limit_exceeded"}}',
          headers: new Headers({ 'retry-after': '2' }),
        }).category,
      ).toBe('auth_invalid')
    })

    test('401 with a context-overflow body is still auth_invalid', () => {
      expect(
        classifyOpenAIHttpFailure({ status: 401, body: 'maximum context length' }).category,
      ).toBe('auth_invalid')
    })

    test('403 with an HTML body is auth_invalid, not malformed', () => {
      expect(
        classifyOpenAIHttpFailure({ status: 403, body: '<html>Forbidden</html>' }).category,
      ).toBe('auth_invalid')
    })
  })

  describe('429 → rate_limited', () => {
    test('full shape', () => {
      expect(classifyOpenAIHttpFailure({ status: 429, body: 'slow' })).toEqual({
        source: 'http',
        category: 'rate_limited',
        retryable: true,
        status: 429,
        message: 'slow',
        hint: 'Provider rate-limited the request. Retry after backoff.',
      })
    })

    test('429 with "too many tokens" stays rate_limited', () => {
      expect(
        classifyOpenAIHttpFailure({ status: 429, body: 'too many tokens, please wait' })
          .category,
      ).toBe('rate_limited')
    })
  })

  describe('404', () => {
    test.each([
      ['model "llama3" not found'],
      ['The model `gpt-9` does not exist'],
      ['unknown model: foo'],
      ['MODEL is an unavailable model'],
    ])('model message %p → model_not_found', body => {
      expect(classifyOpenAIHttpFailure({ status: 404, body })).toEqual({
        source: 'http',
        category: 'model_not_found',
        retryable: false,
        status: 404,
        message: body,
        hint: 'The selected model is not installed or not available on this endpoint.',
      })
    })

    test('"unknown model" alone matches because it contains "model"', () => {
      expect(classifyOpenAIHttpFailure({ status: 404, body: 'Unknown Model' }).category).toBe(
        'model_not_found',
      )
    })

    test('a route 404 that mentions /models is classified as model_not_found', () => {
      expect(
        classifyOpenAIHttpFailure({
          status: 404,
          body: 'The requested URL /v1/models was not found on this server',
        }).category,
      ).toBe('model_not_found')
    })

    test('"not found" without "model" → endpoint_not_found', () => {
      expect(classifyOpenAIHttpFailure({ status: 404, body: '404 page not found' })).toEqual({
        source: 'http',
        category: 'endpoint_not_found',
        retryable: false,
        status: 404,
        message: '404 page not found',
        hint: 'Endpoint was not found. Confirm OPENAI_BASE_URL includes /v1 for OpenAI-compatible local providers.',
      })
    })

    test('"model" without a not-found phrase → endpoint_not_found', () => {
      expect(classifyOpenAIHttpFailure({ status: 404, body: 'model missing' }).category).toBe(
        'endpoint_not_found',
      )
    })

    test('404 with an overflow body is endpoint_not_found (404 wins)', () => {
      expect(
        classifyOpenAIHttpFailure({ status: 404, body: 'maximum context length' }).category,
      ).toBe('endpoint_not_found')
    })

    test('model_not_found only on 404, not 400', () => {
      expect(
        classifyOpenAIHttpFailure({ status: 400, body: 'model not found' }).category,
      ).toBe('unknown')
    })
  })

  describe('context_overflow', () => {
    const OVERFLOW_HINT =
      'Prompt context exceeded model/server limits. Reduce context or increase provider context length.'

    test('413 with any body, even empty', () => {
      expect(classifyOpenAIHttpFailure({ status: 413, body: '' })).toEqual({
        source: 'http',
        category: 'context_overflow',
        retryable: false,
        status: 413,
        message: '',
        hint: OVERFLOW_HINT,
      })
    })

    test('413 with an HTML body is still overflow', () => {
      expect(
        classifyOpenAIHttpFailure({ status: 413, body: '<html>Payload Too Large</html>' })
          .category,
      ).toBe('context_overflow')
    })

    test.each([
      ['Too many tokens in request'],
      ['Request too large for gpt-4o'],
      ["This model's maximum context length is 8192 tokens"],
      ['context length exceeded'],
      ['MAXIMUM CONTEXT reached'],
      ['input length must be less than 4096'],
      ['payload too large'],
      ['prompt is too long: 210000 tokens > 200000 maximum'],
    ])('400 %p', body => {
      const failure = classifyOpenAIHttpFailure({ status: 400, body })
      expect(failure.category).toBe('context_overflow')
      expect(failure.retryable).toBe(false)
      expect(failure.hint).toBe(OVERFLOW_HINT)
    })

    test.each([500, 502, 503, 599])('%p with an overflow phrase', status => {
      const failure = classifyOpenAIHttpFailure({
        status,
        body: 'the input length exceeds the context window',
      })
      expect(failure.category).toBe('context_overflow')
      expect(failure.retryable).toBe(false)
    })

    // The phrases other servers use, from opencode's list.
    test.each([
      ['exceeds the context window of this model'],
      ['input token count exceeds the maximum'],
      ['reduce the length of the messages'],
      ['context_length_exceeded'],
      ['the request exceeds the available context size, try increasing it'],
      ['prompt has 9,000 tokens, but the configured context size is 8,192 tokens'],
      ['number of input tokens exceeds maximum length'],
      ['`inputs` tokens + `max_new_tokens` must be <= 4096'],
      ['model_context_window_exceeded'],
      ['Request Entity Too Large'],
    ])('400 %p', body => {
      expect(classifyOpenAIHttpFailure({ status: 400, body }).category).toBe(
        'context_overflow',
      )
    })

    test.each([['maximum_context'], ['too large']])('400 %p is not an overflow', body => {
      expect(classifyOpenAIHttpFailure({ status: 400, body }).category).toBe('unknown')
    })

    // "exceeds the limit of N" is an overflow only when N counts tokens: the
    // same words cap images, tools and max_tokens, and "token limit
    // exceeded" is also how a monthly quota reads.
    test.each([
      ['Image size exceeds the limit of 10MB'],
      ['{"error":{"message":"The number of images in the request exceeds the limit of 5"}}'],
      ['{"error":{"message":"Number of tools exceeds the limit of 128"}}'],
      ['`max_tokens` exceeds the limit of 8192 for this model'],
      ['Your monthly token limit exceeded. Upgrade your plan.'],
      ['daily token limit exceeded'],
    ])('400 %p is not an overflow', body => {
      expect(classifyOpenAIHttpFailure({ status: 400, body }).category).not.toBe('context_overflow')
    })

    test('"exceeds the limit of N tokens" is an overflow', () => {
      expect(
        classifyOpenAIHttpFailure({ status: 400, body: 'The prompt exceeds the limit of 8192 tokens' })
          .category,
      ).toBe('context_overflow')
    })

    test('a throttle wrapped in a JSON envelope is not an overflow', () => {
      const body = JSON.stringify({ error: { message: 'Throttling error: Too many tokens in flight' } })
      expect(classifyOpenAIHttpFailure({ status: 503, body }).category).not.toBe('context_overflow')
    })

    test('"max_tokens must be less than" is NOT overflow', () => {
      expect(
        classifyOpenAIHttpFailure({
          status: 400,
          body: 'max_tokens must be less than or equal to 4096',
        }).category,
      ).toBe('unknown')
    })

    // Bedrock words a throttle as "Too many tokens, please wait"; compacting
    // cannot fix a throttle.
    test.each([
      ['too many tokens, please wait'],
      ['Too many tokens per day, please wait before trying again.'],
      ['Request too large: rate limit reached for tokens per minute'],
      ['Too many requests: context length is fine, slow down'],
    ])('a throttle %p on 400 is not an overflow', body => {
      expect(classifyOpenAIHttpFailure({ status: 400, body }).category).not.toBe(
        'context_overflow',
      )
    })

    test('"input length" matches inside unrelated prose', () => {
      expect(
        classifyOpenAIHttpFailure({ status: 400, body: 'invalid input length for field name' })
          .category,
      ).toBe('context_overflow')
    })

    test.each([402, 408, 409, 422, 499])(
      '%p with an overflow phrase is NOT overflow (only 400 and >=500)',
      status => {
        expect(
          classifyOpenAIHttpFailure({ status, body: 'maximum context length exceeded' })
            .category,
        ).toBe('unknown')
      },
    )

    test('overflow wins over tool-compat on 400', () => {
      expect(
        classifyOpenAIHttpFailure({
          status: 400,
          body: 'tool_calls pushed the context length past the limit',
        }).category,
      ).toBe('context_overflow')
    })

    test('overflow wins over malformed on 400', () => {
      expect(
        classifyOpenAIHttpFailure({ status: 400, body: 'malformed: request too large' })
          .category,
      ).toBe('context_overflow')
    })
  })

  describe('400 → tool_call_incompatible', () => {
    test.each([
      ['tool_calls is not supported'],
      ['invalid tool_call id'],
      ['tool_use blocks are not allowed'],
      ['unexpected tool_result'],
      ['This model does not support Function Calling'],
      ['function call failed'],
    ])('%p', body => {
      expect(classifyOpenAIHttpFailure({ status: 400, body })).toEqual({
        source: 'http',
        category: 'tool_call_incompatible',
        retryable: false,
        status: 400,
        message: body,
        hint: 'Provider/model rejected tool-calling payload. Retry without tools or use a tool-capable model.',
      })
    })

    test('only on 400: 422 with a tool phrase falls through to unknown', () => {
      expect(
        classifyOpenAIHttpFailure({ status: 422, body: 'tool_calls invalid' }).category,
      ).toBe('unknown')
    })

    test('only on 400: 500 with a tool phrase is provider_unavailable', () => {
      expect(
        classifyOpenAIHttpFailure({ status: 500, body: 'tool_call parser crashed' }).category,
      ).toBe('provider_unavailable')
    })

    test('tool-compat wins over malformed on 400', () => {
      expect(
        classifyOpenAIHttpFailure({ status: 400, body: 'malformed tool_calls array' })
          .category,
      ).toBe('tool_call_incompatible')
    })
  })

  describe('malformed_provider_response', () => {
    test.each([
      ['<!DOCTYPE html><html><body>Bad Gateway</body></html>'],
      ['<html><body>oops</body></html>'],
      ['Invalid JSON in request body'],
      ['malformed request'],
      ['Unexpected token < in JSON at position 0'],
      ['cannot parse body'],
      ['body is not valid JSON'],
    ])('400 %p', body => {
      expect(classifyOpenAIHttpFailure({ status: 400, body })).toEqual({
        source: 'http',
        category: 'malformed_provider_response',
        retryable: false,
        status: 400,
        message: body,
        hint: 'Provider returned malformed or non-JSON response where JSON was expected.',
      })
    })

    test.each([422, 451])('%p with malformed phrase', status => {
      expect(classifyOpenAIHttpFailure({ status, body: 'invalid json' }).category).toBe(
        'malformed_provider_response',
      )
    })

    test.each([502, 503, 504])(
      '%p with an HTML gateway page is malformed and NOT retryable',
      status => {
        const failure = classifyOpenAIHttpFailure({
          status,
          body: '<html><head><title>502 Bad Gateway</title></head></html>',
        })
        expect(failure.category).toBe('malformed_provider_response')
        expect(failure.retryable).toBe(false)
      },
    )

    test('below 400 is never malformed', () => {
      expect(classifyOpenAIHttpFailure({ status: 302, body: '<html>moved</html>' }).category).toBe(
        'unknown',
      )
    })
  })

  describe('>=500 → provider_unavailable', () => {
    test.each([500, 502, 503, 504, 529])('%p full shape', status => {
      expect(classifyOpenAIHttpFailure({ status, body: 'Internal error' })).toEqual({
        source: 'http',
        category: 'provider_unavailable',
        retryable: true,
        status,
        message: 'Internal error',
        hint: 'Provider reported a server-side failure. Retry after a short delay.',
      })
    })
  })

  describe('unknown fallback', () => {
    test.each([400, 402, 405, 409, 422, 200, 0])('%p with a neutral body', status => {
      expect(classifyOpenAIHttpFailure({ status, body: 'something odd' })).toEqual({
        source: 'http',
        category: 'unknown',
        retryable: false,
        status,
        message: 'something odd',
      })
    })

    test('unknown carries no hint key', () => {
      expect('hint' in classifyOpenAIHttpFailure({ status: 400, body: '' })).toBe(false)
    })

    test('an undefined body is coerced to the empty string', () => {
      const failure = classifyOpenAIHttpFailure({
        status: 400,
        body: undefined as unknown as string,
      })
      expect(failure.message).toBe('')
      expect(failure.category).toBe('unknown')
    })

    test('a null body on 500 is provider_unavailable with an empty message', () => {
      const failure = classifyOpenAIHttpFailure({
        status: 500,
        body: null as unknown as string,
      })
      expect(failure.message).toBe('')
      expect(failure.category).toBe('provider_unavailable')
    })
  })
})
