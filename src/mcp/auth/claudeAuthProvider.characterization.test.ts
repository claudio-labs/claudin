/**
 * ClaudeAuthProvider, pinned as the MCP SDK and the transport use it: what it
 * reads from and writes to the credential store, the redirect URL and client
 * metadata it advertises, the step-up rules, and the locked refresh against a
 * real authorization server on loopback.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ClaudeAuthProvider,
  getServerKey,
  saveMcpClientSecret,
} from 'src/mcp/auth.js'
import * as lockfile from 'src/shared/fs/lockfile.js'
import {
  type AuthBed,
  makeLoopbackCert,
  startAuthBed,
  useIsolatedStore,
  withSelfSignedTrust,
} from 'src/mcp/auth/__testutils__/oauthTestBed.js'
import type { McpHTTPServerConfig } from 'src/mcp/types.js'

const store = useIsolatedStore()
let bed: AuthBed | undefined
afterEach(() => {
  bed?.stop()
  bed = undefined
})

let certDir = ''
let cert: { cert: string; key: string }
beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), 'mcp-auth-cert-'))
  cert = makeLoopbackCert(certDir)
})
afterAll(() => rmSync(certDir, { recursive: true, force: true }))

const http = (url: string, oauth?: McpHTTPServerConfig['oauth']): McpHTTPServerConfig => ({
  type: 'http',
  url,
  ...(oauth ? { oauth } : {}),
})

const entryOf = (name: string, cfg: McpHTTPServerConfig) =>
  store.read()?.mcpOAuth?.[getServerKey(name, cfg)]

function seed(name: string, cfg: McpHTTPServerConfig, entry: Record<string, unknown>) {
  const current = store.read() ?? {}
  store.write({
    ...current,
    mcpOAuth: {
      ...current.mcpOAuth,
      [getServerKey(name, cfg)]: { serverName: name, serverUrl: cfg.url, ...entry },
    },
  })
}

/** A server the user signed in to earlier, whose token has `secondsLeft` to live. */
function signedIn(b: AuthBed, cfg: McpHTTPServerConfig, secondsLeft: number, extra: Record<string, unknown> = {}) {
  b.clients.set('client-seed', undefined)
  b.liveRefresh.add('refresh-seed')
  seed('docs', cfg, {
    clientId: 'client-seed',
    accessToken: 'access-seed',
    refreshToken: 'refresh-seed',
    expiresAt: Date.now() + secondsLeft * 1000,
    scope: 'read',
    ...extra,
  })
}

