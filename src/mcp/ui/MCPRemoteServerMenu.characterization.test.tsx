/**
 * The /mcp menu of one remote server (SSE, HTTP or a claude.ai connector):
 * what it shows for each state, which actions it offers, and what View tools,
 * Reconnect, Disable and Enable do. Signing in and out is in the `.oauth`
 * and `.claudeai` suites.
 *
 * Mounted inside a live connection manager whose servers are real loopback
 * HTTP servers.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import figures from 'figures'
import { join } from 'node:path'
import React from 'react'
import { startAuthBed } from 'src/mcp/auth/__testutils__/oauthTestBed.js'
import { type HttpBed, serveHttp } from 'src/mcp/client/__testutils__/mcpServerBed.js'
import { getEnterpriseMcpFilePath, isMcpServerDisabled, setMcpServerEnabled } from 'src/mcp/config.js'
import type { ConfigScope, MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { MCPRemoteServerMenu } from 'src/mcp/ui/MCPRemoteServerMenu.js'
import type { ClaudeAIServerInfo, HTTPServerInfo, SSEServerInfo } from 'src/mcp/ui/types.js'
import {
  KEYS,
  menuWorld,
  mountMenu,
  ownEnv,
  plain,
  SLOW,
  startGatedServer,
  stopAfter,
} from 'src/mcp/ui/__testutils__/serverMenuRig.js'
import { getGlobalClaudeFile } from 'src/shared/env.js'

const world = menuWorld()
ownEnv('MCP_TIMEOUT')
const servers: HttpBed[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
})

const FOOTER = '↑↓ to navigate · Enter to select · Esc to back'
type Remote = SSEServerInfo | HTTPServerInfo | ClaudeAIServerInfo

function remote(
  transport: 'sse' | 'http' | 'claudeai-proxy',
  type: MCPServerConnection['type'],
  isAuthenticated: boolean | undefined,
  url = 'https://mcp.example.test/v1',
  scope: ConfigScope = 'dynamic',
): Remote {
  const config =
    transport === 'claudeai-proxy' ? { type: transport, url, id: 'mcprs_1' } : { type: transport, url }
  return {
    name: 'docs',
    transport,
    scope,
    isAuthenticated,
    config,
    client: { name: 'docs', type, config: { ...config, scope } },
  } as unknown as Remote
}

/** The menu's options, in order, read off the screen. */
const optionsOf = (frame: string) =>
  [...plain(frame).matchAll(/\d\. ((?:View|Re-|Clear|Authenticate|Reconnect|Disable|Enable|Back)[a-z -]*?)(?= \d\.| ↑↓|$)/g)].map(m => m[1]!.trim())

type Show = { tools?: number; borderless?: boolean; dynamic?: Record<string, ScopedMcpServerConfig>; deferred?: boolean }

const menu = (server: Remote, show: Show = {}) =>
  mountMenu(
    cb => <MCPRemoteServerMenu server={server} serverToolsCount={show.tools ?? 0} borderless={show.borderless} {...cb} />,
    { dynamic: show.dynamic, deferred: show.deferred },
  )

function httpServer(catalog: Parameters<typeof serveHttp>[0] = { tools: [{ name: 'lookup' }] }): HttpBed {
  const bed = serveHttp(catalog)
  servers.push(bed)
  return bed
}

/** An HTTP server that takes every POST and never answers it, until it is stopped. */
function silentServer(): string {
  const parked: Array<(r: Response) => void> = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: req =>
      req.method === 'POST' ? new Promise<Response>(answer => parked.push(answer)) : new Response(null, { status: 405 }),
  })
  stopAfter(() => {
    for (const answer of parked.splice(0)) answer(new Response(null, { status: 503 }))
    server.stop(true)
  })
  return `http://127.0.0.1:${server.port}/mcp`
}

