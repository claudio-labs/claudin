import { describe, expect, test } from 'bun:test'

import {
  LOCAL_SHIM_IDLE_TIMEOUT_MS,
  localModelServerDispatcher,
  resolveShimIdleTimeoutMs,
} from 'src/providers/shims/openaiShim/fetchTimeout.js'

describe('localModelServerDispatcher', () => {
  test('one Agent per timeout value, reused', () => {
    const a = localModelServerDispatcher(LOCAL_SHIM_IDLE_TIMEOUT_MS)
    expect(a).toBeDefined()
    expect(localModelServerDispatcher(LOCAL_SHIM_IDLE_TIMEOUT_MS)).toBe(a)
    expect(localModelServerDispatcher(1234)).not.toBe(a)
  })
})

describe('resolveShimIdleTimeoutMs', () => {
  test('a local server gets 30 minutes: a long prefill sends no byte until the first token', () => {
    expect(LOCAL_SHIM_IDLE_TIMEOUT_MS).toBe(30 * 60 * 1000)
    expect(resolveShimIdleTimeoutMs('http://localhost:11434/v1', {})).toBe(LOCAL_SHIM_IDLE_TIMEOUT_MS)
    expect(resolveShimIdleTimeoutMs('http://192.168.1.20:8080/v1', {})).toBe(LOCAL_SHIM_IDLE_TIMEOUT_MS)
  })

  test('a hosted endpoint gets the SDK path default, 600 s', () => {
    expect(resolveShimIdleTimeoutMs('https://openrouter.ai/api/v1', {})).toBe(600_000)
  })

  test('API_TIMEOUT_MS wins everywhere when set', () => {
    const env = { API_TIMEOUT_MS: '1234' }
    expect(resolveShimIdleTimeoutMs('http://localhost:11434/v1', env)).toBe(1234)
    expect(resolveShimIdleTimeoutMs('https://openrouter.ai/api/v1', env)).toBe(1234)
  })

  test('a malformed API_TIMEOUT_MS is ignored', () => {
    expect(resolveShimIdleTimeoutMs('https://openrouter.ai/api/v1', { API_TIMEOUT_MS: 'soon' })).toBe(600_000)
    expect(resolveShimIdleTimeoutMs('http://localhost:11434/v1', { API_TIMEOUT_MS: '0' })).toBe(
      LOCAL_SHIM_IDLE_TIMEOUT_MS,
    )
  })
})