describe('what the provider advertises', () => {
  test('the redirect URL is the loopback fallback unless one is given', () => {
    const cases: [string | undefined, string][] = [
      [undefined, 'http://localhost:3118/callback'],
      ['http://localhost:50123/callback', 'http://localhost:50123/callback'],
    ]
    for (const [given, expected] of cases) {
      const provider = new ClaudeAuthProvider('docs', http('https://mcp.test/mcp'), given)
      expect(provider.redirectUrl).toBe(expected)
      expect(provider.clientMetadata.redirect_uris).toEqual([expected])
    }
  })

  test('registration metadata describes a public client named after the server', () => {
    const provider = new ClaudeAuthProvider('docs', http('https://mcp.test/mcp'), 'http://localhost:4000/callback')
    const advertised = provider.clientMetadata as Record<string, unknown>
    const expected: [field: string, value: unknown][] = [
      ['client_name', 'Claudin (docs)'],
      ['redirect_uris', ['http://localhost:4000/callback']],
      ['grant_types', ['authorization_code', 'refresh_token']],
      ['response_types', ['code']],
      ['token_endpoint_auth_method', 'none'],
    ]
    for (const [field, value] of expected) expect(advertised[field], field).toEqual(value)
    expect(Object.keys(advertised).sort()).toEqual(expected.map(([field]) => field).sort())
  })

  test('registration metadata asks for the scope the server metadata names', () => {
    const shapes: [Record<string, unknown>, string][] = [
      [{ scope: 'one' }, 'one'],
      [{ default_scope: 'two' }, 'two'],
      [{ scopes_supported: ['three', 'four'] }, 'three four'],
    ]
    for (const [extra, scope] of shapes) {
      const provider = new ClaudeAuthProvider('docs', http('https://mcp.test/mcp'))
      provider.setMetadata({ issuer: 'https://as.test', ...extra } as never)
      expect(provider.clientMetadata.scope).toBe(scope)
    }
  })

  test('the client-id metadata document URL can be overridden from the environment', () => {
    const provider = new ClaudeAuthProvider('docs', http('https://mcp.test/mcp'))
    expect(provider.clientMetadataUrl).toBe('https://claude.ai/oauth/claude-code-client-metadata')
    process.env.MCP_OAUTH_CLIENT_METADATA_URL = 'https://client.test/meta.json'
    expect(provider.clientMetadataUrl).toBe('https://client.test/meta.json')
  })

  test('state is fixed for one provider and fresh for the next', async () => {
    const first = new ClaudeAuthProvider('docs', http('https://mcp.test/mcp'))
    const second = new ClaudeAuthProvider('docs', http('https://mcp.test/mcp'))
    const a = await first.state()
    expect(await first.state()).toBe(a)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await second.state()).not.toBe(a)
  })

  test('the PKCE verifier lives in memory only, until it is invalidated', async () => {
    const cfg = http('https://mcp.test/mcp')
    const provider = new ClaudeAuthProvider('docs', cfg)
    await expect(provider.codeVerifier()).rejects.toThrow('No code verifier saved')
    await provider.saveCodeVerifier('verifier-1')
    expect(await provider.codeVerifier()).toBe('verifier-1')
    expect(store.read()).toBeNull()
    seed('docs', cfg, { accessToken: '', expiresAt: 0 })
    const before = store.read()
    await provider.invalidateCredentials('verifier')
    await expect(provider.codeVerifier()).rejects.toThrow('No code verifier saved')
    expect(store.read()).toEqual(before)
  })

  test('DEFECT: invalidating the verifier is a no-op while the server has no stored entry', async () => {
    // The early returns for a missing store entry run before the switch, so
    // the in-memory verifier survives an SDK request to drop it.
    const provider = new ClaudeAuthProvider('docs', http('https://mcp.test/mcp'))
    await provider.saveCodeVerifier('verifier-1')
    await provider.invalidateCredentials('verifier')
    expect(await provider.codeVerifier()).toBe('verifier-1')
  })
})

describe('client information', () => {
  test('a registered client is stored under the server key and read back', async () => {
    const cfg = http('https://mcp.test/mcp')
    const provider = new ClaudeAuthProvider('docs', cfg)
    await provider.saveClientInformation({
      client_id: 'dcr-1',
      client_secret: 'dcr-secret',
      redirect_uris: ['http://localhost:3118/callback'],
    })
    expect(entryOf('docs', cfg)).toEqual({
      serverName: 'docs',
      serverUrl: 'https://mcp.test/mcp',
      clientId: 'dcr-1',
      clientSecret: 'dcr-secret',
      accessToken: '',
      expiresAt: 0,
    })
    expect(await provider.clientInformation()).toEqual({ client_id: 'dcr-1', client_secret: 'dcr-secret' })
  })

  test('registering again keeps the tokens already held', async () => {
    const cfg = http('https://mcp.test/mcp')
    seed('docs', cfg, { accessToken: 'kept', expiresAt: 123, refreshToken: 'r' })
    await new ClaudeAuthProvider('docs', cfg).saveClientInformation({ client_id: 'dcr-2', redirect_uris: [] })
    expect(entryOf('docs', cfg)).toMatchObject({ clientId: 'dcr-2', accessToken: 'kept', expiresAt: 123, refreshToken: 'r' })
  })

  test('a pre-configured client id pairs with the secret saved for that server', async () => {
    const cfg = http('https://mcp.test/mcp', { clientId: 'preset' })
    const provider = new ClaudeAuthProvider('docs', cfg)
    expect(await provider.clientInformation()).toEqual({ client_id: 'preset', client_secret: undefined })
    saveMcpClientSecret('docs', cfg, 'typed-secret')
    expect(await provider.clientInformation()).toEqual({ client_id: 'preset', client_secret: 'typed-secret' })
    expect(await new ClaudeAuthProvider('docs', http('https://mcp.test/mcp')).clientInformation()).toBeUndefined()
  })

  test('servers that differ only by URL never see each other\'s client', async () => {
    const a = http('https://a.test/mcp')
    const b = http('https://b.test/mcp')
    await new ClaudeAuthProvider('docs', a).saveClientInformation({ client_id: 'only-a', redirect_uris: [] })
    expect(await new ClaudeAuthProvider('docs', b).clientInformation()).toBeUndefined()
  })
})