describe('which actions it offers', () => {
  const rows: Array<[string, Remote, number, string, string | null, string[]]> = [
    ['http, connected, signed in', remote('http', 'connected', true), 2, `${figures.tick} connected`, `${figures.tick} authenticated`, ['View tools', 'Re-authenticate', 'Clear authentication', 'Reconnect', 'Disable']],
    ['http, connected with tools, no tokens: counts as signed in', remote('http', 'connected', false), 1, `${figures.tick} connected`, `${figures.tick} authenticated`, ['View tools', 'Re-authenticate', 'Clear authentication', 'Reconnect', 'Disable']],
    ['http, connected without tools or tokens', remote('http', 'connected', false), 0, `${figures.tick} connected`, `${figures.cross} not authenticated`, ['Authenticate', 'Reconnect', 'Disable']],
    ['http, needs auth', remote('http', 'needs-auth', undefined), 0, `${figures.triangleUpOutline} needs authentication`, `${figures.cross} not authenticated`, ['Authenticate', 'Disable']],
    ['http, needs auth with stale tokens', remote('http', 'needs-auth', true), 0, `${figures.triangleUpOutline} needs authentication`, `${figures.tick} authenticated`, ['Re-authenticate', 'Clear authentication', 'Disable']],
    ['http, failed, signed in', remote('http', 'failed', true), 3, `${figures.cross} failed`, `${figures.tick} authenticated`, ['Re-authenticate', 'Clear authentication', 'Reconnect', 'Disable']],
    ['sse, pending', remote('sse', 'pending', false), 0, `${figures.radioOff} connecting…`, `${figures.cross} not authenticated`, ['Authenticate', 'Reconnect', 'Disable']],
    ['sse, disabled, signed in', remote('sse', 'disabled', true), 2, `${figures.radioOff} disabled`, `${figures.tick} authenticated`, ['Enable', 'Re-authenticate', 'Clear authentication']],
    ['sse, disabled', remote('sse', 'disabled', false), 0, `${figures.radioOff} disabled`, `${figures.cross} not authenticated`, ['Enable', 'Authenticate']],
    ['claude.ai, connected', remote('claudeai-proxy', 'connected', false), 1, `${figures.tick} connected`, null, ['View tools', 'Clear authentication', 'Reconnect', 'Disable']],
    ['claude.ai, needs auth', remote('claudeai-proxy', 'needs-auth', true), 0, `${figures.triangleUpOutline} needs authentication`, null, ['Authenticate', 'Disable']],
    ['claude.ai, failed', remote('claudeai-proxy', 'failed', false), 0, `${figures.cross} failed`, null, ['Authenticate', 'Reconnect', 'Disable']],
    ['claude.ai, disabled', remote('claudeai-proxy', 'disabled', true), 0, `${figures.radioOff} disabled`, null, ['Enable']],
  ]
  for (const [why, server, tools, status, auth, options] of rows) {
    test(`${why}: ${options.join(', ')}`, async () => {
      const screen = await menu(server, { tools })
      const text = plain(screen.text())
      expect(optionsOf(screen.text())).toEqual(options)
      expect(text).toContain(`Status: ${status}`)
      if (auth) expect(text).toContain(`Status: ${status} Auth: ${auth} URL: https://mcp.example.test/v1`)
      else expect(text).toContain(`Status: ${status} URL: https://mcp.example.test/v1`)
      expect(text.includes('Auth:')).toBe(auth !== null)
      const connected = server.client.type === 'connected'
      expect(text.includes('Capabilities:')).toBe(connected)
      expect(text.includes(`Tools: ${tools} tools`)).toBe(connected && tools > 0)
    }, SLOW)
  }
})

