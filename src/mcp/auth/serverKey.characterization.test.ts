/**
 * The credential key: every token, client and secret in the store is filed
 * under it, so its exact text is a storage format. The fixture holds keys
 * produced from real configs; a rewrite that changes one strands the
 * credentials users already have.
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getServerKey, hasMcpDiscoveryButNoToken } from 'src/mcp/auth.js'
import { useIsolatedStore } from 'src/mcp/auth/__testutils__/oauthTestBed.js'
import type { McpHTTPServerConfig, McpSSEServerConfig } from 'src/mcp/types.js'

type Remote = McpHTTPServerConfig | McpSSEServerConfig
const fixture: { name: string; config: Remote; key: string }[] = JSON.parse(
  readFileSync(join(import.meta.dir, '__fixtures__', 'rewrite', 'server-keys.json'), 'utf8'),
)

const store = useIsolatedStore()

describe('getServerKey', () => {
  test('reproduces every stored key in the fixture', () => {
    for (const { name, config, key } of fixture) {
      expect(getServerKey(name, config), key).toBe(key)
    }
  })

  test('is the name, a bar, and 16 hex chars of SHA-256 over {type, url, headers} as compact JSON', () => {
    for (const { name, config, key } of fixture) {
      const identity = JSON.stringify({ type: config.type, url: config.url, headers: config.headers ?? {} })
      expect(key).toBe(`${name}|${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`)
    }
  })

  test('anything that names a different server gives a different key', () => {
    const base: McpSSEServerConfig = { type: 'sse', url: 'https://mcp.example.test/sse', headers: { 'X-Tenant': 'one' } }
    const variants: [label: string, name: string, cfg: Remote][] = [
      ['name', 'other', base],
      ['url', 'srv', { ...base, url: 'https://elsewhere.example.test/sse' }],
      ['header value', 'srv', { ...base, headers: { 'X-Tenant': 'two' } }],
      ['an extra header', 'srv', { ...base, headers: { 'X-Tenant': 'one', 'X-B': 'b' } }],
      ['transport', 'srv', { type: 'http', url: base.url, headers: base.headers }],
    ]
    const keys = new Set([getServerKey('srv', base), ...variants.map(([, n, c]) => getServerKey(n, c))])
    expect(keys.size).toBe(variants.length + 1)
  })

  test('fields outside the server identity do not change it, and no headers equals empty headers', () => {
    const plain: McpHTTPServerConfig = { type: 'http', url: 'https://mcp.example.test/mcp' }
    const same: Remote[] = [
      { ...plain, headers: {} },
      { ...plain, headersHelper: './h.sh' },
      { ...plain, oauth: { clientId: 'cid', callbackPort: 9999 } },
      { ...plain, scope: 'project' } as Remote,
    ]
    for (const cfg of same) expect(getServerKey('docs', cfg)).toBe(getServerKey('docs', plain))
  })
})

describe('hasMcpDiscoveryButNoToken', () => {
  const cfg: McpHTTPServerConfig = { type: 'http', url: 'https://mcp.example.test/mcp' }
  const other: McpHTTPServerConfig = { type: 'http', url: 'https://other.example.test/mcp' }

  test('is true only for a stored entry that holds neither an access nor a refresh token', () => {
    type Case = [label: string, entry: Record<string, unknown> | undefined, expected: boolean]
    const cases: Case[] = [
      ['nothing stored', undefined, false],
      ['discovery only', { discoveryState: { authorizationServerUrl: 'https://as.example.test' } }, true],
      ['empty access token', { accessToken: '', expiresAt: 0 }, true],
      ['access token', { accessToken: 'at', expiresAt: 1 }, false],
      ['refresh token only', { accessToken: '', refreshToken: 'rt', expiresAt: 0 }, false],
    ]
    for (const [label, entry, expected] of cases) {
      store.write({ mcpOAuth: { [getServerKey('docs', other)]: { accessToken: '' }, ...(entry ? { [getServerKey('docs', cfg)]: entry } : {}) } })
      expect(hasMcpDiscoveryButNoToken('docs', cfg), label).toBe(expected)
    }
  })

  test('an empty store, or one without OAuth entries, is false', () => {
    expect(hasMcpDiscoveryButNoToken('docs', cfg)).toBe(false)
    store.write({ mcpOAuthClientConfig: {} })
    expect(hasMcpDiscoveryButNoToken('docs', cfg)).toBe(false)
  })
})
