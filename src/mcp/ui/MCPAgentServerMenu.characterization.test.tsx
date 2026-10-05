/**
 * The /mcp menu of a server declared in an agent's frontmatter: it never
 * connects from here, but an HTTP or SSE one can be signed in to ahead of the
 * agent's run. The sign-in runs for real against the loopback OAuth server
 * of the auth test bed; the "browser" is its stand-in.
 */
import { describe, expect, test } from 'bun:test'
import figures from 'figures'
import React from 'react'
import { getServerKey } from 'src/mcp/auth.js'
import { type AuthBed, approveInBrowser, startAuthBed } from 'src/mcp/auth/__testutils__/oauthTestBed.js'
import { MCPAgentServerMenu } from 'src/mcp/ui/MCPAgentServerMenu.js'
import type { AgentMcpServerInfo } from 'src/mcp/ui/types.js'
import { KEYS, menuWorld, mountMenu, plain, SLOW, stopAfter } from 'src/mcp/ui/__testutils__/serverMenuRig.js'

const world = menuWorld()

function bedFor(overrides: Parameters<typeof startAuthBed>[0] = {}): AuthBed {
  const bed = startAuthBed(overrides)
  stopAfter(bed.stop)
  return bed
}

const remote = (url: string, extra: Partial<AgentMcpServerInfo> = {}): AgentMcpServerInfo =>
  ({ name: 'docs', transport: 'http', url, sourceAgents: ['reviewer'], needsAuth: true, ...extra }) as AgentMcpServerInfo

const menu = (agentServer: AgentMcpServerInfo) => mountMenu(cb => <MCPAgentServerMenu agentServer={agentServer} onCancel={cb.onCancel} onComplete={cb.onComplete} />)

/** Options of the menu, in order. */
const optionsOf = (frame: string) => [...plain(frame).matchAll(/\d\. ([A-Z][a-z-]+)/g)].map(m => m[1])

/** True once nothing listens where the authorization URL sends the browser back. */
async function callbackClosed(authorizationUrl: string): Promise<boolean> {
  const back = new URL(authorizationUrl).searchParams.get('redirect_uri') ?? ''
  return fetch(back).then(
    () => false,
    () => true,
  )
}

/** Every token stored for any MCP server; registration and discovery records hold none. */
const storedTokens = () =>
  Object.values(world.read()?.mcpOAuth ?? {}).flatMap((e: any) => [e.accessToken, e.refreshToken].filter(Boolean))

const FOOTER = '↑↓ to navigate · Enter to confirm · Esc to go back'

describe('what the menu shows', () => {
  test('a remote server that may need a login', async () => {
    const screen = await menu(remote('http://127.0.0.1:9/mcp', { sourceAgents: ['reviewer', 'planner'] }))
    expect(plain(screen.text())).toBe(
      [
        'Docs MCP Server agent-only',
        'Type: http URL: http://127.0.0.1:9/mcp Used by: reviewer, planner',
        `Status: ${figures.radioOff} not connected (agent-only)`,
        `Auth: ${figures.triangleUpOutline} may need authentication`,
        'This server connects only when running the agent.',
        '❯ 1. Authenticate 2. Back',
        FOOTER,
      ].join(' '),
    )
  }, SLOW)

  const rows: Array<[string, AgentMcpServerInfo, string[], string | null, string]> = [
    ['signed in', remote('http://h/mcp', { isAuthenticated: true }), ['Re-authenticate', 'Back'], `Auth: ${figures.tick} authenticated`, 'URL: http://h/mcp'],
    ['not probed yet', remote('http://h/mcp', { isAuthenticated: undefined }), ['Authenticate', 'Back'], `Auth: ${figures.triangleUpOutline} may need authentication`, 'Type: http'],
    ['sse', remote('http://h/sse', { transport: 'sse', isAuthenticated: false }), ['Authenticate', 'Back'], 'may need authentication', 'Type: sse URL: http://h/sse'],
    ['no login needed', remote('ws://h/ws', { transport: 'ws', needsAuth: false }), ['Back'], null, 'Type: ws URL: ws://h/ws'],
    [
      'a local command',
      { name: 'tool', transport: 'stdio', command: 'run-me --fast', sourceAgents: ['a'], needsAuth: false },
      ['Back'],
      null,
      'Type: stdio Command: run-me --fast Used by: a',
    ],
  ]
  for (const [why, server, options, auth, detail] of rows) {
    test(`${why}: offers ${options.join(', ')}`, async () => {
      const screen = await menu(server)
      const text = plain(screen.text())
      expect(optionsOf(screen.text())).toEqual(options)
      expect(text).toContain(detail)
      if (auth) expect(text).toContain(auth)
      else expect(text.includes('Auth:')).toBe(false)
      expect(text.includes('Command:')).toBe(server.transport === 'stdio')
      expect(text.includes('URL:')).toBe(server.transport !== 'stdio')
    }, SLOW)
  }
})

