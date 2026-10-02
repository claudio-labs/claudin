/**
 * What the Codex OAuth characterization suites do not reach: the callback's
 * refusal paths, the timeout, the busy-port fix, and the store's edges.
 * Same boundaries as those suites: a real local issuer, a temp config dir.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CodexOAuthService, type CodexOAuthTokens } from 'src/providers/oauth/codexOAuth.js'
import {
  clearCodexCredentials,
  readCodexCredentials,
  refreshCodexAccessTokenIfNeeded,
  saveCodexCredentials,
} from 'src/providers/oauth/codexCredentials.js'
import {
  exchangeCodexIdTokenForApiKey,
  parseChatgptAccountId,
} from 'src/providers/oauth/codexOAuthShared.js'
import {
  AUTH_CODE_GRANT,
  expIn,
  type FakeIssuer,
  type IssuerAnswer,
  REFRESH_GRANT,
  startFakeIssuer,
  unsignedJwt,
  useCodexSandbox,
} from 'src/providers/oauth/__testutils__/codexAuthHarness.js'

const sandbox = useCodexSandbox()
const browserFetch = globalThis.fetch
let issuer: FakeIssuer | undefined
const heldServers: Server[] = []

beforeEach(() => {
  clearCodexCredentials()
})

afterEach(async () => {
  issuer?.stop()
  issuer = undefined
  await Promise.all(heldServers.splice(0).map(s => new Promise(resolve => s.close(resolve))))
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise(resolve => server.close(resolve))
  return port
}

/** True when the port can be bound again, i.e. the login released it. */
async function canBind(port: number): Promise<boolean> {
  const server = createServer()
  return new Promise(resolve => {
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      heldServers.push(server)
      resolve(true)
    })
  })
}

function codeIssuer(answer: IssuerAnswer = { body: { access_token: 'at', refresh_token: 'rt' } }): FakeIssuer {
  issuer = startFakeIssuer(() => answer)
  return issuer
}

type Outcome = { tokens?: CodexOAuthTokens; error?: Error }

async function settleFlow(flow: Promise<CodexOAuthTokens>): Promise<Outcome> {
  try {
    return { tokens: await flow }
  } catch (error) {
    return { error: error as Error }
  }
}

/** The redirect the browser would follow, with the given query on top of it. */
function callbackUrl(authUrl: string, query: Record<string, string | null>): URL {
  const authorize = new URL(authUrl)
  const back = new URL(authorize.searchParams.get('redirect_uri')!)
  back.searchParams.set('state', authorize.searchParams.get('state')!)
  for (const [key, value] of Object.entries(query)) {
    if (value === null) back.searchParams.delete(key)
    else back.searchParams.set(key, value)
  }
  return back
}

