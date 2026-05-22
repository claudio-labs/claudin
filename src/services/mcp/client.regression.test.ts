import { describe, expect, test } from 'bun:test'

import { areMcpConfigsEqual, getServerCacheKey } from './client/connection.js'
import { isMcpSessionExpiredError } from './client/errors.js'
import { mcpToolInputToAutoClassifierInput } from './client/fetchCapabilities.js'
import {
  inferCompactSchema,
  processMCPResult,
  transformMCPResult,
} from './client/toolResult.js'
import type { ScopedMcpServerConfig } from './types.js'

// Characterization tests for the pure exported surface of mcp/client.
// They lock current behavior so the 11i split (barrel + submodules) is
// proven behavior-preserving. Imports target the submodules directly rather
// than the barrel: print.test.ts does `mock.module('.../client.js')` whose
// fake implementations leak across files in the same `bun test` invocation,
// which would otherwise replace areMcpConfigsEqual et al. with stubs here.

const sseConfig = (url: string, scope = 'user'): ScopedMcpServerConfig =>
  ({ type: 'sse', url, scope }) as unknown as ScopedMcpServerConfig

describe('isMcpSessionExpiredError', () => {
  test('404 with JSON-RPC -32001 code is a session expiry', () => {
    const err = Object.assign(
      new Error('{"error":{"code":-32001,"message":"Session not found"}}'),
      { code: 404 },
    )
    expect(isMcpSessionExpiredError(err)).toBe(true)
  })

  test('404 with spaced JSON-RPC code variant is a session expiry', () => {
    const err = Object.assign(
      new Error('{"error":{"code": -32001,"message":"Session not found"}}'),
      { code: 404 },
    )
    expect(isMcpSessionExpiredError(err)).toBe(true)
  })

  test('generic 404 without the JSON-RPC code is not a session expiry', () => {
    const err = Object.assign(new Error('Not Found'), { code: 404 })
    expect(isMcpSessionExpiredError(err)).toBe(false)
  })

  test('non-404 status is not a session expiry', () => {
    const err = Object.assign(
      new Error('{"error":{"code":-32001}}'),
      { code: 500 },
    )
    expect(isMcpSessionExpiredError(err)).toBe(false)
  })

  test('error without a code property is not a session expiry', () => {
    expect(isMcpSessionExpiredError(new Error('{"code":-32001}'))).toBe(false)
  })
})

describe('getServerCacheKey', () => {
  test('key is prefixed with the server name', () => {
    expect(getServerCacheKey('slack', sseConfig('https://a'))).toStartWith(
      'slack-',
    )
  })

  test('same name + config yields a stable key', () => {
    expect(getServerCacheKey('slack', sseConfig('https://a'))).toBe(
      getServerCacheKey('slack', sseConfig('https://a')),
    )
  })

  test('different config yields a different key', () => {
    expect(getServerCacheKey('slack', sseConfig('https://a'))).not.toBe(
      getServerCacheKey('slack', sseConfig('https://b')),
    )
  })
})

describe('areMcpConfigsEqual', () => {
  test('different type is never equal', () => {
    const a = sseConfig('https://a')
    const b = { type: 'http', url: 'https://a', scope: 'user' } as unknown as ScopedMcpServerConfig
    expect(areMcpConfigsEqual(a, b)).toBe(false)
  })

  test('scope is excluded from the comparison', () => {
    expect(
      areMcpConfigsEqual(sseConfig('https://a', 'user'), sseConfig('https://a', 'project')),
    ).toBe(true)
  })

  test('differing connection config is not equal', () => {
    expect(
      areMcpConfigsEqual(sseConfig('https://a'), sseConfig('https://b')),
    ).toBe(false)
  })
})

describe('mcpToolInputToAutoClassifierInput', () => {
  test('empty input falls back to the tool name', () => {
    expect(mcpToolInputToAutoClassifierInput({}, 'search')).toBe('search')
  })

  test('keyed input is encoded as space-separated k=v pairs', () => {
    expect(
      mcpToolInputToAutoClassifierInput({ q: 'hello', limit: 5 }, 'search'),
    ).toBe('q=hello limit=5')
  })
})

describe('inferCompactSchema', () => {
  test('null', () => {
    expect(inferCompactSchema(null)).toBe('null')
  })

  test('empty array', () => {
    expect(inferCompactSchema([])).toBe('[]')
  })

  test('array uses the first element', () => {
    expect(inferCompactSchema([1, 2, 3])).toBe('[number]')
  })

  test('shallow object', () => {
    expect(inferCompactSchema({ a: 1, b: 'x' })).toBe('{a: number, b: string}')
  })

  test('depth limit collapses deep objects', () => {
    expect(inferCompactSchema({ a: { b: { c: 1 } } })).toBe('{a: {b: {...}}}')
  })

  test('objects with more than 10 keys are truncated', () => {
    const wide: Record<string, number> = {}
    for (let i = 0; i < 12; i++) wide[`k${i}`] = i
    const schema = inferCompactSchema(wide)
    expect(schema).toEndWith(', ...}')
    expect(schema).toContain('k0: number')
    expect(schema).toContain('k9: number')
    expect(schema).not.toContain('k10')
  })
})

describe('transformMCPResult', () => {
  test('toolResult is stringified', async () => {
    const out = await transformMCPResult({ toolResult: 42 }, 'tool', 'srv')
    expect(out).toEqual({ content: '42', type: 'toolResult' })
  })

  test('structuredContent is serialized with an inferred schema', async () => {
    const out = await transformMCPResult(
      { structuredContent: { ok: true } },
      'tool',
      'srv',
    )
    expect(out.type).toBe('structuredContent')
    expect(JSON.parse(out.content as string)).toEqual({ ok: true })
    expect(typeof out.schema).toBe('string')
  })

  test('text content array is transformed into content blocks', async () => {
    const out = await transformMCPResult(
      { content: [{ type: 'text', text: 'hello' }] },
      'tool',
      'srv',
    )
    expect(out.type).toBe('contentArray')
    expect(out.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  test('unexpected response format throws', async () => {
    await expect(transformMCPResult(12345, 'tool', 'srv')).rejects.toThrow()
  })
})

describe('processMCPResult', () => {
  test('ide results are returned without large-output handling', async () => {
    const out = await processMCPResult({ toolResult: 'ide-output' }, 'tool', 'ide')
    expect(out).toBe('ide-output')
  })

  test('small text content is returned untruncated', async () => {
    const out = await processMCPResult(
      { content: [{ type: 'text', text: 'small' }] },
      'tool',
      'srv',
    )
    expect(out).toEqual([{ type: 'text', text: 'small' }])
  })
})
