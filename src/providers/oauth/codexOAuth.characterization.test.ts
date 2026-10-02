/**
 * Characterization of the browser login for Codex (ChatGPT OAuth, PKCE):
 * the authorize URL it hands out, the code exchange it sends back, the tokens
 * it returns, the page the browser lands on, and how failures, cancellation
 * and a busy callback port surface. The "browser" is this test following the
 * authorize URL's redirect_uri; the issuer is a real local HTTP server.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CodexOAuthService, type CodexOAuthTokens } from 'src/providers/oauth/codexOAuth.js'
import {
  AUTH_CODE_GRANT,
  EXCHANGE_GRANT,
  type FakeIssuer,
  type IssuerAnswer,
  type IssuerCall,
  startFakeIssuer,
  unsignedJwt,
  useCodexSandbox,
} from 'src/providers/oauth/__testutils__/codexAuthHarness.js'

useCodexSandbox()

const callbackFetch = globalThis.fetch
let issuer: FakeIssuer | undefined
const heldServers: Server[] = []

afterEach(async () => {
  issuer?.stop()
  issuer = undefined
  await Promise.all(heldServers.splice(0).map(s => new Promise(resolve => s.close(resolve))))
})

/** Listens on an ephemeral port and keeps it, so the login cannot bind it. */
async function occupyPort(): Promise<number> {
  const server = createServer()
  heldServers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

/** A port that was free a moment ago. */
async function freePort(): Promise<number> {
  const port = await occupyPort()
  await new Promise(resolve => heldServers.pop()!.close(resolve))
  return port
}

type Login = {
  authUrl: URL
  tokens?: CodexOAuthTokens
  error?: Error
  page?: { status: number; html: string }
}

/**
 * Runs one login. The browser follows the authorize URL's redirect_uri with
 * `code` and (unless `browserState` overrides it) the issued state.
 */
async function login(options: {
  service?: CodexOAuthService
  browserState?: string
  afterAuthUrl?: (service: CodexOAuthService) => void
  skipBrowser?: boolean
} = {}): Promise<Login> {
  const service = options.service ?? new CodexOAuthService()
  let authUrl!: URL
  let pagePromise: Promise<Response> | undefined

  const flow = service.startOAuthFlow(async url => {
    authUrl = new URL(url)
    options.afterAuthUrl?.(service)
    if (options.skipBrowser) return
    const back = new URL(authUrl.searchParams.get('redirect_uri')!)
    back.searchParams.set('code', 'code-from-browser')
    back.searchParams.set('state', options.browserState ?? authUrl.searchParams.get('state')!)
    pagePromise = callbackFetch(back)
  })

  const outcome: Login = { authUrl: undefined as unknown as URL }
  try {
    outcome.tokens = await flow
  } catch (error) {
    outcome.error = error as Error
  }
  outcome.authUrl = authUrl
  if (pagePromise) {
    const page = await pagePromise
    outcome.page = { status: page.status, html: await page.text() }
  }
  return outcome
}

function issuerFor(answers: {
  code?: (call: IssuerCall) => IssuerAnswer | Promise<IssuerAnswer>
  exchange?: (call: IssuerCall) => IssuerAnswer | Promise<IssuerAnswer>
}): FakeIssuer {
  issuer = startFakeIssuer(call =>
    call.form.grant_type === AUTH_CODE_GRANT
      ? (answers.code?.(call) ?? { status: 500, body: 'no code handler' })
      : (answers.exchange?.(call) ?? { body: { access_token: 'sk-from-exchange' } }),
  )
  return issuer
}

const idTokenFor = (account: string) =>
  unsignedJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })

