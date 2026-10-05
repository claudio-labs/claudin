/**
 * The /mcp menu of a claude.ai connector. Its sign-in and sign-out happen on
 * claude.ai, in the browser: the menu opens the right page, waits for Enter,
 * then dials the connector again (sign-in) or drops it from the session
 * (sign-out). No credential is read or written here.
 *
 * The connection manager dials whatever the test configures under the
 * connector's name, so the outcome of the dial after Enter is real; the
 * claude.ai proxy itself is never contacted. The "browser" is the auth test
 * bed's stand-in.
 */
import { describe, expect, test } from 'bun:test'
import React from 'react'
import { startAuthBed } from 'src/mcp/auth/__testutils__/oauthTestBed.js'
import { socketConfig, startSocketServer, stopAllSocketServers } from 'src/mcp/__testutils__/connectionRig.js'
import type { McpClaudeAIProxyServerConfig, MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { MCPRemoteServerMenu } from 'src/mcp/ui/MCPRemoteServerMenu.js'
import type { ClaudeAIServerInfo } from 'src/mcp/ui/types.js'
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
import { saveGlobalConfig } from 'src/platform/config/config.js'
import { getOauthConfig } from 'src/shared/constants/oauth.js'

const world = menuWorld()
// The surface, the clipboard route, and whatever would turn the claude.ai
// login off (an API key or token, a third-party cloud), so the account below
// is the one in force.
const LOGIN_SWITCHES = ['API_KEY', 'AUTH_TOKEN', 'UNIX_SOCKET'].map(k => `ANTHROPIC_${k}`)
const CLOUD_SWITCHES = ['BEDROCK', 'VERTEX', 'FOUNDRY'].map(k => `CLAUDE_CODE_USE_${k}`)
ownEnv('CLAUDE_CODE_ENTRYPOINT', 'SSH_CONNECTION', 'TMUX', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', ...LOGIN_SWITCHES, ...CLOUD_SWITCHES)
stopAfter(stopAllSocketServers)

// The manager will not dial a dynamic server named like a listed connector
// ("claude.ai …"), and the menu only uses the name in its messages.
const NAME = 'notion'
const origin = () => getOauthConfig().CLAUDE_AI_ORIGIN

function connector(type: MCPServerConnection['type'], id: string | null = 'mcprs_abc'): ClaudeAIServerInfo {
  const config = { type: 'claudeai-proxy', url: 'https://proxy.example.test/v1/mcp/x', ...(id === null ? {} : { id }) } as McpClaudeAIProxyServerConfig
  const client = { name: NAME, type, config: { ...config, scope: 'claudeai' } } as MCPServerConnection
  // A connector's sign-in state is never probed: it stays undefined.
  return { name: NAME, scope: 'claudeai', transport: config.type, config, client, isAuthenticated: undefined }
}

const signedInto = (organizationUuid: string | undefined) =>
  saveGlobalConfig(c => ({
    ...c,
    oauthAccount: organizationUuid
      ? ({ accountUuid: 'acct-1', emailAddress: 'dev@example.test', organizationUuid } as never)
      : undefined,
  }))

type Mount = { tools?: number; dynamic?: Record<string, ScopedMcpServerConfig>; settled?: Array<[string, MCPServerConnection['type']]> }

async function menu(server: ClaudeAIServerInfo, opts: Mount = {}) {
  const screen = await mountMenu(cb => <MCPRemoteServerMenu server={server} serverToolsCount={opts.tools ?? 0} {...cb} />, {
    dynamic: opts.dynamic,
    deferred: true,
  })
  for (const [name, type] of opts.settled ?? []) await screen.reaches(name, type)
  await screen.show()
  return screen
}

describe('Authenticate', () => {
  const rows: Array<[string, string | undefined, string | null, string | undefined, () => string]> = [
    ['org and id: the start-auth page, mcprs renamed to mcpsrv', 'org-1', 'mcprs_abc', undefined, () => `${origin()}/api/organizations/org-1/mcp/start-auth/mcpsrv_abc?product_surface=cli`],
    ['an id without the prefix is used as is; the entrypoint names the surface', 'org-1', 'srv_9', 'sdk-ts', () => `${origin()}/api/organizations/org-1/mcp/start-auth/srv_9?product_surface=sdk-ts`],
    ['only a leading mcprs is renamed', 'org-2', 'xmcprs_1', undefined, () => `${origin()}/api/organizations/org-2/mcp/start-auth/xmcprs_1?product_surface=cli`],
    ['the surface is URL-encoded', 'org-1', 'mcprs', 'a b&c', () => `${origin()}/api/organizations/org-1/mcp/start-auth/mcpsrv?product_surface=a%20b%26c`],
    ['no organization: the connectors page', undefined, 'mcprs_abc', undefined, () => `${origin()}/settings/connectors`],
    ['no id: the connectors page', 'org-1', null, undefined, () => `${origin()}/settings/connectors`],
  ]
  for (const [why, org, id, entrypoint, expected] of rows) {
    test(why, async () => {
      signedInto(org)
      if (entrypoint !== undefined) process.env.CLAUDE_CODE_ENTRYPOINT = entrypoint
      const screen = await menu(connector('needs-auth', id))
      await screen.press(KEYS.enter)
      const waiting = plain(await screen.until(f => f.includes('Press Enter after'), 'the waiting screen'))
      expect(world.browserUrls()).toEqual([expected()])
      // The spinner glyph between the title and the note changes from frame to frame.
      const [title, rest] = waiting.split(/ \S A browser /)
      expect(title).toBe(`Authenticating with ${NAME}…`)
      expect(rest).toBe(
        `window will open for authentication If your browser doesn't open automatically, copy this URL manually (c to copy) ${expected()} Press Enter after authenticating in your browser. Esc to back`,
      )
      expect(screen.calls.completed).toEqual([])
    }, SLOW)
  }

  const outcomes: Array<[string, () => Record<string, ScopedMcpServerConfig>, MCPServerConnection['type'] | null, string]> = [
    [
      'connects',
      () => ({ [NAME]: socketConfig(startSocketServer({ tools: ['t'] }), 'dynamic') }),
      'connected',
      `Authentication successful. Connected to ${NAME}.`,
    ],
    [
      'still wants a login',
      () => {
        const bed = startAuthBed()
        stopAfter(bed.stop)
        return { [NAME]: { type: 'http', url: startGatedServer(bed, { tools: [{ name: 't' }] }).url, scope: 'dynamic' } as ScopedMcpServerConfig }
      },
      'needs-auth',
      'Authentication successful, but server still requires authentication. You may need to manually restart Claudin.',
    ],
    [
      'fails',
      () => ({ [NAME]: { type: 'stdio', command: '/nonexistent/connector', args: [], scope: 'dynamic' } as ScopedMcpServerConfig }),
      'failed',
      'Authentication successful, but server reconnection failed. You may need to manually restart Claudin for the changes to take effect.',
    ],
    ['is not listed', () => ({}), null, `Error reconnecting to ${NAME}: MCP server ${NAME} not found`],
  ]
  for (const [why, dynamic, settled, message] of outcomes) {
    test(`Enter after the browser dials the connector again: one that ${why}`, async () => {
      signedInto('org-1')
      const screen = await menu(connector('needs-auth'), { dynamic: dynamic(), settled: settled ? [[NAME, settled]] : [] })
      await screen.press(KEYS.enter)
      await screen.until(f => f.includes('Press Enter after'), 'the waiting screen')
      await screen.press(KEYS.enter)
      expect(await screen.completes()).toBe(message)
      // The menu itself stores no credential for a connector.
      const tokens = Object.values(world.read()?.mcpOAuth ?? {}).flatMap((e: any) => [e.accessToken, e.refreshToken].filter(Boolean))
      expect(tokens).toEqual([])
    }, SLOW)
  }

  test('while it dials, a spinner names the connector', async () => {
    signedInto('org-1')
    const parked: Array<(r: Response) => void> = []
    const silent = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: req => (req.method === 'POST' ? new Promise<Response>(a => parked.push(a)) : new Response(null, { status: 405 })) })
    stopAfter(() => {
      for (const a of parked.splice(0)) a(new Response(null, { status: 503 }))
      silent.stop(true)
    })
    process.env.MCP_TIMEOUT = '1500'
    try {
      const screen = await menu(connector('needs-auth'), {
        dynamic: { [NAME]: { type: 'http', url: `http://127.0.0.1:${silent.port}/mcp`, scope: 'dynamic' } as ScopedMcpServerConfig },
        settled: [[NAME, 'failed']],
      })
      await screen.press(KEYS.enter)
      await screen.until(f => f.includes('Press Enter after'), 'the waiting screen')
      await screen.press(KEYS.enter)
      const spinning = plain(await screen.until(f => f.includes('Connecting to'), 'the spinner'))
      expect(spinning).toContain(`Connecting to ${NAME}… `)
      expect(spinning).toContain('Establishing connection to MCP server This may take a few moments.')
      expect(await screen.completes()).toStartWith('Authentication successful, but server reconnection failed.')
    } finally {
      delete process.env.MCP_TIMEOUT
    }
  }, SLOW)

  test('Esc while waiting goes back to the menu without dialling or reporting', async () => {
    signedInto('org-1')
    const ws = startSocketServer({ tools: ['t'] })
    const screen = await menu(connector('failed'), { dynamic: { [NAME]: socketConfig(ws, 'dynamic') }, settled: [[NAME, 'connected']] })
    const sessions = ws.sessions()
    await screen.press(KEYS.enter)
    await screen.until(f => f.includes('Press Enter after'), 'the waiting screen')
    await screen.press(KEYS.esc)
    expect(plain(await screen.until(f => f.includes('1. Authenticate'), 'the menu'))).toContain('❯ 1. Authenticate 2. Reconnect 3. Disable')
    await screen.press(KEYS.esc)
    expect(screen.calls).toEqual({ completed: [], cancelled: 1, viewedTools: 0 })
    expect(ws.sessions()).toBe(sessions)
  }, SLOW)

  test('"c" copies the claude.ai URL', async () => {
    process.env.SSH_CONNECTION = '10.0.0.1 1 10.0.0.2 22'
    signedInto(undefined)
    const screen = await menu(connector('needs-auth'))
    await screen.press(KEYS.enter)
    await screen.until(f => f.includes('Press Enter after'), 'the waiting screen')
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
    } finally {
      process.stdout.write = realWrite as typeof process.stdout.write
    }
    expect(written.map(w => w.includes(Buffer.from(`${origin()}/settings/connectors`).toString('base64')))).toEqual([true])
  }, SLOW)
})

