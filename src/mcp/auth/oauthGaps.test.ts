import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import type { Server } from 'bun'
import { auth } from '@modelcontextprotocol/client'
import { runMcpLogin } from 'src/mcp/auth/cliLogin.js'
import { ClaudeAuthProvider } from 'src/mcp/auth/claudeAuthProvider.js'
import { performMCPOAuthFlow } from 'src/mcp/auth/oauthFlow.js'
import { getServerKey } from 'src/mcp/auth/serverKey.js'
import type { McpHTTPServerConfig, ScopedMcpServerConfig } from 'src/mcp/types.js'
import {
  _setSecureStorageForTesting,
  type SecureStorage,
  type SecureStorageData,
} from 'src/platform/secureStorage/index.js'

/*
 * OAuth gaps against MCP 2026-07-28's authorization rules, over the real
 * login flow and a local authorization server:
 * - RFC 9207 (SEP-2468): a callback whose `iss` is not the issuer, or that
 *   omits `iss` when the server advertises it, must not sign in.
 * - SEP-837: dynamic client registration declares `application_type`.
 * - SEP-2352: a resource that moved to another authorization server must not
 *   reuse the client registered at the old one.
 */

let stored: SecureStorageData = {}
const registrations: Array<Record<string, unknown>> = []
const savedBrowser = process.env.BROWSER

const srv: Server<undefined> = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url)
    const origin = `http://127.0.0.1:${srv.port}`
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
        authorization_response_iss_parameter_supported: true,
      })
    }
    if (url.pathname === '/register') {
      const body = (await req.json()) as Record<string, unknown>
      registrations.push(body)
      return Response.json({ ...body, client_id: 'gaps-client' }, { status: 201 })
    }
    if (url.pathname === '/token') {
      return Response.json({ access_token: 'at', token_type: 'Bearer', expires_in: 3600 })
    }
    return new Response('not found', { status: 404 })
  },
})
const origin = () => `http://127.0.0.1:${srv.port}`

beforeAll(() => {
  process.env.BROWSER = '/usr/bin/true'
})

afterEach(() => {
  stored = {}
  registrations.length = 0
  _setSecureStorageForTesting(null)
  mock.restore()
})

afterAll(() => {
  if (savedBrowser === undefined) delete process.env.BROWSER
  else process.env.BROWSER = savedBrowser
  srv.stop(true)
})

function useMemoryStorage(): void {
  _setSecureStorageForTesting({
    name: 'memory',
    read: () => stored,
    readAsync: async () => stored,
    update: data => {
      stored = data
      return { success: true }
    },
    delete: () => true,
  })
}

// Runs `claudin mcp login <name>` and pastes the callback `query(state)` builds.
async function loginWithCallback(name: string, query: (state: string) => string) {
  useMemoryStorage()
  const config: ScopedMcpServerConfig = { type: 'http', url: `${origin()}/mcp`, scope: 'user' }
  let authUrl = ''
  let paste: (line: string) => void = () => {}
  let prompted = false
  const result = runMcpLogin(name, {
    getConfig: () => config,
    performFlow: performMCPOAuthFlow,
    revoke: async () => {},
    readLine: async () => {
      prompted = true
      return new Promise<string>(resolve => {
        paste = resolve
      })
    },
    write: text => {
      authUrl = text.match(/https?:\/\/\S+/)?.[0] ?? authUrl
    },
  })
  for (let i = 0; i < 100 && !(authUrl && prompted); i++) await Bun.sleep(20)
  const state = new URL(authUrl).searchParams.get('state') ?? ''
  paste(`http://localhost:1/callback?${query(state)}`)
  return result
}

describe('RFC 9207 iss on the OAuth callback', () => {
  test('control: a callback naming the right issuer signs in', async () => {
    const iss = encodeURIComponent(origin())
    const result = await loginWithCallback('iss-ok', state => `code=abc&state=${state}&iss=${iss}`)
    expect(result.ok).toBe(true)
  }, 15_000)

  test('a callback whose iss names another issuer does not sign in', async () => {
    const iss = encodeURIComponent('https://evil.example')
    const result = await loginWithCallback('iss-evil', state => `code=abc&state=${state}&iss=${iss}`)
    expect(result.ok).toBe(false)
  }, 15_000)

  test('a callback without iss does not sign in when the server advertises it', async () => {
    const result = await loginWithCallback('iss-missing', state => `code=abc&state=${state}`)
    expect(result.ok).toBe(false)
  }, 15_000)
})