describe('what the menu shows', () => {
  test('a connected server: every line, with what it offers counted from app state', async () => {
    const http = httpServer({
      tools: [{ name: 'a' }, { name: 'b' }],
      prompts: [{ name: 'summarize' }],
      resources: [{ uri: 'bed://one', name: 'one' }],
    })
    const config = { type: 'http', url: http.url, scope: 'dynamic' } as ScopedMcpServerConfig
    const screen = await menu(remote('http', 'connected', false, http.url), { tools: 2, dynamic: { docs: config }, deferred: true })
    await screen.reaches('docs', 'connected')
    await screen.show()
    const lines = screen.text().split('\n').map(l => l.replace(/[│╭╮╰╯─]/g, '').trim()).filter(Boolean)
    expect(lines).toEqual([
      'Docs MCP Server',
      `Status: ${figures.tick} connected`,
      `Auth: ${figures.tick} authenticated`,
      `URL: ${http.url}`,
      'Config location: Dynamically configured',
      'Capabilities: tools · resources · prompts',
      'Tools: 2 tools',
      '❯ 1. View tools',
      '2. Re-authenticate',
      '3. Clear authentication',
      '4. Reconnect',
      '5. Disable',
      FOOTER,
    ])
  }, SLOW)

  test('"Config location" is the scope the menu was given', async () => {
    const expected: Array<[ConfigScope, () => string]> = [
      ['user', () => getGlobalClaudeFile()],
      ['project', () => join(world.project(), '.mcp.json')],
      ['local', () => `${getGlobalClaudeFile()} [project: ${world.project()}]`],
      ['dynamic', () => 'Dynamically configured'],
      ['enterprise', () => getEnterpriseMcpFilePath()],
      ['claudeai', () => 'claude.ai'],
    ]
    const seen: string[] = []
    for (const [scope, where] of expected) {
      const screen = await menu(remote('sse', 'failed', false, 'https://h/sse', scope))
      const text = plain(screen.text())
      seen.push(text.includes(`Config location: ${where()} `) ? scope : text)
      await screen.close()
    }
    expect(seen).toEqual(expected.map(([scope]) => scope))
  }, SLOW)

  test('the title capitalizes the first letter; borderless drops the frame', async () => {
    const boxed = await menu({ ...remote('http', 'failed', false), name: 'linear app' } as Remote)
    expect(boxed.text()).toContain('╭')
    expect(plain(boxed.text())).toStartWith('Linear app MCP Server Status:')
    await boxed.close()
    const bare = await menu(remote('http', 'failed', false), { borderless: true })
    expect(bare.text().includes('╭') || bare.text().includes('│')).toBe(false)
    expect(plain(bare.text())).toEndWith(FOOTER)
  }, SLOW)

  test('Ctrl+C once swaps the key hints for the exit warning', async () => {
    const screen = await menu(remote('http', 'failed', false))
    await screen.press(KEYS.ctrlC)
    expect(plain(screen.text())).toEndWith('Press Ctrl-C again to exit')
    expect(screen.calls).toEqual({ completed: [], cancelled: 0, viewedTools: 0 })
  }, SLOW)

  test('"c" with no URL on screen copies nothing', async () => {
    const screen = await menu(remote('http', 'failed', true))
    await screen.press('c')
    expect(plain(screen.text()).includes('Copied')).toBe(false)
    expect(screen.calls).toEqual({ completed: [], cancelled: 0, viewedTools: 0 })
  }, SLOW)
})

