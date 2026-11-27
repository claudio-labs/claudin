import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { Server } from 'bun'
import { createServer as createNetServer, type Server as NetServer } from 'net'
import { ClaudeAuthProvider } from 'src/mcp/auth/claudeAuthProvider.js'
import {
  AuthenticationCancelledError,
  performMCPOAuthFlow,
  wrapFetchWithStepUpDetection,
} from 'src/mcp/auth/oauthFlow.js'
import { getServerKey } from 'src/mcp/auth/serverKey.js'
import type { McpHTTPServerConfig } from 'src/mcp/types.js'
import {
  _setSecureStorageForTesting,
  type SecureStorageData,
} from 'src/platform/secureStorage/index.js'

// performMCPOAuthFlow end to end: a local authorization server on 127.0.0.1,
// an in-memory secure storage, the browser never opened (skipBrowserOpen),
// and the loopback callback hit with fetch the way a browser would.

type Recorded = { method: string; path: string; body: string }
type Entry = NonNullable<SecureStorageData['mcpOAuth']>[string]

let stored: SecureStorageData = {}
let requests: Recorded[] = []
let tokenResponse: () => Response
let registerStatus = 201

const as: Server<undefined> = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url)
    const body = req.method === 'GET' ? '' : await req.text()
    requests.push({ method: req.method, path: url.pathname, body })
    const origin = `http://127.0.0.1:${as.port}`
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] })
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      return Response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      })
    }
    if (url.pathname === '/register') {
      if (registerStatus !== 201) return new Response('boom', { status: registerStatus })
      return Response.json(
        { ...(JSON.parse(body) as object), client_id: 'flow-client', client_secret: 'flow-secret' },
        { status: 201 },
      )
    }
    if (url.pathname === '/token') return tokenResponse()
    return new Response('not found', { status: 404 })
  },
})

const origin = (): string => `http://127.0.0.1:${as.port}`
const config = (extra: Partial<McpHTTPServerConfig> = {}): McpHTTPServerConfig => ({
  type: 'http',
  url: `${origin()}/mcp`,
  ...extra,
})
const SERVER = 'cover'
const entryFor = (cfg: McpHTTPServerConfig): Entry | undefined =>
  stored.mcpOAuth?.[getServerKey(SERVER, cfg)]

beforeAll(() => {
  _setSecureStorageForTesting({
    name: 'memory',
    read: () => structuredClone(stored),
    readAsync: async () => structuredClone(stored),
    update: data => {
      stored = structuredClone(data)
      return { success: true }
    },
    delete: () => true,
  })
})

afterAll(() => {
  _setSecureStorageForTesting(null)
  as.stop(true)
})

beforeEach(() => {
  stored = {}
  requests = []
  registerStatus = 201
  tokenResponse = () =>
    Response.json({ access_token: 'fresh-at', refresh_token: 'fresh-rt', token_type: 'Bearer', expires_in: 3600 })
})

/** Starts the flow and exposes the authorization URL once the SDK produced it. */
function startFlow(
  cfg: McpHTTPServerConfig,
  opts: { signal?: AbortSignal; onWaitingForCallback?: (submit: (u: string) => void) => void } = {},
): { done: Promise<void>; authUrl: Promise<URL> } {
  let resolveUrl: (u: URL) => void = () => {}
  const authUrl = new Promise<URL>(r => {
    resolveUrl = r
  })
  const done = performMCPOAuthFlow(SERVER, cfg, u => resolveUrl(new URL(u)), opts.signal, {
    skipBrowserOpen: true,
    onWaitingForCallback: opts.onWaitingForCallback,
  })
  // Mark it handled: some tests reject it before they reach their `expect`.
  done.catch(() => {})
  return { done, authUrl }
}

/** The loopback callback, reached on 127.0.0.1 at the redirect_uri's port. */
function callbackUrl(authUrl: URL, query: string): string {
  const redirect = new URL(authUrl.searchParams.get('redirect_uri') ?? '')
  return `http://127.0.0.1:${redirect.port}/callback?${query}`
}