describe('tokens', () => {
  test('saved tokens come back as a Bearer set with the time left', async () => {
    const cfg = http('https://mcp.test/mcp')
    const provider = new ClaudeAuthProvider('docs', cfg)
    const before = Date.now()
    await provider.saveTokens({ access_token: 'at', refresh_token: 'rt', expires_in: 1200, scope: 's', token_type: 'Bearer' })
    const entry = entryOf('docs', cfg)
    expect(entry).toMatchObject({ serverName: 'docs', serverUrl: cfg.url, accessToken: 'at', refreshToken: 'rt', scope: 's' })
    expect(entry.expiresAt).toBeGreaterThanOrEqual(before + 1_200_000)
    expect(entry.expiresAt).toBeLessThanOrEqual(Date.now() + 1_200_000)

    const back = await provider.tokens()
    expect(back).toMatchObject({ access_token: 'at', refresh_token: 'rt', scope: 's', token_type: 'Bearer' })
    expect(back!.expires_in).toBeGreaterThan(1190)
    expect(back!.expires_in).toBeLessThanOrEqual(1200)
  })

  test('a token set without a lifetime is assumed to last an hour', async () => {
    const cfg = http('https://mcp.test/mcp')
    const before = Date.now()
    await new ClaudeAuthProvider('docs', cfg).saveTokens({ access_token: 'at', token_type: 'Bearer' })
    expect(entryOf('docs', cfg).expiresAt - before).toBeGreaterThanOrEqual(3_600_000)
    expect(entryOf('docs', cfg).expiresAt - before).toBeLessThan(3_605_000)
  })

  test('there is nothing to send when nothing is stored or the token died without a refresh token', async () => {
    const cfg = http('https://mcp.test/mcp')
    const provider = new ClaudeAuthProvider('docs', cfg)
    expect(await provider.tokens()).toBeUndefined()
    seed('docs', cfg, { accessToken: 'dead', expiresAt: Date.now() - 1000 })
    expect(await provider.tokens()).toBeUndefined()
  })

  test('a pending step-up hides the refresh token unless the held scope already covers it', async () => {
    const cfg = http('https://mcp.test/mcp')
    seed('docs', cfg, { accessToken: 'at', refreshToken: 'rt', scope: 'read', expiresAt: Date.now() + 3_600_000 })
    const cases: [string, string | undefined][] = [
      ['read write', undefined],
      ['read', 'rt'],
    ]
    for (const [wanted, refresh] of cases) {
      const provider = new ClaudeAuthProvider('docs', cfg)
      provider.markStepUpPending(wanted)
      const tokens = await provider.tokens()
      expect(tokens?.access_token).toBe('at')
      expect(tokens?.refresh_token).toBe(refresh)
    }
  })

  test('saving new tokens clears a pending step-up', async () => {
    const cfg = http('https://mcp.test/mcp')
    const provider = new ClaudeAuthProvider('docs', cfg)
    provider.markStepUpPending('admin')
    await provider.saveTokens({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'read', token_type: 'Bearer' })
    expect((await provider.tokens())?.refresh_token).toBe('rt')
  })
})

