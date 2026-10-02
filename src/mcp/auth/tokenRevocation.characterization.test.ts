/**
 * Signing out of an MCP server: RFC 7009 revocation against a real
 * authorization server on loopback, the client authentication it chooses,
 * the Bearer retry for servers that want one, and the local clearing that
 * happens whatever the server says.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearServerTokensFromSecureStorage,
  getServerKey,
  revokeServerTokens,
} from 'src/mcp/auth.js'
import { type AuthBed, startAuthBed, useIsolatedStore } from 'src/mcp/auth/__testutils__/oauthTestBed.js'
import type { McpHTTPServerConfig } from 'src/mcp/types.js'

const store = useIsolatedStore()
const beds: AuthBed[] = []
afterEach(() => {
  for (const b of beds.splice(0)) b.stop()
})
const bedWith = (overrides: Parameters<typeof startAuthBed>[0] = {}) => {
  const b = startAuthBed(overrides)
  beds.push(b)
  return b
}

const http = (url: string, oauth?: McpHTTPServerConfig['oauth']): McpHTTPServerConfig => ({ type: 'http', url, ...(oauth ? { oauth } : {}) })
const keyOf = (cfg: McpHTTPServerConfig) => getServerKey('docs', cfg)

function hold(cfg: McpHTTPServerConfig, entry: Record<string, unknown>) {
  const current = store.read() ?? {}
  store.write({
    ...current,
    mcpOAuth: { ...current.mcpOAuth, [keyOf(cfg)]: { serverName: 'docs', serverUrl: cfg.url, expiresAt: Date.now() + 60_000, ...entry } },
  })
}

const revokes = (b: AuthBed) =>
  b.hits('/revoke').map(r => ({ authorization: r.authorization, body: Object.fromEntries(r.form!) }))

describe('server-side revocation', () => {
  test('the refresh token goes first, then the access token, with the client auth the server accepts', async () => {
    const id = 'id:with space'
    const secret = 'p@ss'
    const basic = `Basic ${btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)}`
    type Case = {
      label: string
      metadata: Record<string, unknown>
      client: { clientId?: string; clientSecret?: string }
      authorization: string | null
      bodyAuth: Record<string, string>
    }
    const cases: Case[] = [
      { label: 'no advertised methods', metadata: {}, client: { clientId: id, clientSecret: secret }, authorization: basic, bodyAuth: {} },
      { label: 'revocation list says post', metadata: { revocation_endpoint_auth_methods_supported: ['client_secret_post'] }, client: { clientId: id, clientSecret: secret }, authorization: null, bodyAuth: { client_id: id, client_secret: secret } },
      { label: 'token list says post', metadata: { token_endpoint_auth_methods_supported: ['client_secret_post'] }, client: { clientId: id, clientSecret: secret }, authorization: null, bodyAuth: { client_id: id, client_secret: secret } },
      { label: 'both allowed', metadata: { revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'] }, client: { clientId: id, clientSecret: secret }, authorization: basic, bodyAuth: {} },
      { label: 'revocation list wins over token list', metadata: { revocation_endpoint_auth_methods_supported: ['client_secret_basic'], token_endpoint_auth_methods_supported: ['client_secret_post'] }, client: { clientId: id, clientSecret: secret }, authorization: basic, bodyAuth: {} },
      { label: 'public client', metadata: { revocation_endpoint_auth_methods_supported: ['client_secret_post'] }, client: { clientId: id }, authorization: null, bodyAuth: { client_id: id } },
      { label: 'no client at all', metadata: {}, client: {}, authorization: null, bodyAuth: {} },
    ]
    for (const c of cases) {
      store.write({})
      const b = bedWith({ metadataExtra: c.metadata })
      const cfg = http(b.mcpUrl)
      hold(cfg, { accessToken: 'at-1', refreshToken: 'rt-1', ...c.client })
      await revokeServerTokens('docs', cfg)
      expect(revokes(b), c.label).toEqual([
        { authorization: c.authorization, body: { token: 'rt-1', token_type_hint: 'refresh_token', ...c.bodyAuth } },
        { authorization: c.authorization, body: { token: 'at-1', token_type_hint: 'access_token', ...c.bodyAuth } },
      ])
      expect(store.read()!.mcpOAuth[keyOf(cfg)], c.label).toBeUndefined()
    }
  })

  test('a 401 is retried once with the access token as Bearer and no client credentials', async () => {
    const b = bedWith({
      metadataExtra: { revocation_endpoint_auth_methods_supported: ['client_secret_post'] },
      onRevoke: (_form, authorization) => (authorization?.startsWith('Bearer ') ? undefined : new Response(null, { status: 401 })),
    })
    const cfg = http(b.mcpUrl)
    hold(cfg, { accessToken: 'at-1', refreshToken: 'rt-1', clientId: 'cid', clientSecret: 'csec' })
    await revokeServerTokens('docs', cfg)
    const post = { client_id: 'cid', client_secret: 'csec' }
    expect(revokes(b)).toEqual([
      { authorization: null, body: { token: 'rt-1', token_type_hint: 'refresh_token', ...post } },
      { authorization: 'Bearer at-1', body: { token: 'rt-1', token_type_hint: 'refresh_token' } },
      { authorization: null, body: { token: 'at-1', token_type_hint: 'access_token', ...post } },
      { authorization: 'Bearer at-1', body: { token: 'at-1', token_type_hint: 'access_token' } },
    ])
  })

  test('failures are swallowed and the local tokens are cleared regardless', async () => {
    type Case = [label: string, overrides: Parameters<typeof startAuthBed>[0], entry: Record<string, unknown>, revokeCalls: number]
    const cases: Case[] = [
      ['401 with no access token to fall back on', { onRevoke: () => new Response(null, { status: 401 }) }, { refreshToken: 'rt-1', accessToken: '' }, 1],
      ['500 on both tokens', { onRevoke: () => new Response(null, { status: 500 }) }, { refreshToken: 'rt-1', accessToken: 'at-1' }, 2],
      ['no revocation endpoint', { metadataExtra: { revocation_endpoint: undefined } }, { refreshToken: 'rt-1', accessToken: 'at-1' }, 0],
      ['no metadata anywhere', { protectedResource: false, metadataAt: 'nowhere' }, { refreshToken: 'rt-1', accessToken: 'at-1' }, 0],
      ['nothing to revoke', {}, { accessToken: '', clientId: 'cid' }, 0],
    ]
    for (const [label, overrides, entry, revokeCalls] of cases) {
      store.write({})
      const b = bedWith(overrides)
      const cfg = http(b.mcpUrl)
      const neighbour = http('https://neighbour.test/mcp')
      hold(neighbour, { accessToken: 'keep' })
      hold(cfg, entry)
      await revokeServerTokens('docs', cfg)
      expect(b.hits('/revoke'), label).toHaveLength(revokeCalls)
      expect(store.read()!.mcpOAuth[keyOf(cfg)], label).toBeUndefined()
      expect(store.read()!.mcpOAuth[keyOf(neighbour)].accessToken, label).toBe('keep')
      if (label === 'nothing to revoke') expect(b.seen, label).toHaveLength(0)
    }
  })

  test('a metadata lookup that throws still clears the local tokens', async () => {
    const cfg = http('http://127.0.0.1:9/mcp', { authServerMetadataUrl: 'http://as.test/metadata' })
    hold(cfg, { accessToken: 'at-1' })
    await revokeServerTokens('docs', cfg)
    expect(store.read()!.mcpOAuth[keyOf(cfg)]).toBeUndefined()
  })

  test('the authorization server found at sign-in is the one asked to revoke', async () => {
    const mcp = bedWith({ protectedResource: false, metadataAt: 'nowhere' })
    const as = bedWith()
    const cfg = http(mcp.mcpUrl)
    hold(cfg, { accessToken: 'at-1', discoveryState: { authorizationServerUrl: as.base } })
    await revokeServerTokens('docs', cfg)
    expect(revokes(as).map(r => r.body.token)).toEqual(['at-1'])
    expect(mcp.hits('/revoke')).toHaveLength(0)
  })

  test('with no stored credentials at all nothing is contacted or written', async () => {
    const b = bedWith()
    await revokeServerTokens('docs', http(b.mcpUrl))
    expect(b.seen).toHaveLength(0)
    expect(store.read()).toBeNull()
  })
})

describe('what survives a revocation', () => {
  test('re-authentication keeps the step-up scope and the discovery URLs, nothing else', async () => {
    const b = bedWith({ metadataExtra: { revocation_endpoint: undefined } })
    const cfg = http(b.mcpUrl)
    hold(cfg, {
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      clientId: 'cid',
      clientSecret: 'csec',
      scope: 'docs.read',
      stepUpScope: 'docs.admin',
      discoveryState: {
        authorizationServerUrl: b.base,
        resourceMetadataUrl: `${b.base}/prm`,
        authorizationServerMetadata: { issuer: b.base, bulky: 'x'.repeat(500) },
      },
    })
    await revokeServerTokens('docs', cfg, { preserveStepUpState: true })
    expect(store.read()!.mcpOAuth[keyOf(cfg)]).toEqual({
      serverName: 'docs',
      serverUrl: cfg.url,
      accessToken: '',
      expiresAt: 0,
      stepUpScope: 'docs.admin',
      discoveryState: { authorizationServerUrl: b.base, resourceMetadataUrl: `${b.base}/prm` },
    })
  })

  test('only the parts that were there are kept', async () => {
    const b = bedWith({ metadataExtra: { revocation_endpoint: undefined } })
    const cfg = http(b.mcpUrl)
    const cases: [Record<string, unknown>, Record<string, unknown> | undefined][] = [
      [{ stepUpScope: 'docs.admin' }, { stepUpScope: 'docs.admin' }],
      [{ discoveryState: { authorizationServerUrl: b.base } }, { discoveryState: { authorizationServerUrl: b.base } }],
      [{}, undefined],
    ]
    for (const [extra, kept] of cases) {
      store.write({})
      hold(cfg, { accessToken: 'at-1', ...extra })
      await revokeServerTokens('docs', cfg, { preserveStepUpState: true })
      const entry = store.read()!.mcpOAuth[keyOf(cfg)]
      if (kept === undefined) expect(entry).toBeUndefined()
      else expect(entry).toEqual({ serverName: 'docs', serverUrl: cfg.url, accessToken: '', expiresAt: 0, ...kept })
    }
  })

  test('a plain sign-out drops the step-up state too', async () => {
    const b = bedWith({ metadataExtra: { revocation_endpoint: undefined } })
    const cfg = http(b.mcpUrl)
    hold(cfg, { accessToken: 'at-1', stepUpScope: 'docs.admin', discoveryState: { authorizationServerUrl: b.base } })
    await revokeServerTokens('docs', cfg)
    expect(store.read()!.mcpOAuth[keyOf(cfg)]).toBeUndefined()
  })
})

describe('clearServerTokensFromSecureStorage', () => {
  test('removes one server entry and leaves the rest of the store as it was', () => {
    const cfg = http('https://mcp.test/mcp')
    const other = http('https://other.test/mcp')
    store.write({ mcpOAuthClientConfig: { [keyOf(cfg)]: { clientSecret: 's' } } })
    hold(cfg, { accessToken: 'a' })
    hold(other, { accessToken: 'b' })
    clearServerTokensFromSecureStorage('docs', cfg)
    expect(store.read()).toEqual({
      mcpOAuthClientConfig: { [keyOf(cfg)]: { clientSecret: 's' } },
      mcpOAuth: { [keyOf(other)]: { serverName: 'docs', serverUrl: other.url, expiresAt: expect.any(Number), accessToken: 'b' } },
    })
  })

  test('with nothing stored for the server it writes nothing', () => {
    const cfg = http('https://mcp.test/mcp')
    clearServerTokensFromSecureStorage('docs', cfg)
    expect(store.read()).toBeNull()
    store.write({ mcpOAuth: {} })
    clearServerTokensFromSecureStorage('docs', cfg)
    expect(store.read()).toEqual({ mcpOAuth: {} })
  })
})
