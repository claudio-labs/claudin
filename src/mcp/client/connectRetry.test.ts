import { describe, expect, test } from 'bun:test'
import { isTransientConnectError, nextConnectRetryDelay } from 'src/mcp/client/connectRetry.js'

const withCode = (code: unknown, cause?: unknown) => Object.assign(new Error('failed'), { code }, cause ? { cause } : {})

describe('isTransientConnectError', () => {
  test('HTTP 408, 429 and 5xx except 501 are transient', () => {
    for (const status of [408, 429, 500, 502, 503, 504, 599]) {
      expect(isTransientConnectError(withCode(status))).toBe(true)
    }
  })

  test('other HTTP statuses are not', () => {
    for (const status of [400, 401, 403, 404, 501, 600, 302]) {
      expect(isTransientConnectError(withCode(status))).toBe(false)
    }
  })

  test('a network error code on the error or on its cause is transient', () => {
    expect(isTransientConnectError(withCode('ECONNRESET'))).toBe(true)
    expect(isTransientConnectError(withCode('ConnectionRefused'))).toBe(true)
    expect(isTransientConnectError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe(true)
  })

  test('anything else is not', () => {
    expect(isTransientConnectError(withCode('ENOENT'))).toBe(false)
    expect(isTransientConnectError(new Error('MCP server "x" connection timed out after 30000ms'))).toBe(false)
    expect(isTransientConnectError('ECONNRESET')).toBe(false)
    expect(isTransientConnectError(null)).toBe(false)
  })
})

describe('nextConnectRetryDelay', () => {
  const transient = withCode(503)

  test('retries a remote server twice: 250 ms, then 1 s', () => {
    for (const type of ['http', 'sse', 'ws']) {
      expect(nextConnectRetryDelay(transient, { type, attempt: 0, remainingMs: 30_000 })).toBe(250)
      expect(nextConnectRetryDelay(transient, { type, attempt: 1, remainingMs: 30_000 })).toBe(1000)
      expect(nextConnectRetryDelay(transient, { type, attempt: 2, remainingMs: 30_000 })).toBeNull()
    }
  })

  test('never retries a local or internal server', () => {
    for (const type of ['stdio', 'sdk', 'sse-ide', 'ws-ide', 'claudeai-proxy']) {
      expect(nextConnectRetryDelay(transient, { type, attempt: 0, remainingMs: 30_000 })).toBeNull()
    }
  })

  test('does not wait past the startup deadline', () => {
    expect(nextConnectRetryDelay(transient, { type: 'http', attempt: 0, remainingMs: 250 })).toBeNull()
    expect(nextConnectRetryDelay(transient, { type: 'http', attempt: 1, remainingMs: 900 })).toBeNull()
  })

  test('does not retry a failure that is not transient', () => {
    expect(nextConnectRetryDelay(withCode(401), { type: 'http', attempt: 0, remainingMs: 30_000 })).toBeNull()
  })
})