describe('discovery state', () => {
  test('only the two URLs are persisted, never the metadata documents', async () => {
    const cfg = http('https://mcp.test/mcp')
    seed('docs', cfg, { accessToken: 'at', expiresAt: 77 })
    const provider = new ClaudeAuthProvider('docs', cfg)
    await provider.saveDiscoveryState({
      authorizationServerUrl: 'https://as.test',
      resourceMetadataUrl: 'https://mcp.test/.well-known/oauth-protected-resource/mcp',
      authorizationServerMetadata: { issuer: 'https://as.test', bulky: 'x'.repeat(2000) } as never,
      resourceMetadata: { resource: 'https://mcp.test/mcp' } as never,
    })
    const stored = {
      authorizationServerUrl: 'https://as.test',
      resourceMetadataUrl: 'https://mcp.test/.well-known/oauth-protected-resource/mcp',
    }
    expect(entryOf('docs', cfg)).toMatchObject({ accessToken: 'at', expiresAt: 77 })
    expect(entryOf('docs', cfg).discoveryState).toEqual(stored)
    expect(await provider.discoveryState()).toEqual(stored)
  })

  test('with nothing cached and no configured metadata URL there is no discovery state', async () => {
    expect(await new ClaudeAuthProvider('docs', http('https://mcp.test/mcp')).discoveryState()).toBeUndefined()
  })

  test('a configured metadata URL is fetched when nothing is cached', async () => {
    bed = startAuthBed({}, cert)
    const metadataUrl = `${bed.base}/.well-known/oauth-authorization-server`
    const provider = new ClaudeAuthProvider('docs', http(bed.mcpUrl, { authServerMetadataUrl: metadataUrl }))
    const state = await withSelfSignedTrust(() => provider.discoveryState())
    expect(state?.authorizationServerUrl).toBe(bed.base)
    expect(state?.authorizationServerMetadata?.token_endpoint).toBe(`${bed.base}/token`)
  })

  test('a configured metadata URL that fails yields no discovery state instead of an error', async () => {
    bed = startAuthBed({ metadataAt: 'nowhere' }, cert)
    const metadataUrl = `${bed.base}/.well-known/oauth-authorization-server`
    const provider = new ClaudeAuthProvider('docs', http(bed.mcpUrl, { authServerMetadataUrl: metadataUrl }))
    expect(await withSelfSignedTrust(() => provider.discoveryState())).toBeUndefined()
    expect(bed.hits('/.well-known/oauth-authorization-server')).toHaveLength(1)
  })
})

describe('redirectToAuthorization', () => {
  const authorizeUrl = (scope?: string) => {
    const url = new URL('https://as.test/authorize?client_id=c&state=s')
    if (scope) url.searchParams.set('scope', scope)
    return url
  }

  test('on the transport, the requested scope is remembered for the next sign-in and nothing is opened', async () => {
    const cfg = http('https://mcp.test/mcp')
    seed('docs', cfg, { accessToken: 'at', expiresAt: 1 })
    const seenUrls: string[] = []
    const provider = new ClaudeAuthProvider('docs', cfg, undefined, false, url => seenUrls.push(url))
    await provider.redirectToAuthorization(authorizeUrl('files:write'))
    expect(provider.authorizationUrl).toBe(authorizeUrl('files:write').toString())
    expect(entryOf('docs', cfg).stepUpScope).toBe('files:write')
    expect(seenUrls).toEqual([])
    expect(store.browserUrls()).toEqual([])
  })

  test('on the transport, a URL without scope falls back to the metadata scope', async () => {
    const cfg = http('https://mcp.test/mcp')
    seed('docs', cfg, { accessToken: 'at', expiresAt: 1 })
    const provider = new ClaudeAuthProvider('docs', cfg)
    provider.setMetadata({ issuer: 'https://as.test', scopes_supported: ['m1', 'm2'] } as never)
    await provider.redirectToAuthorization(authorizeUrl())
    expect(entryOf('docs', cfg).stepUpScope).toBe('m1 m2')
  })

  test('on the transport, nothing is written for a server with no stored entry', async () => {
    const provider = new ClaudeAuthProvider('docs', http('https://mcp.test/mcp'))
    await provider.redirectToAuthorization(authorizeUrl('files:write'))
    expect(store.read()).toBeNull()
  })

  test('in an interactive sign-in, the URL is reported and then opened in the browser', async () => {
    const cfg = http('https://mcp.test/mcp')
    seed('docs', cfg, { accessToken: 'at', expiresAt: 1 })
    const reported: string[] = []
    const provider = new ClaudeAuthProvider('docs', cfg, undefined, true, url => reported.push(url))
    await provider.redirectToAuthorization(authorizeUrl('files:write'))
    expect(reported).toEqual([authorizeUrl('files:write').toString()])
    expect(store.browserUrls()).toEqual([authorizeUrl('files:write').toString()])
    expect(entryOf('docs', cfg).stepUpScope).toBeUndefined()
  })

  test('in an interactive sign-in, skipBrowserOpen reports the URL without opening it', async () => {
    const reported: string[] = []
    const provider = new ClaudeAuthProvider('docs', http('https://mcp.test/mcp'), undefined, true, url => reported.push(url), true)
    await provider.redirectToAuthorization(authorizeUrl())
    expect(reported).toHaveLength(1)
    expect(store.browserUrls()).toEqual([])
  })

  test('in an interactive sign-in, a URL that is not http(s) is refused', async () => {
    const reported: string[] = []
    const provider = new ClaudeAuthProvider('docs', http('https://mcp.test/mcp'), undefined, true, url => reported.push(url))
    await expect(provider.redirectToAuthorization(new URL('file:///etc/passwd'))).rejects.toThrow(
      'Invalid authorization URL: must use http:// or https:// scheme',
    )
    expect(reported).toEqual([])
  })
})

