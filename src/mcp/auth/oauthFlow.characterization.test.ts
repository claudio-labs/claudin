/**
 * The interactive MCP sign-in, driven end to end against a real authorization
 * server on loopback: dynamic registration, the loopback callback server and
 * its pages, the manual-paste fallback, cancellation, and the step-up
 * detection that rides on the transport's fetch.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { InvalidClientError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import {
  AuthenticationCancelledError,
  ClaudeAuthProvider,
  getServerKey,
  performMCPOAuthFlow,
  saveMcpClientSecret,
  wrapFetchWithStepUpDetection,
} from 'src/mcp/auth.js'
import {
  type AuthBed,
  approveInBrowser,
  startAuthBed,
  useIsolatedStore,
  visit,
} from 'src/mcp/auth/__testutils__/oauthTestBed.js'
import type { McpHTTPServerConfig } from 'src/mcp/types.js'

const store = useIsolatedStore()
let bed: AuthBed | undefined
const extraServers: Server[] = []
afterEach(() => {
  bed?.stop()
  bed = undefined
  for (const s of extraServers.splice(0)) s.close()
})

const http = (url: string, oauth?: McpHTTPServerConfig['oauth']): McpHTTPServerConfig => ({
  type: 'http',
  url,
  ...(oauth ? { oauth } : {}),
})

const entryOf = (cfg: McpHTTPServerConfig) => store.read()?.mcpOAuth?.[getServerKey('docs', cfg)]

/** A loopback port nothing listens on right now. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>(done => probe.close(() => done()))
  return port
}

/** Signs in, approving in the "browser" as soon as the URL is reported. */
async function signIn(cfg: McpHTTPServerConfig) {
  let authorizeUrl = ''
  let page: ReturnType<typeof approveInBrowser> | undefined
  await performMCPOAuthFlow(
    'docs',
    cfg,
    url => {
      authorizeUrl = url
      page = approveInBrowser(url)
    },
    undefined,
    { skipBrowserOpen: true },
  )
  return { authorizeUrl: new URL(authorizeUrl), page: await page! }
}