describe('callback refusals', () => {
  const refusals: Array<[label: string, query: Record<string, string | null>, message: string]> = [
    ['an issuer error with a description', { error: 'access_denied', error_description: 'User said no' }, 'User said no'],
    ['an issuer error without a description', { error: 'access_denied' }, 'access_denied'],
    ['no code at all', { code: null }, 'Missing authorization code'],
  ]
  for (const [label, query, message] of refusals) {
    test(`${label} rejects the flow and shows the reason`, async () => {
      process.env.CODEX_OAUTH_CALLBACK_PORT = '0'
      const seen = codeIssuer()
      let page!: Promise<Response>
      const outcome = await settleFlow(
        new CodexOAuthService().startOAuthFlow(async url => {
          page = browserFetch(callbackUrl(url, { code: 'c', ...query }))
        }),
      )
      const response = await page

      expect(outcome.error?.message).toBe(message)
      expect(response.status).toBe(400)
      expect(await response.text()).toContain(`<p>${message}</p>`)
      expect(seen.calls).toHaveLength(0)
    })
  }

  test('a forged state is refused even when it carries an issuer error', async () => {
    process.env.CODEX_OAUTH_CALLBACK_PORT = '0'
    codeIssuer()
    let page!: Promise<Response>
    const outcome = await settleFlow(
      new CodexOAuthService().startOAuthFlow(async url => {
        page = browserFetch(callbackUrl(url, { state: 'forged', error: 'access_denied' }))
      }),
    )
    expect(outcome.error?.message).toBe('Invalid state parameter')
    expect((await page).status).toBe(400)
  })

  test('another path gets a 404 and the login keeps waiting', async () => {
    process.env.CODEX_OAUTH_CALLBACK_PORT = '0'
    codeIssuer()
    let stray!: Response
    let page!: Promise<Response>
    const outcome = await settleFlow(
      new CodexOAuthService().startOAuthFlow(async url => {
        const back = callbackUrl(url, { code: 'c' })
        stray = await browserFetch(new URL('/favicon.ico', back))
        page = browserFetch(back)
      }),
    )
    expect(stray.status).toBe(404)
    expect(outcome.tokens?.refreshToken).toBe('rt')
    expect((await page).status).toBe(200)
  })

  test('a second callback while the first is redeemed is refused and does not disturb it', async () => {
    process.env.CODEX_OAUTH_CALLBACK_PORT = '0'
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let arrived!: () => void
    const redeemArrived = new Promise<void>(resolve => {
      arrived = resolve
    })
    issuer = startFakeIssuer(async () => {
      arrived()
      await held
      return { body: { access_token: 'at', refresh_token: 'rt' } }
    })
    let first!: Promise<Response>
    let second!: Response
    const flow = new CodexOAuthService().startOAuthFlow(async url => {
      const back = callbackUrl(url, { code: 'c' })
      first = browserFetch(back)
      await redeemArrived
      second = await browserFetch(back)
      release()
    })
    const outcome = await settleFlow(flow)

    expect(second.status).toBe(400)
    expect(await second.text()).toContain('No Codex login is waiting for this callback.')
    expect(outcome.tokens?.accessToken).toBe('at')
    expect((await first).status).toBe(200)
    expect(issuer.callsOfGrant(AUTH_CODE_GRANT)).toHaveLength(1)
  })
})

describe('busy port (fixed: decided by the bind error code, not the message text)', () => {
  test('an issuer error echoing the redirect_uri port keeps its own message', async () => {
    const port = await freePort()
    process.env.CODEX_OAUTH_CALLBACK_PORT = String(port)
    const echoed = `redirect_uri http://localhost:${port}/auth/callback is not registered`
    codeIssuer({ status: 400, body: echoed })

    const outcome = await settleFlow(
      new CodexOAuthService().startOAuthFlow(async url => {
        void browserFetch(callbackUrl(url, { code: 'c' }))
      }),
    )
    expect(outcome.error?.message).toBe(`Codex OAuth token exchange failed (400): ${echoed}`)
  })

  const privilegedPortRefused = (() => {
    if (process.platform !== 'linux' || process.getuid?.() === 0) return false
    try {
      return Number(readFileSync('/proc/sys/net/ipv4/ip_unprivileged_port_start', 'utf8')) > 1
    } catch {
      return false
    }
  })()

  test.skipIf(!privilegedPortRefused)('a bind failure that is not EADDRINUSE surfaces as itself', async () => {
    process.env.CODEX_OAUTH_CALLBACK_PORT = '1'
    let browserOpened = false
    const outcome = await settleFlow(
      new CodexOAuthService().startOAuthFlow(async () => {
        browserOpened = true
      }),
    )
    expect(browserOpened).toBe(false)
    expect(outcome.error?.message).not.toContain('Close any app already using that port')
    expect((outcome.error as Error & { code?: string }).code).toBe('EACCES')
  })
})