describe('Clear authentication', () => {
  async function connected() {
    const ws = startSocketServer({ tools: ['t'], prompts: ['p'], resources: ['r'] })
    const keep = startSocketServer({ tools: ['k'], prompts: ['q'], resources: ['s'] })
    const screen = await menu(connector('connected'), {
      dynamic: { [NAME]: socketConfig(ws, 'dynamic'), keep: socketConfig(keep, 'dynamic') },
      settled: [
        [NAME, 'connected'],
        ['keep', 'connected'],
      ],
    })
    expect(plain(screen.text())).toContain('❯ 1. Clear authentication 2. Reconnect 3. Disable')
    return { screen }
  }

  test('first Enter opens the connectors page, second Enter drops the connector from the session', async () => {
    const { screen } = await connected()
    await screen.press(KEYS.enter)
    const asking = plain(await screen.until(f => f.includes('Press Enter to open'), 'the first step'))
    expect(asking).toBe(
      `Clear authentication for ${NAME} This will open claude.ai in the browser. Find the MCP server in the list and click "Disconnect". Press Enter to open the browser. Esc to back`,
    )
    expect(world.browserUrls()).toEqual([])

    await screen.press(KEYS.enter)
    const opened = plain(await screen.until(f => f.includes('Press Enter when done'), 'the second step'))
    const page = `${origin()}/settings/connectors`
    expect(world.browserUrls()).toEqual([page])
    expect(opened).toBe(
      `Clear authentication for ${NAME} Find the MCP server in the browser and click "Disconnect". If your browser didn't open automatically, copy this URL manually (c to copy) ${page} Press Enter when done. Esc to back`,
    )
    expect(screen.calls.completed).toEqual([])
    expect(screen.client(NAME)?.type).toBe('connected')
    expect(screen.state().mcp.commands.map(c => c.name).sort()).toEqual(['mcp__keep__q', `mcp__${NAME}__p`])

    await screen.press(KEYS.enter)
    expect(await screen.completes()).toBe(`Disconnected from ${NAME}.`)
    const mcp = screen.state().mcp
    expect(mcp.clients.map(c => [c.name, c.type])).toEqual([
      [NAME, 'needs-auth'],
      ['keep', 'connected'],
    ])
    expect(mcp.tools.map(t => t.name).filter(n => !n.startsWith('mcp__keep__') && n.startsWith('mcp__'))).toEqual([])
    expect(mcp.commands.map(c => c.name)).toEqual(['mcp__keep__q'])
    expect(Object.keys(mcp.resources)).toEqual(['keep'])
    expect(world.browserUrls()).toEqual([page])
    expect(world.read()).toBeNull()
  }, SLOW)

  for (const [stage, presses] of [
    ['before the browser opens', [KEYS.enter]],
    ['after it opened', [KEYS.enter, KEYS.enter]],
  ] as const) {
    test(`Esc ${stage} goes back and starts over next time`, async () => {
      const { screen } = await connected()
      await screen.press(...presses)
      await screen.press(KEYS.esc)
      await screen.until(f => f.includes('1. Clear authentication'), 'the menu')
      await screen.press(KEYS.enter)
      expect(plain(await screen.until(f => f.includes('Clear authentication for'), 'the first step'))).toContain('Press Enter to open the browser.')
      expect(screen.calls.completed).toEqual([])
      expect(screen.client(NAME)?.type).toBe('connected')
    }, SLOW)
  }
})