describe('performMCPOAuthFlow over the loopback callback', () => {
  test('a valid callback answers success, exchanges the code with the PKCE verifier and stores the tokens', async () => {
    const cfg = config()
    const ctrl = new AbortController()
    const { done, authUrl } = startFlow(cfg, { signal: ctrl.signal })
    const url = await authUrl
    expect(url.origin + url.pathname).toBe(`${origin()}/authorize`)
    expect(url.searchParams.get('client_id')).toBe('flow-client')
    const redirect = url.searchParams.get('redirect_uri') ?? ''
    expect(redirect).toMatch(/^http:\/\/localhost:\d+\/callback$/)

    const res = await fetch(callbackUrl(url, `code=the-code&state=${url.searchParams.get('state')}`))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Authentication Successful')
    await done

    const token = requests.find(r => r.path === '/token')
    const form = new URLSearchParams(token?.body)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('the-code')
    expect(form.get('redirect_uri')).toBe(redirect)
    expect(form.get('code_verifier')?.length).toBeGreaterThan(20)
    const entry = entryFor(cfg)
    expect(entry?.accessToken).toBe('fresh-at')
    expect(entry?.refreshToken).toBe('fresh-rt')
    expect(entry?.clientId).toBe('flow-client')
    // Aborting after success is a no-op: the flow already settled.
    ctrl.abort()
  })

  test('a wrong state and a callback without a code answer 400 and leave the flow waiting', async () => {
    const cfg = config()
    const { done, authUrl } = startFlow(cfg)
    const url = await authUrl
    const state = url.searchParams.get('state') ?? ''

    const mismatch = await fetch(callbackUrl(url, 'code=x&state=forged'))
    expect(mismatch.status).toBe(400)
    expect(await mismatch.text()).toContain('Invalid state parameter')

    const missing = await fetch(callbackUrl(url, `state=${state}`))
    expect(missing.status).toBe(400)
    expect(await missing.text()).toContain('Missing OAuth result')

    expect(requests.some(r => r.path === '/token')).toBe(false)
    const ok = await fetch(callbackUrl(url, `code=late&state=${state}`))
    expect(ok.status).toBe(200)
    await done
    expect(new URLSearchParams(requests.find(r => r.path === '/token')?.body).get('code')).toBe('late')
  })

  test('an error callback renders the sanitized error and rejects with the OAuth message', async () => {
    const { done, authUrl } = startFlow(config())
    const url = await authUrl
    const state = url.searchParams.get('state') ?? ''
    const desc = encodeURIComponent('<script>alert(1)</script>')
    const res = await fetch(callbackUrl(url, `error=access_denied&error_description=${desc}&state=${state}`))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Authentication Error')
    expect(html).toContain('access_denied')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    await expect(done).rejects.toThrow('OAuth error: access_denied - <script>alert(1)</script>')
    expect(requests.some(r => r.path === '/token')).toBe(false)
  })
})

describe('performMCPOAuthFlow with a pasted callback URL', () => {
  test('garbage, a forged state and a code-less URL are ignored; an error URL rejects', async () => {
    let submit: (u: string) => void = () => {}
    const { done, authUrl } = startFlow(config(), { onWaitingForCallback: s => (submit = s) })
    const url = await authUrl
    const state = url.searchParams.get('state') ?? ''
    submit('not a url')
    submit('http://localhost:1/callback?code=x&state=forged')
    submit(`http://localhost:1/callback?state=${state}`)
    submit(`http://localhost:1/callback?error=access_denied&error_description=nope&state=${state}`)
    await expect(done).rejects.toThrow(/^OAuth error: access_denied - nope$/)
    expect(requests.some(r => r.path === '/token')).toBe(false)
  })

  test('a pasted URL with the right state completes the flow and closes the callback server', async () => {
    let submit: (u: string) => void = () => {}
    const cfg = config()
    const { done, authUrl } = startFlow(cfg, { onWaitingForCallback: s => (submit = s) })
    const url = await authUrl
    submit(`http://localhost:1/callback?code=pasted&state=${url.searchParams.get('state')}`)
    await done
    expect(new URLSearchParams(requests.find(r => r.path === '/token')?.body).get('code')).toBe('pasted')
    expect(entryFor(cfg)?.accessToken).toBe('fresh-at')
    await expect(fetch(callbackUrl(url, 'code=x&state=y'))).rejects.toThrow()
  })
})