describe('a successful login', () => {
  test('hands out a PKCE authorize URL and redeems the code with the matching verifier', async () => {
    process.env.CODEX_OAUTH_CALLBACK_PORT = '0'
    process.env.CODEX_OAUTH_CLIENT_ID = 'login-client'
    const seen = issuerFor({
      code: () => ({ body: { access_token: 'at', refresh_token: 'rt' } }),
    })

    const { authUrl, tokens, error } = await login()
    expect(error).toBeUndefined()
    expect(tokens).toBeDefined()

    expect(authUrl.origin + authUrl.pathname).toBe('https://auth.openai.com/oauth/authorize')
    const params = Object.fromEntries(authUrl.searchParams)
    const redirect = new URL(params.redirect_uri)
    expect(redirect.hostname).toBe('localhost')
    expect(redirect.pathname).toBe('/auth/callback')
    expect(Number(redirect.port)).toBeGreaterThan(0)
    expect(params).toMatchObject({
      response_type: 'code',
      client_id: 'login-client',
      scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    })
    expect(params.state.length).toBeGreaterThanOrEqual(32)
    expect(Object.keys(params)).toEqual([
      'response_type',
      'client_id',
      'redirect_uri',
      'scope',
      'code_challenge',
      'code_challenge_method',
      'id_token_add_organizations',
      'codex_cli_simplified_flow',
      'state',
      'originator',
    ])

    const [redeem] = seen.calls
    expect(redeem.path).toBe('/oauth/token')
    expect(redeem.method).toBe('POST')
    expect(redeem.contentType).toBe('application/x-www-form-urlencoded')
    expect(redeem.form).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code-from-browser',
      redirect_uri: params.redirect_uri,
      client_id: 'login-client',
    })
    const challenge = createHash('sha256').update(redeem.form.code_verifier).digest('base64url')
    expect(challenge).toBe(params.code_challenge)
  })

  type TokenCase = {
    label: string
    code: Record<string, unknown>
    exchange?: IssuerAnswer
    expected: CodexOAuthTokens
    exchanges: number
  }
  const tokenCases: TokenCase[] = [
    {
      label: 'with an id token: API key minted, account from the id token',
      code: {
        access_token: unsignedJwt({ chatgpt_account_id: 'acct-access' }),
        refresh_token: ' rt ',
        id_token: idTokenFor('acct-id'),
      },
      expected: {
        apiKey: 'sk-from-exchange',
        accessToken: unsignedJwt({ chatgpt_account_id: 'acct-access' }),
        refreshToken: 'rt',
        idToken: idTokenFor('acct-id'),
        accountId: 'acct-id',
      },
      exchanges: 1,
    },
    {
      label: 'without an id token: no exchange, account from the access token',
      code: { access_token: unsignedJwt({ chatgpt_account_id: 'acct-access' }), refresh_token: 'rt' },
      expected: {
        apiKey: undefined,
        accessToken: unsignedJwt({ chatgpt_account_id: 'acct-access' }),
        refreshToken: 'rt',
        idToken: undefined,
        accountId: 'acct-access',
      },
      exchanges: 0,
    },
    {
      label: 'a failed exchange is not fatal',
      code: { access_token: 'opaque', refresh_token: 'rt', id_token: 'opaque-id' },
      exchange: { status: 500, body: 'nope' },
      expected: {
        apiKey: undefined,
        accessToken: 'opaque',
        refreshToken: 'rt',
        idToken: 'opaque-id',
        accountId: undefined,
      },
      exchanges: 1,
    },
  ]
  for (const { label, code, exchange, expected, exchanges } of tokenCases) {
    test(label, async () => {
      process.env.CODEX_OAUTH_CALLBACK_PORT = '0'
      const seen = issuerFor({ code: () => ({ body: code }), exchange: exchange && (() => exchange) })

      const { tokens, error, page } = await login()

      expect(error).toBeUndefined()
      expect(tokens).toEqual(expected)
      expect(seen.calls.filter(c => c.form.grant_type === EXCHANGE_GRANT)).toHaveLength(exchanges)
      expect(page?.status).toBe(200)
      expect(page?.html).toContain('<title>Codex Login Complete</title>')
    })
  }
})