describe('leaving', () => {
  for (const [how, keys] of [
    ['Back', [KEYS.down, KEYS.enter]],
    ['Esc', [KEYS.esc]],
  ] as const) {
    test(`${how} goes back without signing in`, async () => {
      const bed = bedFor()
      const screen = await menu(remote(bed.mcpUrl))
      await screen.press(...keys)
      expect(screen.calls).toEqual({ completed: [], cancelled: 1, viewedTools: 0 })
      expect(bed.seen).toEqual([])
      expect(world.browserUrls()).toEqual([])
    }, SLOW)
  }
})

describe('signing in ahead of the agent', () => {
  test('Authenticate runs the browser sign-in and stores the tokens under this server', async () => {
    const bed = bedFor()
    const screen = await menu(remote(bed.mcpUrl))
    await screen.press(KEYS.enter)
    const waiting = plain(await screen.until(f => f.includes('/authorize?'), 'the authorization URL'))
    const [url] = world.browserUrls()
    expect(url).toStartWith(`${bed.base}/authorize?`)
    expect(waiting).toContain('Authenticating with docs…')
    expect(waiting).toContain('A browser window will open for authentication')
    expect(waiting).toContain("If your browser doesn't open automatically, copy this URL manually:")
    expect(waiting).toContain('Return here after authenticating in your browser. Esc to go back')
    expect(waiting.includes('URL >')).toBe(false)
    expect(screen.calls.completed).toEqual([])

    await approveInBrowser(url!)
    expect(await screen.completes()).toBe('Authentication successful for docs. The server will connect when the agent runs.')
    const entry = world.read()?.mcpOAuth?.[getServerKey('docs', { type: 'http', url: bed.mcpUrl })]
    expect({ access: entry?.accessToken, refresh: entry?.refreshToken, server: entry?.serverName }).toEqual({
      access: 'access-1',
      refresh: 'refresh-1',
      server: 'docs',
    })
    expect(await callbackClosed(url!)).toBe(true)
  }, SLOW)

  test('an SSE server signs in under its own transport', async () => {
    const bed = bedFor()
    const screen = await menu(remote(bed.mcpUrl, { transport: 'sse' }))
    await screen.press(KEYS.enter)
    await screen.until(f => f.includes('/authorize?'), 'the authorization URL')
    await approveInBrowser(world.browserUrls()[0]!)
    await screen.completes()
    const stored = Object.keys(world.read()?.mcpOAuth ?? {})
    expect(stored).toEqual([getServerKey('docs', { type: 'sse', url: bed.mcpUrl })])
  }, SLOW)

  test('Re-authenticate signs in again without revoking what is stored', async () => {
    const bed = bedFor()
    const key = getServerKey('docs', { type: 'http', url: bed.mcpUrl })
    world.write({ mcpOAuth: { [key]: { serverName: 'docs', serverUrl: bed.mcpUrl, accessToken: 'old-a', refreshToken: 'old-r', expiresAt: Date.now() + 60_000 } } })
    const screen = await menu(remote(bed.mcpUrl, { isAuthenticated: true }))
    await screen.press(KEYS.enter)
    await screen.until(f => f.includes('/authorize?'), 'the authorization URL')
    await approveInBrowser(world.browserUrls()[0]!)
    await screen.completes()
    expect(bed.hits('/revoke')).toEqual([])
    expect(world.read()?.mcpOAuth?.[key]?.accessToken).toBe('access-1')
  }, SLOW)

  test('a refused sign-in shows the error under the menu and reports nothing', async () => {
    const bed = bedFor({ denyWith: { error: 'access_denied', error_description: 'nope' } })
    const screen = await menu(remote(bed.mcpUrl))
    await screen.press(KEYS.enter)
    await screen.until(f => f.includes('/authorize?'), 'the authorization URL')
    await approveInBrowser(world.browserUrls()[0]!)
    const back = plain(await screen.until(f => f.includes('Error:'), 'the error'))
    expect(back).toMatch(/This server connects only when running the agent\. Error: .*access_denied.* ❯ 1\. Authenticate 2\. Back/)
    expect(screen.calls.completed).toEqual([])
    expect(storedTokens()).toEqual([])
  }, SLOW)

  test('Esc while waiting cancels: the callback listener closes, no token is stored, no error shown', async () => {
    const bed = bedFor()
    const screen = await menu(remote(bed.mcpUrl))
    await screen.press(KEYS.enter)
    await screen.until(f => f.includes('/authorize?'), 'the authorization URL')
    const url = world.browserUrls()[0]!
    await screen.press(KEYS.esc)
    const back = plain(await screen.until(f => f.includes('1. Authenticate'), 'the menu'))
    expect(back.includes('Error:')).toBe(false)
    expect(await callbackClosed(url)).toBe(true)
    expect(screen.calls).toEqual({ completed: [], cancelled: 0, viewedTools: 0 })
    expect(storedTokens()).toEqual([])
  }, SLOW)

  test('closing the menu mid sign-in closes the callback listener too', async () => {
    const bed = bedFor()
    const screen = await menu(remote(bed.mcpUrl))
    await screen.press(KEYS.enter)
    await screen.until(f => f.includes('/authorize?'), 'the authorization URL')
    const url = world.browserUrls()[0]!
    expect(await callbackClosed(url)).toBe(false)
    await screen.close()
    await Bun.sleep(100)
    expect(await callbackClosed(url)).toBe(true)
  }, SLOW)
})