describe('performMCPOAuthFlow cancellation and failures', () => {
  test('an already-aborted signal rejects before the authorization request is built', async () => {
    const cfg = config()
    stored = { mcpOAuth: { [getServerKey(SERVER, cfg)]: { serverName: SERVER, serverUrl: cfg.url, accessToken: 'stale', expiresAt: 1 } } }
    const ctrl = new AbortController()
    ctrl.abort()
    const { done } = startFlow(cfg, { signal: ctrl.signal })
    await expect(done).rejects.toBeInstanceOf(AuthenticationCancelledError)
    expect(requests.some(r => r.path === '/register')).toBe(false)
    // The stored entry is cleared up front, before any cancellation check.
    expect(entryFor(cfg)).toBeUndefined()
  })

  test('aborting while waiting rejects as cancelled and closes the callback server', async () => {
    const ctrl = new AbortController()
    const { done, authUrl } = startFlow(config(), { signal: ctrl.signal })
    const url = await authUrl
    ctrl.abort()
    await expect(done).rejects.toThrow('Authentication was cancelled')
    await expect(fetch(callbackUrl(url, 'code=x&state=y'))).rejects.toThrow()
  })

  test('a callback port already in use rejects with the command that finds the holder', async () => {
    const holder: NetServer = createNetServer()
    await new Promise<void>(r => holder.listen(0, '127.0.0.1', () => r()))
    const port = (holder.address() as { port: number }).port
    try {
      const { done } = startFlow(config({ oauth: { callbackPort: port } }))
      await expect(done).rejects.toThrow(
        `OAuth callback port ${port} is already in use — another process may be holding it. Run \`lsof -ti:${port} -sTCP:LISTEN\` to find it.`,
      )
    } finally {
      holder.close()
    }
  })

  test('a failing initial SDK auth call rejects with "SDK auth failed"', async () => {
    registerStatus = 500
    const { done } = startFlow(config())
    await expect(done).rejects.toThrow(/^SDK auth failed: /)
  })

  test('a registered client rejected as invalid_client: the SDK wipes the entry and its retry fails without a client', async () => {
    // SDK 1.x auth() catches InvalidClientError, invalidates 'all' and retries;
    // the retry has no client to exchange the code with, so the OAuthError never
    // reaches the flow's own "Client not found" cleanup.
    tokenResponse = () =>
      Response.json({ error: 'invalid_client', error_description: 'Client not found' }, { status: 400 })
    const cfg = config()
    const { done, authUrl } = startFlow(cfg)
    const url = await authUrl
    await fetch(callbackUrl(url, `code=c&state=${url.searchParams.get('state')}`))
    await expect(done).rejects.toThrow(
      'Existing OAuth client information is required when exchanging an authorization code',
    )
    expect(requests.filter(r => r.path === '/token')).toHaveLength(1)
    expect(requests.filter(r => r.path === '/register')).toHaveLength(1)
    expect(entryFor(cfg)?.clientId).toBeUndefined()
  })

  /**
   * A pre-configured client survives the SDK's invalidate-and-retry, so the
   * retry's InvalidClientError reaches the flow. The token endpoint stands in
   * for another process that stored a DCR client meanwhile, which is what the
   * flow's cleanup removes.
   */
  function configuredClientRejectedWith(description: string): McpHTTPServerConfig {
    const cfg = config({ oauth: { clientId: 'configured-client' } })
    tokenResponse = () => {
      const entry = stored.mcpOAuth?.[getServerKey(SERVER, cfg)]
      if (entry) {
        entry.clientId = 'dcr-client'
        entry.clientSecret = 'dcr-secret'
      }
      return Response.json({ error: 'invalid_client', error_description: description }, { status: 400 })
    }
    return cfg
  }

  test('"Client not found" for a configured client drops the stored client id and secret, and rethrows', async () => {
    const cfg = configuredClientRejectedWith('Client not found')
    const { done, authUrl } = startFlow(cfg)
    const url = await authUrl
    expect(url.searchParams.get('client_id')).toBe('configured-client')
    await fetch(callbackUrl(url, `code=c&state=${url.searchParams.get('state')}`))
    await expect(done).rejects.toThrow('Client not found')
    expect(requests.filter(r => r.path === '/token')).toHaveLength(2)
    const entry = entryFor(cfg)
    expect(entry).toBeDefined()
    expect(entry?.clientId).toBeUndefined()
    expect(entry?.clientSecret).toBeUndefined()
  })

  test('another invalid_client description keeps the stored client', async () => {
    const cfg = configuredClientRejectedWith('Client is disabled')
    const { done, authUrl } = startFlow(cfg)
    const url = await authUrl
    await fetch(callbackUrl(url, `code=c&state=${url.searchParams.get('state')}`))
    await expect(done).rejects.toThrow('Client is disabled')
    expect(entryFor(cfg)?.clientId).toBe('dcr-client')
    expect(entryFor(cfg)?.clientSecret).toBe('dcr-secret')
  })
})