describe('the login lifecycle', () => {
  test('the callback port is released once the login succeeds', async () => {
    const port = await freePort()
    process.env.CODEX_OAUTH_CALLBACK_PORT = String(port)
    codeIssuer()
    let page!: Promise<Response>
    const outcome = await settleFlow(
      new CodexOAuthService().startOAuthFlow(async url => {
        page = browserFetch(callbackUrl(url, { code: 'c' }))
      }),
    )
    await page
    expect(outcome.tokens?.accessToken).toBe('at')
    expect(await canBind(port)).toBe(true)
  })

  test('a failure to open the browser ends the login and releases the port', async () => {
    const port = await freePort()
    process.env.CODEX_OAUTH_CALLBACK_PORT = String(port)
    const outcome = await settleFlow(
      new CodexOAuthService().startOAuthFlow(async () => {
        throw new Error('no browser here')
      }),
    )
    expect(outcome.error?.message).toBe('no browser here')
    expect(await canBind(port)).toBe(true)
  })

  test('a browser that never returns times out', async () => {
    process.env.CODEX_OAUTH_CALLBACK_PORT = '0'
    const outcome = await settleFlow(
      new CodexOAuthService({ callbackTimeoutMs: 20 }).startOAuthFlow(async () => {}),
    )
    expect(outcome.error?.message).toBe('Codex OAuth timed out waiting for the browser to return.')
  })

  test('cancelling while the callback port is still being bound never opens the browser', async () => {
    process.env.CODEX_OAUTH_CALLBACK_PORT = '0'
    const service = new CodexOAuthService()
    let browserOpened = false
    const flow = service.startOAuthFlow(async () => {
      browserOpened = true
    })
    service.cleanup()
    const outcome = await settleFlow(flow)
    expect(outcome.error?.message).toBe('Codex OAuth flow was cancelled.')
    expect(browserOpened).toBe(false)
  })
})

describe('shared helpers', () => {
  test('a top-level organizations claim is the final account fallback', () => {
    expect(parseChatgptAccountId(unsignedJwt({ organizations: [{ id: 'org-top' }] }))).toBe('org-top')
  })

  test('a 200 exchange reply that is not JSON yields no API key', async () => {
    issuer = startFakeIssuer(() => ({ body: 'not json' }))
    await expect(exchangeCodexIdTokenForApiKey('id')).rejects.toThrow(
      'Codex API key exchange completed, but no API key token was returned.',
    )
  })
})

describe('credential store edges', () => {
  test('clearing with nothing stored succeeds without creating the store', () => {
    expect(clearCodexCredentials()).toEqual({ success: true })
    expect(existsSync(sandbox.credentialsPath)).toBe(false)
  })

  test('a read leaves out timestamps that are not numbers', () => {
    mkdirSync(sandbox.configDir, { recursive: true })
    writeFileSync(
      sandbox.credentialsPath,
      JSON.stringify({ codex: { accessToken: 'at', lastRefreshAt: '5', lastRefreshFailureAt: null } }),
    )
    expect(readCodexCredentials()).toEqual({ accessToken: 'at' })
  })

  test('a 200 refresh reply that is not JSON is a refresh without an access token', async () => {
    saveCodexCredentials({ accessToken: unsignedJwt({ exp: expIn(-5_000) }), refreshToken: 'rt' })
    issuer = startFakeIssuer(() => ({ body: '<html>maintenance</html>' }))
    await expect(refreshCodexAccessTokenIfNeeded()).rejects.toThrow(
      'Codex token refresh succeeded without a new access token.',
    )
    expect(issuer.callsOfGrant(REFRESH_GRANT)).toHaveLength(1)
  })

  test('a network failure is rethrown and starts the cooldown', async () => {
    saveCodexCredentials({ accessToken: unsignedJwt({ exp: expIn(-5_000) }), refreshToken: 'rt' })
    const realFetch = globalThis.fetch
    let attempts = 0
    globalThis.fetch = Object.assign(async () => {
      attempts += 1
      throw new TypeError('network down')
    }, realFetch)
    try {
      await expect(refreshCodexAccessTokenIfNeeded()).rejects.toThrow('network down')
      expect((await refreshCodexAccessTokenIfNeeded({ force: true })).refreshed).toBe(false)
    } finally {
      globalThis.fetch = realFetch
    }
    expect(attempts).toBe(1)
    const stored = JSON.parse(readFileSync(sandbox.credentialsPath, 'utf8')).codex
    expect(stored.lastRefreshFailureAt).toBeGreaterThan(0)
  })
})