describe('invalidateCredentials', () => {
  test('each scope clears its own fields and leaves other servers alone', async () => {
    const cfg = http('https://mcp.test/mcp')
    const other = http('https://other.test/mcp')
    const full = {
      clientId: 'cid',
      clientSecret: 'csec',
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 99,
      scope: 'read',
      stepUpScope: 'write',
      discoveryState: { authorizationServerUrl: 'https://as.test' },
    }
    const cases: [Parameters<ClaudeAuthProvider['invalidateCredentials']>[0], Record<string, unknown> | undefined][] = [
      ['all', undefined],
      ['client', { accessToken: 'at', refreshToken: 'rt', expiresAt: 99, stepUpScope: 'write' }],
      ['tokens', { clientId: 'cid', clientSecret: 'csec', accessToken: '', expiresAt: 0, stepUpScope: 'write' }],
      ['discovery', { clientId: 'cid', accessToken: 'at', refreshToken: 'rt', expiresAt: 99 }],
    ]
    for (const [scope, expected] of cases) {
      store.write({})
      seed('docs', cfg, full)
      seed('docs', other, full)
      await new ClaudeAuthProvider('docs', cfg).invalidateCredentials(scope)
      const entry = entryOf('docs', cfg)
      if (expected === undefined) {
        expect(entry).toBeUndefined()
      } else {
        expect(entry).toMatchObject(expected)
      }
      if (scope === 'client') expect(entry.clientId).toBeUndefined()
      if (scope === 'tokens') expect(entry.refreshToken).toBeUndefined()
      if (scope === 'discovery') {
        expect(entry.discoveryState).toBeUndefined()
        expect(entry.stepUpScope).toBeUndefined()
      }
      expect(entryOf('docs', other)).toMatchObject(full)
    }
  })

  test('with no stored entry it writes nothing', async () => {
    await new ClaudeAuthProvider('docs', http('https://mcp.test/mcp')).invalidateCredentials('all')
    expect(store.read()).toBeNull()
    store.write({ mcpOAuth: {} })
    await new ClaudeAuthProvider('docs', http('https://mcp.test/mcp')).invalidateCredentials('tokens')
    expect(store.read()).toEqual({ mcpOAuth: {} })
  })
})