describe('a failed code exchange', () => {
  const incomplete = 'Codex OAuth completed, but the token response was missing credentials.'
  // [issuer reply, the error the caller gets, how the browser page prints it]
  const failures: Array<[answer: IssuerAnswer, message: string, shown: string]> = [
    [
      { status: 400, body: `<script>alert("x")</script> & 'y'` },
      `Codex OAuth token exchange failed (400): <script>alert("x")</script> & 'y'`,
      'Codex OAuth token exchange failed (400): &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;',
    ],
    [
      { status: 503, body: '' },
      'Codex OAuth token exchange failed with status 503.',
      'Codex OAuth token exchange failed with status 503.',
    ],
    [{ body: { access_token: 'at-only' } }, incomplete, incomplete],
    [{ body: { refresh_token: 'rt-only', access_token: '  ' } }, incomplete, incomplete],
  ]
  for (const [answer, message, shown] of failures) {
    test(`rejects with "${message}" and shows it, escaped, to the browser`, async () => {
      const port = await freePort()
      process.env.CODEX_OAUTH_CALLBACK_PORT = String(port)
      expect(message).not.toContain(String(port))
      issuerFor({ code: () => answer })

      const { error, page } = await login()

      expect(error?.message).toBe(message)
      expect(page).toMatchObject({ status: 400 })
      const html = page?.html ?? ''
      expect([html.includes('<title>Codex Login Failed</title>'), html.includes(`<p>${shown}</p>`), html.includes('<script>')])
        .toEqual([true, true, false])
    })
  }

  test('FIXED: an error whose text contains the callback port keeps its own message', async () => {
    // Was: with port 0 any message holding a "0" (here the status 400) was
    // rewritten into the busy-port message. Only a bind failure with
    // code EADDRINUSE is a busy port now; the caller and the browser get
    // the same real message.
    process.env.CODEX_OAUTH_CALLBACK_PORT = '0'
    issuerFor({ code: () => ({ status: 400, body: 'bad code' }) })

    const { error, page } = await login()

    expect(error?.message).toBe('Codex OAuth token exchange failed (400): bad code')
    expect(page?.html).toContain('Codex OAuth token exchange failed (400): bad code')
  })
})

describe('the callback port', () => {
  test('a port already in use fails before the browser is sent anywhere', async () => {
    const port = await occupyPort()
    process.env.CODEX_OAUTH_CALLBACK_PORT = String(port)
    let browserOpened = false
    const service = new CodexOAuthService()

    const error = await service
      .startOAuthFlow(async () => {
        browserOpened = true
      })
      .catch((e: Error) => e)

    expect(browserOpened).toBe(false)
    expect((error as Error).message).toBe(
      `Codex OAuth needs localhost:${port} for its callback. Close any app already using that port and try again.`,
    )
  })

  test('the configured port is the one in the redirect_uri', async () => {
    const port = await freePort()
    process.env.CODEX_OAUTH_CALLBACK_PORT = String(port)
    issuerFor({ code: () => ({ body: { access_token: 'at', refresh_token: 'rt' } }) })

    const { authUrl, tokens } = await login()
    expect(tokens?.refreshToken).toBe('rt')
    expect(authUrl.searchParams.get('redirect_uri')).toBe(`http://localhost:${port}/auth/callback`)
  })
})

describe('state and cancellation', () => {
  test('a callback carrying the wrong state is refused and no code is redeemed', async () => {
    process.env.CODEX_OAUTH_CALLBACK_PORT = '0'
    const seen = issuerFor({ code: () => ({ body: { access_token: 'at', refresh_token: 'rt' } }) })

    const { error, page } = await login({ browserState: 'forged' })

    expect(error?.message).toBe('Invalid state parameter')
    expect(page?.status).toBe(400)
    expect(seen.calls).toHaveLength(0)
  })

  test('cancelling before the browser returns rejects as cancelled', async () => {
    process.env.CODEX_OAUTH_CALLBACK_PORT = '0'
    const seen = issuerFor({})

    const { error } = await login({ skipBrowser: true, afterAuthUrl: service => service.cleanup() })

    expect(error?.message).toBe('Codex OAuth flow was cancelled.')
    expect(seen.calls).toHaveLength(0)
  })

  test('cancelling while the API key is being minted discards the tokens and shows the cancelled page', async () => {
    process.env.CODEX_OAUTH_CALLBACK_PORT = '0'
    const service = new CodexOAuthService()
    let exchangeArrived!: () => void
    const arrived = new Promise<void>(resolve => {
      exchangeArrived = resolve
    })
    let finishExchange!: () => void
    const exchangeHeld = new Promise<void>(resolve => {
      finishExchange = resolve
    })
    issuerFor({
      code: () => ({ body: { access_token: 'at', refresh_token: 'rt', id_token: idTokenFor('a') } }),
      exchange: async () => {
        exchangeArrived()
        await exchangeHeld
        return { body: { access_token: 'sk-late' } }
      },
    })

    const running = login({ service })
    await arrived
    service.cleanup()
    finishExchange()
    const { error, tokens, page } = await running

    expect(tokens).toBeUndefined()
    expect(error?.message).toBe('Codex OAuth flow was cancelled.')
    expect(page?.status).toBe(200)
    expect(page?.html).toContain('<title>Codex Login Cancelled</title>')
  })

  test('cleanup on a service that never started is a no-op', () => {
    expect(() => new CodexOAuthService().cleanup()).not.toThrow()
  })
})