describe('performMCPOAuthFlow cached step-up state', () => {
  test('a cached step-up scope and resource metadata URL drive the new authorization', async () => {
    const cfg = config()
    stored = {
      mcpOAuth: {
        [getServerKey(SERVER, cfg)]: {
          serverName: SERVER,
          serverUrl: cfg.url,
          accessToken: 'old',
          expiresAt: 1,
          stepUpScope: 'read admin',
          discoveryState: {
            authorizationServerUrl: origin(),
            resourceMetadataUrl: `${origin()}/.well-known/oauth-protected-resource/custom`,
          },
        },
      },
    }
    const ctrl = new AbortController()
    const { done, authUrl } = startFlow(cfg, { signal: ctrl.signal })
    const url = await authUrl
    expect(url.searchParams.get('scope')).toBe('read admin')
    expect(requests.some(r => r.path === '/.well-known/oauth-protected-resource/custom')).toBe(true)
    ctrl.abort()
    await expect(done).rejects.toBeInstanceOf(AuthenticationCancelledError)
    // The old entry (and its step-up scope) was cleared at the start.
    expect(entryFor(cfg)?.stepUpScope).toBeUndefined()
    expect(entryFor(cfg)?.accessToken).not.toBe('old')
  })

  test('an unparsable cached resource metadata URL is ignored rather than failing the flow', async () => {
    const cfg = config()
    stored = {
      mcpOAuth: {
        [getServerKey(SERVER, cfg)]: {
          serverName: SERVER,
          serverUrl: cfg.url,
          accessToken: 'old',
          expiresAt: 1,
          discoveryState: { authorizationServerUrl: origin(), resourceMetadataUrl: 'not a url' },
        },
      },
    }
    const ctrl = new AbortController()
    const { done, authUrl } = startFlow(cfg, { signal: ctrl.signal })
    const url = await authUrl
    expect(url.pathname).toBe('/authorize')
    expect(requests.some(r => r.path === '/.well-known/oauth-protected-resource/mcp')).toBe(true)
    ctrl.abort()
    await expect(done).rejects.toBeInstanceOf(AuthenticationCancelledError)
  })

  test('a configured metadata URL that cannot be fetched does not stop the flow', async () => {
    const cfg = config({ oauth: { authServerMetadataUrl: `${origin()}/insecure-metadata` } })
    const ctrl = new AbortController()
    const { done, authUrl } = startFlow(cfg, { signal: ctrl.signal })
    const url = await authUrl
    expect(url.pathname).toBe('/authorize')
    // http:// is refused before any request, so the configured URL is never fetched.
    expect(requests.some(r => r.path === '/insecure-metadata')).toBe(false)
    ctrl.abort()
    await expect(done).rejects.toBeInstanceOf(AuthenticationCancelledError)
  })
})

describe('wrapFetchWithStepUpDetection', () => {
  const provider = new ClaudeAuthProvider('stepup', { type: 'http', url: 'https://mcp.example.com/mcp' }, 'http://localhost:1/callback')
  let mark: ReturnType<typeof spyOn>

  beforeEach(() => {
    mark = spyOn(provider, 'markStepUpPending')
  })
  afterEach(() => {
    mark.mockRestore()
  })

  const wrapped = (res: Response) => wrapFetchWithStepUpDetection(async () => res, provider)

  test('a 403 insufficient_scope with a quoted scope marks step-up and passes the response through', async () => {
    const res = new Response('no', {
      status: 403,
      headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="read admin"' },
    })
    expect(await wrapped(res)('https://x', undefined)).toBe(res)
    expect(mark).toHaveBeenCalledWith('read admin')
  })

  test('an unquoted scope is read too', async () => {
    const res = new Response('no', {
      status: 403,
      headers: { 'WWW-Authenticate': 'Bearer error=insufficient_scope, scope=admin' },
    })
    await wrapped(res)('https://x', undefined)
    expect(mark).toHaveBeenCalledWith('admin')
  })

  test('a 403 without insufficient_scope, one without a scope, and a 401 mark nothing', async () => {
    await wrapped(new Response('', { status: 403, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token", scope="a"' } }))('https://x', undefined)
    await wrapped(new Response('', { status: 403, headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope"' } }))('https://x', undefined)
    await wrapped(new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="a"' } }))('https://x', undefined)
    await wrapped(new Response('', { status: 403 }))('https://x', undefined)
    expect(mark).not.toHaveBeenCalled()
  })

  test('the marked scope makes tokens() withhold the refresh token', async () => {
    const cfg: McpHTTPServerConfig = { type: 'http', url: 'https://mcp.example.com/mcp' }
    const p = new ClaudeAuthProvider('stepup2', cfg, 'http://localhost:1/callback')
    stored = {
      mcpOAuth: {
        [getServerKey('stepup2', cfg)]: {
          serverName: 'stepup2',
          serverUrl: cfg.url,
          accessToken: 'at',
          refreshToken: 'rt',
          scope: 'read',
          expiresAt: Date.now() + 3_600_000,
        },
      },
    }
    expect((await p.tokens())?.refresh_token).toBe('rt')
    const res = new Response('', { status: 403, headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="read admin"' } })
    await wrapFetchWithStepUpDetection(async () => res, p)('https://x', undefined)
    expect((await p.tokens())?.refresh_token).toBeUndefined()
  })
})
