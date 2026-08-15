import { describe, expect, test } from 'bun:test'
import {
  APIConnectionError as RealAPIConnectionError,
  APIError as RealAPIError,
  APIUserAbortError as RealAPIUserAbortError,
} from '@anthropic-ai/sdk'
import {
  AbortError,
  isAbortError,
  isSdkApiConnectionError,
  isSdkApiConnectionTimeoutError,
  isSdkApiError,
  isSdkApiUserAbortError,
  isSdkAuthenticationError,
  isSdkNotFoundError,
} from 'src/utils/errors.js'

/**
 * Mirrors the class hierarchy of a *second* @anthropic-ai/sdk copy — the
 * bedrock/vertex/foundry SDKs are externalized in scripts/build.ts and load
 * their own copy from node_modules at runtime, so the errors they throw have
 * the same constructor names but are not instances of the bundled classes.
 */
function makeForeignSdkErrors() {
  class AnthropicError extends Error {}
  class APIError extends AnthropicError {
    constructor(readonly status?: number) {
      super('foreign sdk error')
    }
  }
  class APIUserAbortError extends APIError {}
  class APIConnectionError extends APIError {}
  class APIConnectionTimeoutError extends APIConnectionError {}
  class AuthenticationError extends APIError {}
  class NotFoundError extends APIError {}
  class RateLimitError extends APIError {}
  return {
    APIError,
    APIUserAbortError,
    APIConnectionError,
    APIConnectionTimeoutError,
    AuthenticationError,
    NotFoundError,
    RateLimitError,
  }
}

const Foreign = makeForeignSdkErrors()

describe('SDK error guards — bundled copy (instanceof fast path)', () => {
  test('isSdkApiError matches the real APIError', () => {
    const e = new RealAPIError(500, undefined, 'boom', new Headers())
    expect(isSdkApiError(e)).toBe(true)
  })

  test('isSdkApiConnectionError matches the real APIConnectionError', () => {
    const e = new RealAPIConnectionError({ message: 'conn' })
    expect(isSdkApiConnectionError(e)).toBe(true)
    // APIConnectionError extends APIError, same as instanceof semantics
    expect(isSdkApiError(e)).toBe(true)
  })

  test('isSdkApiUserAbortError matches the real APIUserAbortError', () => {
    const e = new RealAPIUserAbortError()
    expect(isSdkApiUserAbortError(e)).toBe(true)
    expect(isAbortError(e)).toBe(true)
  })
})

describe('SDK error guards — foreign copy (prototype-name walk)', () => {
  test('foreign errors are NOT instances of the bundled classes (premise)', () => {
    expect(new Foreign.APIError(500) instanceof RealAPIError).toBe(false)
  })

  test('isSdkApiError matches a foreign APIError and its subclasses', () => {
    expect(isSdkApiError(new Foreign.APIError(500))).toBe(true)
    expect(isSdkApiError(new Foreign.RateLimitError(429))).toBe(true)
    expect(isSdkApiError(new Foreign.APIConnectionError())).toBe(true)
  })

  test('subclass guards match foreign instances with instanceof semantics', () => {
    const timeout = new Foreign.APIConnectionTimeoutError()
    expect(isSdkApiConnectionTimeoutError(timeout)).toBe(true)
    expect(isSdkApiConnectionError(timeout)).toBe(true)

    expect(isSdkAuthenticationError(new Foreign.AuthenticationError(401))).toBe(
      true,
    )
    expect(isSdkNotFoundError(new Foreign.NotFoundError(404))).toBe(true)
  })

  test('guards stay specific — a base APIError is not a subclass', () => {
    const base = new Foreign.APIError(500)
    expect(isSdkApiUserAbortError(base)).toBe(false)
    expect(isSdkAuthenticationError(base)).toBe(false)
    expect(isSdkNotFoundError(base)).toBe(false)
    expect(isSdkApiConnectionError(base)).toBe(false)
  })

  test('foreign APIUserAbortError is abort-shaped', () => {
    const e = new Foreign.APIUserAbortError()
    expect(isSdkApiUserAbortError(e)).toBe(true)
    expect(isAbortError(e)).toBe(true)
  })

  test('narrowed foreign errors expose .status', () => {
    const e: unknown = new Foreign.RateLimitError(429)
    if (isSdkApiError(e)) {
      expect(e.status).toBe(429)
    } else {
      throw new Error('guard should have matched')
    }
  })
})

describe('SDK error guards — negatives', () => {
  test('non-SDK values never match', () => {
    expect(isSdkApiError(new Error('plain'))).toBe(false)
    expect(isSdkApiError('APIError')).toBe(false)
    expect(isSdkApiError(null)).toBe(false)
    expect(isSdkApiError(undefined)).toBe(false)
    expect(isSdkApiError({ status: 500 })).toBe(false)
    expect(isSdkApiUserAbortError(new Error('abort'))).toBe(false)
  })

  test('our AbortError is abort-shaped but not an SDK error', () => {
    const e = new AbortError()
    expect(isAbortError(e)).toBe(true)
    expect(isSdkApiError(e)).toBe(false)
  })

  test('DOMException-style aborts still count as abort-shaped', () => {
    const e = new Error('cancelled')
    e.name = 'AbortError'
    expect(isAbortError(e)).toBe(true)
  })
})
