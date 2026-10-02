/**
 * ClaudeAuthProvider behaviour the characterization suite does not reach:
 * the verifier fix, the in-process refresh sharing, the refresh give-up
 * paths, and the edges of scope and discovery handling.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeAuthProvider, getScopeFromMetadata, getServerKey } from 'src/mcp/auth.js'
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

const entryOf = (cfg: McpHTTPServerConfig) => store.read()?.mcpOAuth?.[getServerKey('docs', cfg)]

function seed(cfg: McpHTTPServerConfig, entry: Record<string, unknown>): void {
  const current = store.read() ?? {}
  store.write({
    ...current,
    mcpOAuth: {
      ...current.mcpOAuth,
      [getServerKey('docs', cfg)]: { serverName: 'docs', serverUrl: cfg.url, ...entry },
    },
  })
}

function signedIn(b: AuthBed, cfg: McpHTTPServerConfig, secondsLeft: number): void {
  b.clients.set('client-seed', undefined)
  b.liveRefresh.add('refresh-seed')
  seed(cfg, {
    clientId: 'client-seed',
    accessToken: 'access-seed',
    refreshToken: 'refresh-seed',
    expiresAt: Date.now() + secondsLeft * 1000,
    scope: 'read',
  })
}

describe('the code verifier', () => {
  test('is dropped on request even when nothing is stored for the server, and nothing is written', async () => {
    const provider = new ClaudeAuthProvider('docs', http('https://mcp.test/mcp'))
    await provider.saveCodeVerifier('verifier-1')
    await provider.invalidateCredentials('verifier')
    await expect(provider.codeVerifier()).rejects.toThrow('No code verifier saved')
    expect(store.read()).toBeNull()
  })

  test('survives invalidating everything else, so the SDK can retry an exchange', async () => {
    const cfg = http('https://mcp.test/mcp')
    seed(cfg, { accessToken: 'at', expiresAt: 1 })
    const provider = new ClaudeAuthProvider('docs', cfg)
    await provider.saveCodeVerifier('verifier-1')
    await provider.invalidateCredentials('all')
    expect(entryOf(cfg)).toBeUndefined()
    expect(await provider.codeVerifier()).toBe('verifier-1')
  })
})

describe('refresh', () => {
  test('concurrent callers share one refresh even when the cross-process lock is unavailable', async () => {
    bed = startAuthBed()
    const cfg = http(bed.mcpUrl)
    signedIn(bed, cfg, 10)
    chmodSync(store.configDir(), 0o555)
    const provider = new ClaudeAuthProvider('docs', cfg)
    const both = await Promise.all([provider.tokens(), provider.tokens()])
    expect(both.map(t => t?.access_token)).toEqual(['access-1', 'access-1'])
    expect(bed.hits('/token')).toHaveLength(1)
  })

  test('without client information no token request is made', async () => {
    bed = startAuthBed()
    const cfg = http(bed.mcpUrl)
    bed.liveRefresh.add('r')
    seed(cfg, { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60_000 })
    expect(await new ClaudeAuthProvider('docs', cfg).refreshAuthorization('r')).toBeUndefined()
    expect(bed.hits('/token')).toHaveLength(0)
  })

  test('a refreshed token set that omits scope keeps the scope already granted', async () => {
    bed = startAuthBed()
    const cfg = http(bed.mcpUrl)
    signedIn(bed, cfg, 60)
    const tokens = await new ClaudeAuthProvider('docs', cfg).tokens()
    expect(tokens?.access_token).toBe('access-1')
    expect(entryOf(cfg)).toMatchObject({ accessToken: 'access-1', scope: 'read' })
  })

  test('transient failures give up after the last attempt and leave the store alone', async () => {
    bed = startAuthBed({ onToken: () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 }) })
    const cfg = http(bed.mcpUrl)
    signedIn(bed, cfg, 60)
    expect(await new ClaudeAuthProvider('docs', cfg).refreshAuthorization('refresh-seed')).toBeUndefined()
    expect(bed.hits('/token')).toHaveLength(3)
    expect(entryOf(cfg)).toMatchObject({ accessToken: 'access-seed', refreshToken: 'refresh-seed' })
  }, 15_000)
})

describe('discovery state', () => {
  test('cached URLs come back with the configured metadata attached', async () => {
    bed = startAuthBed({}, cert)
    const metadataUrl = `${bed.base}/.well-known/oauth-authorization-server`
    const cfg = http(bed.mcpUrl, { authServerMetadataUrl: metadataUrl })
    seed(cfg, { accessToken: '', expiresAt: 0, discoveryState: { authorizationServerUrl: 'https://as.test' } })
    const state = await withSelfSignedTrust(() => new ClaudeAuthProvider('docs', cfg).discoveryState())
    expect(state?.authorizationServerUrl).toBe('https://as.test')
    expect(state?.authorizationServerMetadata?.token_endpoint).toBe(`${bed.base}/token`)
  })

  test('saving discovery state creates the entry for a server not seen before', async () => {
    const cfg = http('https://mcp.test/mcp')
    await new ClaudeAuthProvider('docs', cfg).saveDiscoveryState({ authorizationServerUrl: 'https://as.test' })
    expect(entryOf(cfg)).toEqual({
      serverName: 'docs',
      serverUrl: cfg.url,
      accessToken: '',
      expiresAt: 0,
      discoveryState: { authorizationServerUrl: 'https://as.test' },
    })
  })
})

describe('scope', () => {
  test('empty scope fields in metadata count as absent', () => {
    const metadata = (fields: Record<string, unknown>) =>
      fields as unknown as NonNullable<Parameters<typeof getScopeFromMetadata>[0]>
    expect(getScopeFromMetadata(metadata({ scope: '', default_scope: 'd' }))).toBe('d')
    expect(getScopeFromMetadata(metadata({ scopes_supported: [] }))).toBeUndefined()
  })

  test('on the transport, a redirect naming no scope anywhere writes nothing', async () => {
    const cfg = http('https://mcp.test/mcp')
    seed(cfg, { accessToken: 'at', expiresAt: 1 })
    const before = store.read()
    await new ClaudeAuthProvider('docs', cfg).redirectToAuthorization(new URL('https://as.test/authorize?state=s'))
    expect(store.read()).toEqual(before)
  })

  test('a step-up the held scope already covers still refreshes a token about to expire', async () => {
    bed = startAuthBed()
    const cfg = http(bed.mcpUrl)
    signedIn(bed, cfg, 60)
    const provider = new ClaudeAuthProvider('docs', cfg)
    provider.markStepUpPending('read')
    expect((await provider.tokens())?.access_token).toBe('access-1')
  })
})