describe('a full sign-in', () => {
  test('registers a client, exchanges the code with PKCE and stores the result', async () => {
    bed = startAuthBed()
    const cfg = http(bed.mcpUrl)
    store.write({
      mcpOAuth: {
        [getServerKey('docs', cfg)]: { serverName: 'docs', serverUrl: cfg.url, clientId: 'stale', accessToken: 'stale', expiresAt: 1 },
      },
    })

    const { authorizeUrl, page } = await signIn(cfg)

    expect(page.status).toBe(200)
    expect(page.html).toContain('Authentication Successful')
    expect(page.html).toContain('Return to Claudin.')

    const redirect = authorizeUrl.searchParams.get('redirect_uri')!
    expect(redirect).toMatch(/^http:\/\/localhost:\d+\/callback$/)
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(`${bed.base}/authorize`)
    expect(Object.fromEntries(authorizeUrl.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client-1',
      code_challenge_method: 'S256',
      resource: bed.mcpUrl,
    })
    expect(authorizeUrl.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const [registration] = bed.hits('/register')
    expect(registration!.body).toMatchObject({
      client_name: 'Claudin (docs)',
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
    })

    const [exchange] = bed.hits('/token')
    expect(exchange!.form!.get('grant_type')).toBe('authorization_code')
    expect(exchange!.form!.get('redirect_uri')).toBe(redirect)

    expect(entryOf(cfg)).toMatchObject({
      serverName: 'docs',
      serverUrl: cfg.url,
      clientId: 'client-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      discoveryState: { authorizationServerUrl: bed.base },
    })

    // The callback server is gone once the code is in.
    await expect(fetch(redirect)).rejects.toThrow()
  })

  test('the callback listens on the configured port, or the one from the environment', async () => {
    for (const via of ['config', 'env'] as const) {
      store.write({})
      bed?.stop()
      bed = startAuthBed()
      const port = await freePort()
      if (via === 'env') process.env.MCP_OAUTH_CALLBACK_PORT = String(port)
      const cfg = http(bed.mcpUrl, via === 'config' ? { callbackPort: port } : undefined)
      const { authorizeUrl } = await signIn(cfg)
      expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(`http://localhost:${port}/callback`)
    }
  })

  test('scopes the server metadata names are requested at registration and authorization', async () => {
    bed = startAuthBed({ metadataExtra: { scopes_supported: ['docs.read', 'docs.write'] } })
    const { authorizeUrl } = await signIn(http(bed.mcpUrl))
    expect(authorizeUrl.searchParams.get('scope')).toBe('docs.read docs.write')
    expect(bed.hits('/register')[0]!.body).toMatchObject({ scope: 'docs.read docs.write' })
  })

  test('a step-up scope cached by the transport is what the next sign-in asks for', async () => {
    bed = startAuthBed()
    const cfg = http(bed.mcpUrl)
    const prm = `${bed.base}/.well-known/oauth-protected-resource/mcp`
    const cases: [string, number][] = [
      [prm, 1],
      ['not a url', 1],
    ]
    for (const [resourceMetadataUrl, minimumPrmHits] of cases) {
      store.write({
        mcpOAuth: {
          [getServerKey('docs', cfg)]: {
            serverName: 'docs',
            serverUrl: cfg.url,
            accessToken: '',
            expiresAt: 0,
            stepUpScope: 'docs.admin',
            discoveryState: { authorizationServerUrl: bed.base, resourceMetadataUrl },
          },
        },
      })
      const { authorizeUrl } = await signIn(cfg)
      expect(authorizeUrl.searchParams.get('scope')).toBe('docs.admin')
      expect(bed.hits('/.well-known/oauth-protected-resource/mcp').length).toBeGreaterThanOrEqual(minimumPrmHits)
      expect(entryOf(cfg).stepUpScope).toBeUndefined()
    }
  })

  test('a configured metadata URL that cannot be used does not stop the sign-in', async () => {
    bed = startAuthBed()
    const cfg = http(bed.mcpUrl, { authServerMetadataUrl: `${bed.base}/.well-known/oauth-authorization-server` })
    const { page } = await signIn(cfg)
    expect(page.html).toContain('Authentication Successful')
    expect(entryOf(cfg)?.accessToken).toBe('access-1')
  })

  test('a pre-configured client skips registration and authenticates with its saved secret', async () => {
    bed = startAuthBed()
    const cfg = http(bed.mcpUrl, { clientId: 'preset' })
    saveMcpClientSecret('docs', cfg, 'typed secret')
    const { authorizeUrl } = await signIn(cfg)
    expect(authorizeUrl.searchParams.get('client_id')).toBe('preset')
    expect(bed.hits('/register')).toHaveLength(0)
    const [exchange] = bed.hits('/token')
    expect(exchange!.authorization).toBe(`Basic ${btoa('preset:typed secret')}`)
    expect(store.read()!.mcpOAuthClientConfig[getServerKey('docs', cfg)]).toEqual({ clientSecret: 'typed secret' })
  })
})

describe('the callback server', () => {
  test('answers a bad visit with an error page and keeps waiting for the real one', async () => {
    bed = startAuthBed()
    const pages: { status: number; html: string }[] = []
    await performMCPOAuthFlow(
      'docs',
      http(bed.mcpUrl),
      url => {
        void (async () => {
          const authorize = new URL(url)
          const callback = authorize.searchParams.get('redirect_uri')!
          const state = authorize.searchParams.get('state')!
          for (const query of ['?code=forged&state=wrong', '?code=forged', `?state=${state}`]) {
            pages.push(await visit(callback + query))
          }
          await approveInBrowser(url)
        })()
      },
      undefined,
      { skipBrowserOpen: true },
    )
    expect(pages.map(p => p.status)).toEqual([400, 400, 400])
    const reasons = ['Invalid state parameter.', 'Invalid state parameter.', 'Missing OAuth result.']
    pages.forEach((page, i) => {
      expect(page.html).toBe(
        `<h1>Authentication Error</h1><p>${reasons[i]} Please try again.</p><p>You can close this window.</p>`,
      )
    })
    expect(bed.hits('/token')).toHaveLength(1)
  })

  test('FIXED: a request for any path other than /callback is answered instead of left hanging', async () => {
    bed = startAuthBed()
    let outcome = ''
    await performMCPOAuthFlow(
      'docs',
      http(bed.mcpUrl),
      url => {
        void (async () => {
          const callback = new URL(new URL(url).searchParams.get('redirect_uri')!)
          try {
            await fetch(`${callback.origin}/favicon.ico`, { signal: AbortSignal.timeout(400) })
            outcome = 'answered'
          } catch {
            outcome = 'hung'
          }
          await approveInBrowser(url)
        })()
      },
      undefined,
      { skipBrowserOpen: true },
    )
    expect(outcome).toBe('answered')
  })

  test('an error from the authorization server ends the sign-in, escaped on the page', async () => {
    bed = startAuthBed({ denyWith: { error: 'access_denied', error_description: '<script>alert(1)</script>' } })
    let page: ReturnType<typeof approveInBrowser> | undefined
    const flow = performMCPOAuthFlow('docs', http(bed.mcpUrl), url => {
      page = approveInBrowser(url)
    }, undefined, { skipBrowserOpen: true })
    await expect(flow).rejects.toThrow('OAuth error: access_denied - <script>alert(1)</script>')
    const shown = await page!
    expect(shown.status).toBe(200)
    expect(shown.html).toBe(
      '<h1>Authentication Error</h1><p>access_denied: &lt;script&gt;alert(1)&lt;/script&gt;</p><p>You can close this window.</p>',
    )
    expect(bed.hits('/token')).toHaveLength(0)
  })

  test('a port already taken fails with a hint on how to find the holder', async () => {
    bed = startAuthBed()
    const holder = createServer()
    extraServers.push(holder)
    await new Promise<void>(done => holder.listen(0, '127.0.0.1', done))
    const port = (holder.address() as { port: number }).port
    const reported: string[] = []
    await expect(
      performMCPOAuthFlow('docs', http(bed.mcpUrl, { callbackPort: port }), url => reported.push(url)),
    ).rejects.toThrow(
      `OAuth callback port ${port} is already in use — another process may be holding it. Run \`lsof -ti:${port} -sTCP:LISTEN\` to find it.`,
    )
    expect(reported).toEqual([])
  })

  test('any other listen failure is reported as a callback server failure', async () => {
    bed = startAuthBed()
    await expect(
      performMCPOAuthFlow('docs', http(bed.mcpUrl, { callbackPort: 1 }), () => {}),
    ).rejects.toThrow(/^OAuth callback server failed: /)
  })
})

describe('ending a sign-in early', () => {
  test('aborting cancels the sign-in and closes the callback server', async () => {
    bed = startAuthBed()
    const controller = new AbortController()
    let redirect = ''
    const flow = performMCPOAuthFlow(
      'docs',
      http(bed.mcpUrl),
      url => {
        redirect = new URL(url).searchParams.get('redirect_uri')!
        controller.abort()
      },
      controller.signal,
      { skipBrowserOpen: true },
    )
    await expect(flow).rejects.toBeInstanceOf(AuthenticationCancelledError)
    await expect(fetch(redirect)).rejects.toThrow()
  })

  test('an already aborted signal cancels before anything listens', async () => {
    bed = startAuthBed()
    const reported: string[] = []
    await expect(
      performMCPOAuthFlow('docs', http(bed.mcpUrl), url => reported.push(url), AbortSignal.abort()),
    ).rejects.toThrow('Authentication was cancelled')
    expect(reported).toEqual([])
    expect(bed.hits('/register')).toHaveLength(0)
  })

  test('a registration failure is surfaced as an SDK auth failure', async () => {
    bed = startAuthBed({ registration: 'broken' })
    await expect(performMCPOAuthFlow('docs', http(bed.mcpUrl), () => {})).rejects.toThrow(/^SDK auth failed: /)
  })

  test('a token endpoint that no longer knows the configured client clears its id', async () => {
    bed = startAuthBed({
      onToken: form =>
        form.get('grant_type') === 'authorization_code'
          ? Response.json({ error: 'invalid_client', error_description: 'Client not found' }, { status: 400 })
          : undefined,
    })
    const cfg = http(bed.mcpUrl, { clientId: 'preset' })
    let thrown: unknown
    try {
      await signIn(cfg)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(InvalidClientError)
    expect((thrown as Error).message).toBe('Client not found')
    expect(entryOf(cfg)?.clientId).toBeUndefined()
  })
})

describe('pasting the callback URL by hand', () => {
  test('stray, forged or empty URLs are ignored and the real one completes the sign-in', async () => {
    bed = startAuthBed()
    const cfg = http(bed.mcpUrl)
    let submit: ((url: string) => void) | undefined
    await performMCPOAuthFlow(
      'docs',
      cfg,
      url => {
        void (async () => {
          const authorize = new URL(url)
          const callback = authorize.searchParams.get('redirect_uri')!
          const state = authorize.searchParams.get('state')!
          for (const pasted of ['definitely not a url', `${callback}?code=forged&state=wrong`, `${callback}?state=${state}`]) {
            submit!(pasted)
          }
          const consent = await fetch(url, { redirect: 'manual' })
          submit!(consent.headers.get('location')!)
        })()
      },
      undefined,
      { skipBrowserOpen: true, onWaitingForCallback: s => (submit = s) },
    )
    expect(entryOf(cfg)?.accessToken).toBe('access-1')
    expect(bed.hits('/token')).toHaveLength(1)
  })

  test('a pasted error ends the sign-in', async () => {
    bed = startAuthBed()
    let submit: ((url: string) => void) | undefined
    const flow = performMCPOAuthFlow(
      'docs',
      http(bed.mcpUrl),
      url => {
        const authorize = new URL(url)
        submit!(`${authorize.searchParams.get('redirect_uri')}?state=${authorize.searchParams.get('state')}&error=access_denied`)
      },
      undefined,
      { skipBrowserOpen: true, onWaitingForCallback: s => (submit = s) },
    )
    await expect(flow).rejects.toThrow('OAuth error: access_denied')
  })
})

describe('step-up detection on the transport fetch', () => {
  test('only a 403 insufficient_scope with a scope marks a step-up', async () => {
    bed = startAuthBed()
    const cfg = http(bed.mcpUrl)
    store.write({
      mcpOAuth: {
        [getServerKey('docs', cfg)]: {
          serverName: 'docs', serverUrl: cfg.url, accessToken: 'at', refreshToken: 'rt', scope: 'docs.read', expiresAt: Date.now() + 3_600_000,
        },
      },
    })
    const cases: [number, string, boolean][] = [
      [403, 'Bearer error="insufficient_scope", scope="docs.admin docs.read"', true],
      [403, 'Bearer error="insufficient_scope", scope=docs.admin', true],
      [403, 'Bearer error="insufficient_scope"', false],
      [403, 'Bearer error="invalid_token", scope="docs.admin"', false],
      [401, 'Bearer error="insufficient_scope", scope="docs.admin"', false],
    ]
    for (const [status, challenge, stepUp] of cases) {
      bed.config.onResource = () => new Response('no', { status, headers: { 'WWW-Authenticate': challenge } })
      const provider = new ClaudeAuthProvider('docs', cfg)
      const wrapped = wrapFetchWithStepUpDetection(fetch, provider)
      const response = await wrapped(bed.mcpUrl, { method: 'POST' })
      expect(response.status, challenge).toBe(status)
      expect(await response.text(), challenge).toBe('no')
      expect((await provider.tokens())?.refresh_token, challenge).toBe(stepUp ? undefined : 'rt')
    }
  })
})
