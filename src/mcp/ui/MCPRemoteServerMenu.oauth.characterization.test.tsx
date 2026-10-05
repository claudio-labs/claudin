/**
 * Signing in to and out of a remote MCP server from its /mcp menu:
 * Authenticate, Re-authenticate and Clear authentication, which tokens they
 * revoke and which credentials they leave, the copy and paste helpers, and
 * cancelling.
 *
 * Everything is real: the authorization server of the auth test bed, an MCP
 * server behind a gate that wants one of its tokens, the connection manager
 * that dials it, and a credential store in a temp config dir. The "browser"
 * is the bed's stand-in, which logs the URL it was asked to open.
 */
import { describe, expect, test } from 'bun:test'
import React from 'react'
import { getServerKey } from 'src/mcp/auth.js'
import { type AuthBed, approveInBrowser, startAuthBed } from 'src/mcp/auth/__testutils__/oauthTestBed.js'
import { socketConfig, startSocketServer, stopAllSocketServers } from 'src/mcp/__testutils__/connectionRig.js'
import type { McpHTTPServerConfig, MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { MCPRemoteServerMenu } from 'src/mcp/ui/MCPRemoteServerMenu.js'
import type { HTTPServerInfo } from 'src/mcp/ui/types.js'
import {
  type GatedServer,
  KEYS,
  menuWorld,
  mountMenu,
  ownEnv,
  plain,
  SLOW,
  startGatedServer,
  stopAfter,
} from 'src/mcp/ui/__testutils__/serverMenuRig.js'

const world = menuWorld()
ownEnv('SSH_CONNECTION', 'TMUX')

type Setup = {
  bed: AuthBed
  gate: GatedServer
  config: McpHTTPServerConfig
  key: string
}

function setup(bedOptions: Parameters<typeof startAuthBed>[0] = {}): Setup {
  const bed = startAuthBed(bedOptions)
  stopAfter(bed.stop)
  const gate = startGatedServer(bed, {
    tools: [{ name: 'lookup' }],
    prompts: [{ name: 'brief' }],
    resources: [{ uri: 'bed://r', name: 'r' }],
  })
  const config: McpHTTPServerConfig = { type: 'http', url: gate.url }
  return { bed, gate, config, key: getServerKey('docs', config) }
}

const info = (config: McpHTTPServerConfig, type: MCPServerConnection['type'], isAuthenticated: boolean | undefined): HTTPServerInfo => ({
  name: 'docs',
  transport: 'http',
  scope: 'dynamic',
  isAuthenticated,
  config,
  client: { name: 'docs', type, config: { ...config, scope: 'dynamic' } } as MCPServerConnection,
})

type Mount = { tools?: number; dynamic?: Record<string, ScopedMcpServerConfig>; settled?: Array<[string, MCPServerConnection['type']]> }

async function menu(server: HTTPServerInfo, opts: Mount = {}) {
  const screen = await mountMenu(cb => <MCPRemoteServerMenu server={server} serverToolsCount={opts.tools ?? 0} {...cb} />, {
    dynamic: opts.dynamic,
    deferred: true,
  })
  for (const [name, type] of opts.settled ?? []) await screen.reaches(name, type)
  await screen.show()
  return screen
}

const dynamicOf = (config: McpHTTPServerConfig) => ({ docs: { ...config, scope: 'dynamic' } as ScopedMcpServerConfig })

/** The browser has been asked to open the authorization URL, and the screen shows it. */
async function authorizationUrl(screen: Awaited<ReturnType<typeof menu>>): Promise<string> {
  await screen.until(f => f.includes('/authorize?'), 'the authorization URL')
  const urls = world.browserUrls()
  expect(urls).toHaveLength(1)
  return urls[0]!
}

async function callbackClosed(url: string): Promise<boolean> {
  const back = new URL(url).searchParams.get('redirect_uri') ?? ''
  return fetch(back).then(
    () => false,
    () => true,
  )
}

const entryOf = (key: string) => world.read()?.mcpOAuth?.[key]
const tokensOf = (key: string) => {
  const e = entryOf(key)
  return { access: e?.accessToken, refresh: e?.refreshToken }
}

describe('Authenticate', () => {
  test('signs in through the browser, stores the tokens, dials the server again and reports it', async () => {
    const { bed, gate, config, key } = setup()
    const screen = await menu(info(config, 'needs-auth', false), { dynamic: dynamicOf(config), settled: [['docs', 'needs-auth']] })
    expect(gate.admitted).toEqual([])
    await screen.press(KEYS.enter)
    const url = await authorizationUrl(screen)
    expect(url).toStartWith(`${bed.base}/authorize?`)
    const waiting = plain(screen.text())
    expect(waiting).toContain('Authenticating with docs… ')
    expect(waiting).toContain('A browser window will open for authentication')
    expect(waiting).toContain("If your browser doesn't open automatically, copy this URL manually (c to copy)")
    expect(waiting).toContain("If the redirect page shows a connection error, paste the URL from your browser's address bar: URL >")
    expect(waiting).toEndWith('Return here after authenticating in your browser. Press Esc to go back.')
    expect(screen.calls.completed).toEqual([])

    await approveInBrowser(url)
    expect(await screen.completes()).toBe('Authentication successful. Connected to docs.')
    await screen.reaches('docs', 'connected')
    expect(tokensOf(key)).toEqual({ access: 'access-1', refresh: 'refresh-1' })
    expect(new Set(gate.admitted)).toEqual(new Set(['Bearer access-1']))
    expect(bed.hits('/revoke')).toEqual([])
    expect(await callbackClosed(url)).toBe(true)
    expect(screen.calls.cancelled).toBe(0)
  }, SLOW)

  test('the callback URL can be pasted by hand instead', async () => {
    const { config, key } = setup()
    const screen = await menu(info(config, 'needs-auth', false), { dynamic: dynamicOf(config), settled: [['docs', 'needs-auth']] })
    await screen.press(KEYS.enter)
    const url = await authorizationUrl(screen)
    const consent = await fetch(url, { redirect: 'manual' })
    const callback = consent.headers.get('location') ?? ''
    expect(callback).toContain('code=')
    await screen.press(`  ${callback}  `)
    await screen.until(f => plain(f).includes('state='), 'the pasted URL')
    await screen.press(KEYS.enter)
    expect(await screen.completes()).toBe('Authentication successful. Connected to docs.')
    expect(tokensOf(key).access).toBe('access-1')
  }, SLOW)

  const outcomes: Array<[string, (s: Setup) => Record<string, ScopedMcpServerConfig>, MCPServerConnection['type'], string]> = [
    [
      'still refused',
      s => {
        const other = startGatedServer(s.bed, { tools: [{ name: 'x' }] })
        return { docs: { type: 'http', url: other.url, scope: 'dynamic' } as ScopedMcpServerConfig }
      },
      'needs-auth',
      'Authentication successful, but server still requires authentication. You may need to manually restart Claudin.',
    ],
    [
      'unreachable',
      () => ({ docs: { type: 'stdio', command: '/nonexistent/mcp-binary', args: [], scope: 'dynamic' } as ScopedMcpServerConfig }),
      'failed',
      'Authentication successful, but server reconnection failed. You may need to manually restart Claudin for the changes to take effect.',
    ],
  ]
  for (const [why, dynamic, settled, message] of outcomes) {
    test(`a server ${why} after signing in: says so`, async () => {
      const s = setup()
      const screen = await menu(info(s.config, 'needs-auth', false), { dynamic: dynamic(s), settled: [['docs', settled]] })
      await screen.press(KEYS.enter)
      await approveInBrowser(await authorizationUrl(screen))
      expect(await screen.completes()).toBe(message)
      expect(tokensOf(s.key).access).toBe('access-1')
    }, SLOW)
  }

  test('a reconnect that throws after signing in shows the error and reports nothing', async () => {
    const { config, key } = setup()
    const screen = await menu(info(config, 'needs-auth', false))
    await screen.press(KEYS.enter)
    await approveInBrowser(await authorizationUrl(screen))
    const back = plain(await screen.until(f => f.includes('Error:'), 'the error'))
    expect(back).toContain('Error: MCP server docs not found ❯ 1. Authenticate 2. Disable')
    expect(screen.calls.completed).toEqual([])
    expect(tokensOf(key).access).toBe('access-1')
  }, SLOW)

  test('a refused sign-in shows the error under the menu', async () => {
    const { config, key } = setup({ denyWith: { error: 'access_denied', error_description: 'denied by admin' } })
    const screen = await menu(info(config, 'needs-auth', false))
    await screen.press(KEYS.enter)
    await approveInBrowser(await authorizationUrl(screen))
    const back = plain(await screen.until(f => f.includes('Error:'), 'the error'))
    expect(back).toMatch(/Error: .*access_denied.* ❯ 1\. Authenticate 2\. Disable/)
    expect(screen.calls.completed).toEqual([])
    expect(tokensOf(key)).toEqual({ access: '', refresh: undefined })
  }, SLOW)

  test('Esc while waiting cancels: back to the menu, no error, the callback listener closed', async () => {
    const { config, key } = setup()
    const screen = await menu(info(config, 'needs-auth', false))
    await screen.press(KEYS.enter)
    const url = await authorizationUrl(screen)
    expect(await callbackClosed(url)).toBe(false)
    await screen.press(KEYS.esc)
    const back = plain(await screen.until(f => f.includes('1. Authenticate'), 'the menu'))
    expect(back.includes('Error:')).toBe(false)
    expect(await callbackClosed(url)).toBe(true)
    expect(screen.calls).toEqual({ completed: [], cancelled: 0, viewedTools: 0 })
    expect(tokensOf(key).access ?? '').toBe('')
  }, SLOW)

  test('closing the menu mid sign-in closes the callback listener', async () => {
    const { config } = setup()
    const screen = await menu(info(config, 'needs-auth', false))
    await screen.press(KEYS.enter)
    const url = await authorizationUrl(screen)
    await screen.close()
    await Bun.sleep(100)
    expect(await callbackClosed(url)).toBe(true)
  }, SLOW)

  test('"c" copies the authorization URL with OSC 52, says so, ignores a repeat while it says so, and can copy again after 2 s', async () => {
    process.env.SSH_CONNECTION = '10.0.0.1 1 10.0.0.2 22'
    const { config } = setup()
    const screen = await menu(info(config, 'needs-auth', false))
    await screen.press(KEYS.enter)
    const url = await authorizationUrl(screen)
    const written: string[] = []
    const realWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      if (String(chunk).includes('\u001B]52;')) {
        written.push(String(chunk))
        return true
      }
      return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stdout.write
    try {
      await screen.press('c')
      await screen.until(f => f.includes('(Copied!)'), 'the copied note')
      expect(written).toHaveLength(1)
      expect(written[0]).toContain(`]52;c;${Buffer.from(url).toString('base64')}`)
      // Each wait: the key handler catches up with the new state in an effect after the paint.
      await Bun.sleep(250)
      await screen.press('c')
      expect(written).toHaveLength(1)
      await screen.until(f => f.includes('(c to copy)'), 'the hint to come back')
      await Bun.sleep(250)
      await screen.press('c')
      await screen.until(f => f.includes('(Copied!)'), 'the copied note again')
      expect(written).toHaveLength(2)
    } finally {
      process.stdout.write = realWrite as typeof process.stdout.write
    }
  }, SLOW)
})

describe('Re-authenticate', () => {
  test('revokes the stored tokens first, keeping the step-up scope and discovery, then signs in again', async () => {
    const { bed, config, key } = setup()
    world.write({
      mcpOAuth: {
        [key]: {
          serverName: 'docs',
          serverUrl: config.url,
          clientId: 'client-old',
          accessToken: 'access-50',
          refreshToken: 'refresh-50',
          expiresAt: Date.now() + 3_600_000,
          stepUpScope: 'files:write',
          discoveryState: { authorizationServerUrl: bed.base, resourceMetadataUrl: `${new URL(config.url).origin}/.well-known/oauth-protected-resource/mcp` },
        },
      },
    })
    const screen = await menu(info(config, 'connected', true), { dynamic: dynamicOf(config), settled: [['docs', 'connected']] })
    expect(plain(screen.text())).toContain('❯ 1. Re-authenticate 2. Clear authentication 3. Reconnect 4. Disable')
    await screen.press(KEYS.enter)
    const url = await authorizationUrl(screen)

    expect(bed.hits('/revoke').map(r => [r.form?.get('token'), r.form?.get('token_type_hint')])).toEqual([
      ['refresh-50', 'refresh_token'],
      ['access-50', 'access_token'],
    ])
    const between = entryOf(key)
    // The old tokens are gone; the step-up scope survived the revocation and
    // is what the new sign-in asks for.
    expect({ access: between?.accessToken, refresh: between?.refreshToken, as: between?.discoveryState?.authorizationServerUrl }).toEqual({
      access: '',
      refresh: undefined,
      as: bed.base,
    })
    expect(new URL(url).searchParams.get('scope')).toBe('files:write')

    await approveInBrowser(url)
    expect(await screen.completes()).toBe('Authentication successful. Reconnected to docs.')
    expect(tokensOf(key)).toEqual({ access: 'access-1', refresh: 'refresh-1' })
  }, SLOW)

  test('cancelling a re-authentication leaves the old tokens revoked', async () => {
    const { bed, config, key } = setup()
    world.write({
      mcpOAuth: { [key]: { serverName: 'docs', serverUrl: config.url, clientId: 'c', accessToken: 'a-1', refreshToken: 'r-1', expiresAt: Date.now() + 60_000, discoveryState: { authorizationServerUrl: bed.base } } },
    })
    const screen = await menu(info(config, 'failed', true))
    await screen.press(KEYS.enter)
    await authorizationUrl(screen)
    await screen.press(KEYS.esc)
    await screen.until(f => f.includes('1. Re-authenticate'), 'the menu')
    expect(bed.hits('/revoke')).toHaveLength(2)
    expect(tokensOf(key)).toEqual({ access: '', refresh: undefined })
  }, SLOW)
})

describe('Clear authentication', () => {
  async function signedIn(s: Setup, extra: Record<string, unknown> = {}) {
    const other = getServerKey('other', { type: 'http', url: 'https://other.example/mcp' })
    world.write({
      mcpOAuth: {
        [s.key]: {
          serverName: 'docs',
          serverUrl: s.config.url,
          clientId: 'client-9',
          accessToken: 'access-77',
          refreshToken: 'refresh-77',
          expiresAt: Date.now() + 3_600_000,
          stepUpScope: 'admin',
          discoveryState: { authorizationServerUrl: s.bed.base },
          ...extra,
        },
        [other]: { serverName: 'other', serverUrl: 'https://other.example/mcp', accessToken: 'keep-me', expiresAt: Date.now() + 60_000 },
      },
      mcpOAuthClientConfig: { [s.key]: { clientSecret: 'configured-secret' } },
    })
    const ws = startSocketServer({ tools: ['ping'], prompts: ['hello'], resources: ['doc'] })
    stopAfter(stopAllSocketServers)
    const screen = await menu(info(s.config, 'connected', true), {
      tools: 1,
      dynamic: { ...dynamicOf(s.config), keep: socketConfig(ws, 'dynamic') },
      settled: [
        ['docs', 'connected'],
        ['keep', 'connected'],
      ],
    })
    return { screen, other }
  }

  test('revokes both tokens, forgets this server’s tokens and step-up state, keeps its client secret, and drops what it brought', async () => {
    const s = setup()
    const { screen, other } = await signedIn(s)
    const owned = (names: string[]) => names.filter(n => n.startsWith('mcp__docs__'))
    expect(owned(screen.state().mcp.tools.map(t => t.name)).length).toBeGreaterThan(0)
    expect(owned(screen.state().mcp.commands.map(c => c.name))).toEqual(['mcp__docs__brief'])
    expect(Object.keys(screen.state().mcp.resources).sort()).toEqual(['docs', 'keep'])
    expect(s.gate.admitted).toContain('Bearer access-77')

    await screen.press(KEYS.down, KEYS.down, KEYS.enter)
    expect(await screen.completes()).toBe('Authentication cleared for docs.')

    expect(s.bed.hits('/revoke').map(r => [r.form?.get('token'), r.form?.get('token_type_hint')])).toEqual([
      ['refresh-77', 'refresh_token'],
      ['access-77', 'access_token'],
    ])
    // Nothing of this server's sign-in is left. (The manager redials the
    // closed connection and may file a fresh, token-less registration: see
    // the spec's findings.)
    const store = world.read()!
    expect(Object.keys(store.mcpOAuth).filter(k => k !== s.key)).toEqual([other])
    const left = store.mcpOAuth[s.key]
    expect([left?.accessToken || null, left?.refreshToken ?? null, left?.stepUpScope ?? null, left?.clientId === 'client-9']).toEqual([
      null,
      null,
      null,
      false,
    ])
    expect(store.mcpOAuth[other].accessToken).toBe('keep-me')
    expect(store.mcpOAuthClientConfig).toEqual({ [s.key]: { clientSecret: 'configured-secret' } })

    const mcp = screen.state().mcp
    expect(mcp.clients.find(c => c.name === 'docs')?.type).not.toBe('connected')
    expect(mcp.clients.find(c => c.name === 'keep')?.type).toBe('connected')
    expect(owned(mcp.tools.map(t => t.name))).toEqual([])
    expect(mcp.tools.map(t => t.name)).toContain('mcp__keep__ping')
    expect(mcp.commands.map(c => c.name)).toEqual(['mcp__keep__hello'])
    expect(Object.keys(mcp.resources)).toEqual(['keep'])
    expect(screen.calls.cancelled).toBe(0)
  }, SLOW)

  test('the local tokens go even when the authorization server refuses the revocation', async () => {
    const s = setup({ onRevoke: () => new Response('{"error":"server_error"}', { status: 500 }) })
    const { screen, other } = await signedIn(s)
    await screen.press(KEYS.down, KEYS.down, KEYS.enter)
    expect(await screen.completes()).toBe('Authentication cleared for docs.')
    expect(s.bed.hits('/revoke').length).toBeGreaterThan(0)
    expect(tokensOf(s.key).access || null).toBeNull()
    expect(entryOf(s.key)?.stepUpScope).toBeUndefined()
    expect(entryOf(other)?.accessToken).toBe('keep-me')
  }, SLOW)
})