describe('dynamic client registration', () => {
  test('control: the registration sends a loopback redirect URI', async () => {
    const iss = encodeURIComponent(origin())
    await loginWithCallback('dcr-ctl', state => `code=abc&state=${state}&iss=${iss}`)
    const redirect = (registrations[0]?.redirect_uris as string[] | undefined)?.[0] ?? ''
    expect(new URL(redirect).hostname).toBe('localhost')
  }, 15_000)

  test("declares application_type 'native' for a loopback redirect", async () => {
    const iss = encodeURIComponent(origin())
    await loginWithCallback('dcr-type', state => `code=abc&state=${state}&iss=${iss}`)
    expect(registrations[0]?.application_type).toBe('native')
  }, 15_000)
})

// Re-authorization after a 401 runs the SDK's auth() over the cached
// discovery state; login itself clears the entry first, so it cannot show this.
describe('a resource that moved to another authorization server', () => {
  const SERVER_NAME = 'srv-moved'
  const SERVER_URL = 'https://mcp.example.com/mcp'
  const AS_A = 'https://as-a.example.com/'
  const AS_B = 'https://as-b.example.com/'
  const asMetadata = (base: string) => ({
    issuer: base,
    authorization_endpoint: `${base}authorize`,
    token_endpoint: `${base}token`,
    registration_endpoint: `${base}register`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
  })

  test('re-authorization follows the resource to the new server and its client', async () => {
    const config: McpHTTPServerConfig = { type: 'http', url: SERVER_URL }
    const key = getServerKey(SERVER_NAME, config)
    // An earlier login against AS-A: its discovery state and a client stamped
    // for AS-A, with no usable tokens, so auth() has to authorize again.
    let data: SecureStorageData = {
      mcpOAuth: {
        [key]: {
          serverName: SERVER_NAME,
          serverUrl: SERVER_URL,
          accessToken: '',
          expiresAt: 0,
          clientId: 'client-registered-at-a',
          clientIssuer: AS_A,
          discoveryState: { authorizationServerUrl: AS_A },
        },
      },
    }
    const storage: SecureStorage = {
      name: 'memory',
      read: () => structuredClone(data),
      readAsync: async () => structuredClone(data),
      update: next => {
        data = structuredClone(next)
        return { success: true }
      },
      delete: () => true,
    }
    _setSecureStorageForTesting(storage)
    spyOn(console, 'warn').mockImplementation(() => {})

    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      // The resource's protected-resource metadata now names AS-B only.
      if (url.includes('/.well-known/oauth-protected-resource')) {
        return Response.json({ resource: SERVER_URL, authorization_servers: [AS_B] })
      }
      if (url.startsWith(AS_A) && url.includes('/.well-known/')) return Response.json(asMetadata(AS_A))
      if (url.startsWith(AS_B) && url.includes('/.well-known/')) return Response.json(asMetadata(AS_B))
      if (url === `${AS_B}register`) {
        return Response.json({ client_id: 'client-registered-at-b', redirect_uris: ['http://localhost:1/callback'] })
      }
      return new Response('not found', { status: 404 })
    }

    const provider = new ClaudeAuthProvider(SERVER_NAME, config, 'http://localhost:54321/callback')
    expect(await auth(provider, { serverUrl: SERVER_URL, fetchFn })).toBe('REDIRECT')
    const authorizeUrl = new URL(provider.authorizationUrl!)
    expect({
      authorizeOrigin: `${authorizeUrl.origin}/`,
      clientId: authorizeUrl.searchParams.get('client_id'),
    }).toEqual({ authorizeOrigin: AS_B, clientId: 'client-registered-at-b' })
  })
})
