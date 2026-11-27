import { afterAll, beforeAll, expect, test } from 'bun:test'
import { runMcpLogin } from 'src/mcp/auth/cliLogin.js'
import { performMCPOAuthFlow } from 'src/mcp/auth/oauthFlow.js'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'
import { _setSecureStorageForTesting, type SecureStorageData } from 'src/platform/secureStorage/index.js'

// runMcpLogin over the real OAuth flow, against a local authorization server,
// with an in-memory secure storage and a browser that does nothing.

let stored: SecureStorageData = {}
const savedBrowser = process.env.BROWSER

const srv = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
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
      })
    }
    if (url.pathname === '/register') {
      return Response.json({ ...((await req.json()) as object), client_id: 'flow-client' }, { status: 201 })
    }
    if (url.pathname === '/token') {
      return Response.json({ access_token: 'at', token_type: 'Bearer', expires_in: 3600 })
    }
    return new Response('not found', { status: 404 })
  },
})

beforeAll(() => {
  process.env.BROWSER = '/usr/bin/true'
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
})

afterAll(() => {
  _setSecureStorageForTesting(null)
  if (savedBrowser === undefined) delete process.env.BROWSER
  else process.env.BROWSER = savedBrowser
  srv.stop(true)
})

test('on a terminal the paste prompt comes after the authorization URL, and a pasted callback signs in', async () => {
  const config: ScopedMcpServerConfig = { type: 'http', url: `http://127.0.0.1:${srv.port}/mcp`, scope: 'user' }
  const events: string[] = []
  let authUrl = ''
  let paste: (line: string) => void = () => {}
  const result = runMcpLogin('order', {
    getConfig: () => config,
    performFlow: performMCPOAuthFlow,
    revoke: async () => {},
    readLine: async () => {
      events.push('paste prompt')
      return new Promise<string>(resolve => {
        paste = resolve
      })
    },
    write: text => {
      events.push('authorization URL')
      authUrl = text.match(/https?:\/\/\S+/)?.[0] ?? ''
    },
  })
  for (let i = 0; i < 100 && !(authUrl && events.includes('paste prompt')); i++) await Bun.sleep(20)
  const state = new URL(authUrl).searchParams.get('state')
  paste(`http://localhost:1/callback?code=abc&state=${state}`)
  expect(await result).toEqual({ ok: true, message: 'Authenticated with "order".' })
  expect(events).toEqual(['authorization URL', 'paste prompt'])
}, 15_000)