describe('refresh', () => {
  test('a token within five minutes of expiry is refreshed before it is handed out', async () => {
    for (const persisted of [true, false]) {
      store.write({})
      bed?.stop()
      bed = startAuthBed()
      const cfg = http(bed.mcpUrl)
      signedIn(bed, cfg, 60, persisted ? { discoveryState: { authorizationServerUrl: bed.base } } : {})
      const tokens = await new ClaudeAuthProvider('docs', cfg).tokens()
      expect(tokens?.access_token).toBe('access-1')
      expect(tokens?.refresh_token).toBe('refresh-1')
      expect(entryOf('docs', cfg)).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1', clientId: 'client-seed' })
      const [call] = bed.hits('/token')
      expect(Object.fromEntries(call!.form!)).toEqual({
        grant_type: 'refresh_token',
        refresh_token: 'refresh-seed',
        client_id: 'client-seed',
        resource: bed.mcpUrl,
      })
      expect(bed.hits('/.well-known/oauth-protected-resource/mcp').length > 0).toBe(!persisted)
    }
  })

  test('a token with more than five minutes left is handed out as is', async () => {
    bed = startAuthBed()
    const cfg = http(bed.mcpUrl)
    signedIn(bed, cfg, 400)
    expect((await new ClaudeAuthProvider('docs', cfg).tokens())?.access_token).toBe('access-seed')
    expect(bed.hits('/token')).toHaveLength(0)
  })

  test('a pending step-up skips the refresh even when the token is about to expire', async () => {
    bed = startAuthBed()
    const cfg = http(bed.mcpUrl)
    signedIn(bed, cfg, 60)
    const provider = new ClaudeAuthProvider('docs', cfg)
    provider.markStepUpPending('admin')
    const tokens = await provider.tokens()
    expect(tokens).toMatchObject({ access_token: 'access-seed', refresh_token: undefined })
    expect(bed.hits('/token')).toHaveLength(0)
  })

  test('callers asking at the same time share one refresh', async () => {
    bed = startAuthBed()
    const cfg = http(bed.mcpUrl)
    signedIn(bed, cfg, 10)
    const provider = new ClaudeAuthProvider('docs', cfg)
    const both = await Promise.all([provider.tokens(), provider.tokens()])
    expect(both.map(t => t?.access_token)).toEqual(['access-1', 'access-1'])
    expect(bed.hits('/token')).toHaveLength(1)
  })

  test('tokens another process refreshed in the meantime are used instead of refreshing again', async () => {
    bed = startAuthBed()
    const cfg = http(bed.mcpUrl)
    signedIn(bed, cfg, 3600)
    const tokens = await new ClaudeAuthProvider('docs', cfg).refreshAuthorization('older-refresh')
    expect(tokens).toMatchObject({ access_token: 'access-seed', refresh_token: 'refresh-seed', scope: 'read', token_type: 'Bearer' })
    expect(bed.hits('/token')).toHaveLength(0)
  })

  test('the freshest stored refresh token is the one presented', async () => {
    bed = startAuthBed()
    const cfg = http(bed.mcpUrl)
    signedIn(bed, cfg, 60)
    await new ClaudeAuthProvider('docs', cfg).refreshAuthorization('argument-refresh')
    expect(bed.hits('/token')[0]!.form!.get('refresh_token')).toBe('refresh-seed')
  })

  test('a rejected refresh token clears the stored tokens and keeps the client', async () => {
    const rejections: [string, BedRejection][] = [
      ['standard invalid_grant', () => undefined],
      ['Slack-style 200 with a non-standard code', () => Response.json({ error: 'invalid_refresh_token' })],
      ['200 with expired_refresh_token', () => Response.json({ error: 'expired_refresh_token', error_description: 'gone' })],
    ]
    for (const [label, reply] of rejections) {
      store.write({})
      bed?.stop()
      bed = startAuthBed({ onToken: reply })
      const cfg = http(bed.mcpUrl)
      signedIn(bed, cfg, 60)
      bed.liveRefresh.clear()
      const tokens = await new ClaudeAuthProvider('docs', cfg).tokens()
      expect(tokens?.access_token, label).toBe('access-seed')
      expect(entryOf('docs', cfg), label).toMatchObject({ accessToken: '', expiresAt: 0, clientId: 'client-seed' })
      expect(entryOf('docs', cfg).refreshToken, label).toBeUndefined()
      expect(bed.hits('/token'), label).toHaveLength(1)
    }
  })

  test('a rejected refresh defers to fresh tokens another process stored meanwhile', async () => {
    bed = startAuthBed()
    const cfg = http(bed.mcpUrl)
    signedIn(bed, cfg, 60)
    bed.liveRefresh.clear()
    bed.config.onToken = () => {
      seed('docs', cfg, { clientId: 'client-seed', accessToken: 'from-elsewhere', refreshToken: 'r2', expiresAt: Date.now() + 3_600_000 })
      return undefined
    }
    const tokens = await new ClaudeAuthProvider('docs', cfg).refreshAuthorization('refresh-seed')
    expect(tokens).toMatchObject({ access_token: 'from-elsewhere', refresh_token: 'r2' })
    expect(entryOf('docs', cfg).accessToken).toBe('from-elsewhere')
  })

  test('a transient token-endpoint failure is retried with backoff', async () => {
    bed = startAuthBed({
      onToken: (_form, attempt) =>
        attempt <= 2 ? Response.json({ error: 'temporarily_unavailable' }, { status: 503 }) : undefined,
    })
    const cfg = http(bed.mcpUrl)
    signedIn(bed, cfg, 60)
    const started = Date.now()
    const tokens = await new ClaudeAuthProvider('docs', cfg).refreshAuthorization('refresh-seed')
    expect(tokens?.access_token).toBe('access-1')
    expect(bed.hits('/token')).toHaveLength(3)
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000)
  }, 15_000)

  test('a non-transient failure gives up at once and leaves the store alone', async () => {
    bed = startAuthBed({ onToken: () => Response.json({ error: 'invalid_request' }, { status: 400 }) })
    const cfg = http(bed.mcpUrl)
    signedIn(bed, cfg, 60)
    expect(await new ClaudeAuthProvider('docs', cfg).refreshAuthorization('refresh-seed')).toBeUndefined()
    expect(bed.hits('/token')).toHaveLength(1)
    expect(entryOf('docs', cfg).accessToken).toBe('access-seed')
  })

  test('without client information or discoverable metadata no token request is made', async () => {
    bed = startAuthBed()
    const cfg = http(bed.mcpUrl)
    seed('docs', cfg, { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60_000 })
    expect(await new ClaudeAuthProvider('docs', cfg).refreshAuthorization('r')).toBeUndefined()

    bed.stop()
    bed = startAuthBed({ protectedResource: false, metadataAt: 'nowhere' })
    const bare = http(bed.mcpUrl)
    signedIn(bed, bare, 60)
    expect(await new ClaudeAuthProvider('docs', bare).refreshAuthorization('refresh-seed')).toBeUndefined()
    expect(bed.hits('/token')).toHaveLength(0)
  })

  test('a configured metadata URL is where a refresh finds the token endpoint', async () => {
    bed = startAuthBed({ protectedResource: false, metadataAt: 'nowhere' }, cert)
    const other = startAuthBed({}, cert)
    try {
      const cfg = http(bed.mcpUrl, { authServerMetadataUrl: `${other.base}/.well-known/oauth-authorization-server` })
      signedIn(other, cfg, 60)
      const tokens = await withSelfSignedTrust(() => new ClaudeAuthProvider('docs', cfg).refreshAuthorization('refresh-seed'))
      expect(tokens?.access_token).toBe('access-1')
      expect(other.hits('/token')).toHaveLength(1)
    } finally {
      other.stop()
    }
  })

  test('refreshes are serialised across processes by a lock file in the config dir', async () => {
    bed = startAuthBed()
    const cfg = http(bed.mcpUrl)
    signedIn(bed, cfg, 60)
    const key = getServerKey('docs', cfg).replace(/[^a-zA-Z0-9]/g, '_')
    const release = await lockfile.lock(join(store.configDir(), `mcp-refresh-${key}.lock`), { realpath: false })
    let releasedAt = 0
    setTimeout(() => {
      releasedAt = Date.now()
      void release()
    }, 300)
    const tokens = await new ClaudeAuthProvider('docs', cfg).refreshAuthorization('refresh-seed')
    expect(tokens?.access_token).toBe('access-1')
    expect(releasedAt).toBeGreaterThan(0)
  }, 10_000)

  test('a lock that cannot be created does not stop the refresh', async () => {
    bed = startAuthBed()
    const cfg = http(bed.mcpUrl)
    signedIn(bed, cfg, 60)
    chmodSync(store.configDir(), 0o555)
    const tokens = await new ClaudeAuthProvider('docs', cfg).refreshAuthorization('refresh-seed')
    expect(tokens?.access_token).toBe('access-1')
    // The credential file itself is still writable, so the new set is kept.
    expect(entryOf('docs', cfg).accessToken).toBe('access-1')
  })
})

type BedRejection = () => Response | undefined