describe('View tools, Esc, Reconnect', () => {
  test('View tools hands over to the caller', async () => {
    const screen = await menu(remote('http', 'connected', true), { tools: 1 })
    await screen.press(KEYS.enter)
    expect(screen.calls).toEqual({ completed: [], cancelled: 0, viewedTools: 1 })
  }, SLOW)

  test('Esc goes back', async () => {
    const screen = await menu(remote('http', 'connected', true), { tools: 1 })
    await screen.press(KEYS.esc)
    expect(screen.calls).toEqual({ completed: [], cancelled: 1, viewedTools: 0 })
  }, SLOW)

  test('Reconnect dials the server again and reports success', async () => {
    const http = httpServer()
    const config = { type: 'http', url: http.url, scope: 'dynamic' } as ScopedMcpServerConfig
    const screen = await menu(remote('http', 'connected', false, http.url), { tools: 1, dynamic: { docs: config }, deferred: true })
    await screen.reaches('docs', 'connected')
    await screen.show()
    const initializes = () => http.seen.filter(r => r.method === 'POST' && !r.headers['mcp-session-id']).length
    const before = initializes()
    await screen.press(KEYS.down, KEYS.down, KEYS.down, KEYS.enter)
    expect(await screen.completes()).toBe('Reconnected to docs.')
    expect(initializes()).toBeGreaterThan(before)
  }, SLOW)

  test('while it reconnects a spinner replaces the menu; a failure comes back as a message', async () => {
    process.env.MCP_TIMEOUT = '1200'
    const url = silentServer()
    const config = { type: 'http', url, scope: 'dynamic' } as ScopedMcpServerConfig
    const screen = await menu(remote('http', 'failed', false, url), { dynamic: { docs: config }, deferred: true })
    await screen.reaches('docs', 'failed')
    await screen.show()
    await screen.press(KEYS.down, KEYS.enter)
    const spinning = plain(await screen.until(f => f.includes('Connecting to'), 'the spinner'))
    expect(spinning).toContain('Connecting to docs…')
    expect(spinning).toContain('Establishing connection to MCP server')
    expect(spinning).toContain('This may take a few moments.')
    expect(spinning.includes('Disable')).toBe(false)
    expect(await screen.completes()).toBe('Failed to reconnect to docs.')
    await screen.until(f => f.includes('Disable'), 'the menu again')
  }, SLOW)

  test('a server that turns out to need a login is reported as such', async () => {
    const bed = startAuthBed()
    stopAfter(bed.stop)
    const gate = startGatedServer(bed, { tools: [{ name: 'lookup' }] })
    const config = { type: 'http', url: gate.url, scope: 'dynamic' } as ScopedMcpServerConfig
    const screen = await menu(remote('http', 'failed', true, gate.url), { dynamic: { docs: config }, deferred: true })
    await screen.reaches('docs', 'needs-auth')
    await screen.show()
    await screen.press(KEYS.down, KEYS.down, KEYS.enter)
    expect(await screen.completes()).toBe("docs requires authentication. Use the 'Authenticate' option.")
  }, SLOW)

  test('a reconnect that throws is reported with the error', async () => {
    const screen = await menu(remote('http', 'failed', false))
    await screen.press(KEYS.down, KEYS.enter)
    expect(await screen.completes()).toBe('Error reconnecting to docs: MCP server docs not found')
  }, SLOW)
})

describe('Disable and Enable', () => {
  test('Disable switches the server off on disk and in the session, and goes back', async () => {
    const http = httpServer()
    const config = { type: 'http', url: http.url, scope: 'dynamic' } as ScopedMcpServerConfig
    const screen = await menu(remote('http', 'connected', false, http.url), { tools: 1, dynamic: { docs: config }, deferred: true })
    await screen.reaches('docs', 'connected')
    await screen.show()
    await screen.press(KEYS.up, KEYS.enter)
    await screen.reaches('docs', 'disabled')
    expect(screen.calls).toEqual({ completed: [], cancelled: 1, viewedTools: 0 })
    expect(isMcpServerDisabled('docs')).toBe(true)
  }, SLOW)

  test('Enable, offered first, switches it back on and goes back', async () => {
    const http = httpServer()
    const config = { type: 'http', url: http.url, scope: 'dynamic' } as ScopedMcpServerConfig
    setMcpServerEnabled('docs', false)
    const screen = await menu(remote('http', 'disabled', false, http.url), { dynamic: { docs: config }, deferred: true })
    await screen.reaches('docs', 'disabled')
    await screen.show()
    await screen.press(KEYS.enter)
    await screen.reaches('docs', 'connected')
    expect(screen.calls).toEqual({ completed: [], cancelled: 1, viewedTools: 0 })
    expect(isMcpServerDisabled('docs')).toBe(false)
  }, SLOW)

  test('a switch that fails is reported, naming the direction', async () => {
    const seen: Array<string | undefined> = []
    for (const [server, keys] of [
      [remote('http', 'failed', false), [KEYS.up, KEYS.enter]],
      [remote('http', 'disabled', false), [KEYS.enter]],
    ] as const) {
      const screen = await menu(server)
      await screen.press(...keys)
      seen.push(await screen.completes())
      expect(screen.calls.cancelled).toBe(0)
      await screen.close()
    }
    expect(seen).toEqual([
      "Failed to disable MCP server 'docs': MCP server docs not found",
      "Failed to enable MCP server 'docs': MCP server docs not found",
    ])
  }, SLOW)
})
