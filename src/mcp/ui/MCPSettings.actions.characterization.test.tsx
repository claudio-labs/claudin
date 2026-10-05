/**
 * Characterization of what /mcp does to a server: switching it off and on,
 * reconnecting it, browsing its tools, and what the server menus learn from
 * the panel about its sign-in.
 *
 * The panel runs inside `<MCPConnectionManager>`, as in the REPL. Every
 * server is real: a stdio child process, or an MCP server on a loopback port
 * (Streamable HTTP or legacy SSE). The switch is written to this project's
 * entry in the global config, read back here through the config API. OAuth
 * tokens go to the plaintext credential file, with the OS keyring stood in
 * for by a `secret-tool` that refuses.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { enterWorld, leaveWorld, localRecord, setToggles, setUserServers, withEnv, type World } from 'src/mcp/__testutils__/mcpConfigWorld.js'
import { killAllStdioServers, stdioServer, until } from 'src/mcp/__testutils__/connectionRig.js'
import { ClaudeAuthProvider } from 'src/mcp/auth.js'
import { serveHttp, serveSse, type LoopbackBed } from 'src/mcp/client/__testutils__/mcpServerBed.js'
import { closeAllSettings, openSettings, refuseKeyring, type Settings } from 'src/mcp/ui/__testutils__/settingsUiRig.js'
import { flat, KEYS, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'

let world: World
let keyringLog = ''
const undo: Array<() => void> = []
const beds: LoopbackBed[] = []
beforeEach(() => {
  world = enterWorld()
  const keyring = refuseKeyring(world.root)
  keyringLog = keyring.log
  undo.push(keyring.undo)
  // Neither a session token nor a token file: the panel must find no session sign-in.
  undo.push(withEnv({ CLAUDE_CODE_SESSION_ACCESS_TOKEN: undefined, CLAUDE_SESSION_INGRESS_TOKEN_FILE: undefined }))
})
afterEach(async () => {
  await closeAllSettings()
  killAllStdioServers()
  while (beds.length) await beds.pop()?.stop()
  while (undo.length) undo.pop()?.()
  leaveWorld()
})

const WAIT = 40_000

/** A config as a user writes it: without the scope the loader adds. */
function asWritten(config: object): Record<string, unknown> {
  const { scope: _scope, ...rest } = config as Record<string, unknown>
  return rest
}

/** A stdio server `kit` with tools alpha and beta, in the user config. */
function kit(): void {
  const child = stdioServer(world.root, 'kit', { tools: ['alpha', 'beta'] })
  setUserServers({ kit: asWritten(child.config) })
}

async function onList(panel: Settings): Promise<string> {
  return flat(await panel.screen.until(frame => frame.includes('Manage MCP servers'), 'the server list'))
}

async function onMenu(panel: Settings, title: string): Promise<string> {
  return flat(await panel.screen.until(frame => frame.includes(`${title} MCP Server`), `the ${title} menu`))
}

/** Picks the menu option with this label by walking down to it. */
async function choose(panel: Settings, label: string): Promise<void> {
  const options = flat(panel.screen.text()).match(/\d+\. [A-Za-z-]+( [a-z]+)?/g) ?? []
  const index = options.findIndex(option => option.replace(/^\d+\. /, '') === label)
  if (index < 0) throw new Error(`no ${label} option in ${options.join(' | ')}`)
  await panel.screen.press(...Array(index).fill(KEYS.down), KEYS.enter)
}

describe('the list', () => {
  test(
    'shows each configured server with its live state, leaving out one named ide',
    async () => {
      setUserServers({
        kit: asWritten(stdioServer(world.root, 'kit2', { tools: ['alpha'] }).config),
        ide: asWritten(stdioServer(world.root, 'ide', { tools: ['x'] }).config),
        gone: { command: 'claudin-settings-ui-no-such-binary' },
      })
      const panel = await openSettings({ kit: ['connected'], ide: ['connected'], gone: ['failed'] })
      const list = await onList(panel)
      expect(list).toContain('Manage MCP servers 2 servers')
      expect(list).toContain('gone · ✘ failed')
      expect(list).toContain('kit · ✔ connected')
      expect(list).toMatch(/※ Run \S+ --debug to see error logs/)
      expect(list).not.toContain('ide ·')
    },
    WAIT,
  )
})

describe('switching a server off and on', () => {
  test(
    'Disable lists the server in this project’s disabled list, stops it, and returns to the list',
    async () => {
      kit()
      const panel = await openSettings({ kit: ['connected'] })
      await onList(panel)
      await panel.screen.press(KEYS.enter)
      await onMenu(panel, 'Kit')
      await choose(panel, 'Disable')
      await panel.reaches('kit', 'disabled')
      const list = await panel.screen.until(frame => frame.includes('kit · ◯ disabled'), 'the list with kit disabled')
      expect(flat(list)).toContain('Manage MCP servers')
      expect(localRecord().disabledMcpServers).toEqual(['kit'])
      expect(panel.done.log).toEqual([])
    },
    WAIT,
  )

  test(
    'Enable takes the server off the disabled list and connects it again',
    async () => {
      kit()
      setToggles({ disabled: ['kit'] })
      const panel = await openSettings({ kit: ['disabled'] })
      expect(await onList(panel)).toContain('kit · ◯ disabled')
      await panel.screen.press(KEYS.enter)
      const menu = await onMenu(panel, 'Kit')
      expect(menu).toContain('Status: ◯ disabled')
      await choose(panel, 'Enable')
      await panel.reaches('kit', 'connected')
      await panel.screen.until(frame => frame.includes('kit · ✔ connected'), 'the list with kit connected')
      expect(localRecord().disabledMcpServers ?? []).toEqual([])
      expect(panel.done.log).toEqual([])
    },
    WAIT,
  )

  test(
    'a remote server is switched off through the same list',
    async () => {
      const bed = serveHttp({ tools: [{ name: 'lookup' }] })
      beds.push(bed)
      setUserServers({ web: { type: 'http', url: bed.url } })
      const panel = await openSettings({ web: ['connected'] })
      await onList(panel)
      await panel.screen.press(KEYS.enter)
      await onMenu(panel, 'Web')
      await choose(panel, 'Disable')
      await panel.reaches('web', 'disabled')
      await panel.screen.until(frame => frame.includes('web · ◯ disabled'), 'the list with web disabled')
      expect(localRecord().disabledMcpServers).toEqual(['web'])

      await panel.screen.press(KEYS.enter)
      await onMenu(panel, 'Web')
      await choose(panel, 'Enable')
      await panel.reaches('web', 'connected')
      await panel.screen.until(frame => frame.includes('web · ✔ connected'), 'the list with web connected')
      expect(localRecord().disabledMcpServers ?? []).toEqual([])
    },
    WAIT,
  )
})

describe('reconnecting', () => {
  test(
    'Reconnect closes the panel with the outcome',
    async () => {
      kit()
      const panel = await openSettings({ kit: ['connected'] })
      await onList(panel)
      await panel.screen.press(KEYS.enter)
      await onMenu(panel, 'Kit')
      await choose(panel, 'Reconnect')
      await until('the outcome', () => panel.done.log.length > 0)
      expect(panel.done.log).toEqual([{ result: 'Reconnected to kit.' }])
      expect(panel.client('kit')?.type).toBe('connected')
    },
    WAIT,
  )

  test(
    'a remote server reports its reconnect the same way',
    async () => {
      const bed = serveHttp({ tools: [{ name: 'lookup' }] })
      beds.push(bed)
      setUserServers({ web: { type: 'http', url: bed.url } })
      const panel = await openSettings({ web: ['connected'] })
      await onList(panel)
      await panel.screen.press(KEYS.enter)
      await onMenu(panel, 'Web')
      await choose(panel, 'Reconnect')
      await until('the outcome', () => panel.done.log.length > 0)
      expect(panel.done.log).toEqual([{ result: 'Reconnected to web.' }])
    },
    WAIT,
  )
})

describe('moving between screens', () => {
  test(
    'Esc walks back from a tool’s detail to the tool list, the menu, the list, and out',
    async () => {
      kit()
      const panel = await openSettings({ kit: ['connected'] })
      await onList(panel)
      await panel.screen.press(KEYS.enter)
      await onMenu(panel, 'Kit')
      await choose(panel, 'View tools')
      const tools = flat(await panel.screen.until(frame => frame.includes('Tools for kit'), 'the tool list'))
      expect(tools).toContain('Tools for kit 2 tools')
      await panel.screen.press(KEYS.down, KEYS.enter)
      const detail = flat(await panel.screen.until(frame => frame.includes('Full name:'), 'the tool detail'))
      expect(detail).toContain('Tool name: beta Full name: mcp__kit__beta')
      await panel.screen.press(KEYS.esc)
      await panel.screen.until(frame => frame.includes('Tools for kit'), 'the tool list again')
      await panel.screen.press(KEYS.esc)
      await onMenu(panel, 'Kit')
      await panel.screen.press(KEYS.esc)
      await onList(panel)
      expect(panel.done.log).toEqual([])
      await panel.screen.press(KEYS.esc)
      expect(panel.done.log).toEqual([{ result: 'MCP dialog dismissed', options: { display: 'system' } }])
    },
    WAIT,
  )

  test(
    'Esc from a remote server’s menu returns to the list',
    async () => {
      const bed = serveHttp({ tools: [{ name: 'lookup' }] })
      beds.push(bed)
      setUserServers({ web: { type: 'http', url: bed.url } })
      const panel = await openSettings({ web: ['connected'] })
      await onList(panel)
      await panel.screen.press(KEYS.enter)
      await onMenu(panel, 'Web')
      await choose(panel, 'View tools')
      await panel.screen.until(frame => flat(frame).includes('Tools for web 1 tool'), 'the tool list')
      await panel.screen.press(KEYS.esc)
      await onMenu(panel, 'Web')
      await panel.screen.press(KEYS.esc)
      expect(await onList(panel)).toContain('web · ✔ connected')
      expect(panel.done.log).toEqual([])
    },
    WAIT,
  )

  test(
    'when the tool on show leaves the pool, the panel falls back to the tool list',
    async () => {
      kit()
      const panel = await openSettings({ kit: ['connected'] })
      await onList(panel)
      await panel.screen.press(KEYS.enter)
      await onMenu(panel, 'Kit')
      await choose(panel, 'View tools')
      await panel.screen.until(frame => frame.includes('Tools for kit'), 'the tool list')
      await panel.screen.press(KEYS.down, KEYS.enter)
      await panel.screen.until(frame => frame.includes('mcp__kit__beta'), 'the detail of beta')
      panel.setState(state => ({ ...state, mcp: { ...state.mcp, tools: state.mcp.tools.filter(t => t.name !== 'mcp__kit__beta') } }))
      const back = flat(await panel.screen.until(frame => frame.includes('Tools for kit'), 'the tool list after beta left'))
      expect(back).toContain('Tools for kit 1 tool')
      expect(back).not.toContain('Full name:')
    },
    WAIT,
  )
})

describe('what the remote menu is told about sign-in', () => {
  async function authLine(name: string, kinds: Array<'connected' | 'failed'>): Promise<string> {
    const panel = await openSettings({ [name]: kinds })
    await onList(panel)
    await panel.screen.press(KEYS.enter)
    const menu = await onMenu(panel, name.charAt(0).toUpperCase() + name.slice(1))
    return menu.match(/Auth: (✔ authenticated|✘ not authenticated)/)?.[1] ?? `no Auth line in: ${menu}`
  }

  async function saveToken(name: string, config: { type: 'http' | 'sse'; url: string }): Promise<void> {
    await new ClaudeAuthProvider(name, config).saveTokens({ access_token: 'stored-token', token_type: 'Bearer', expires_in: 3600 })
    // The token went to the plaintext file, not to the user's keyring.
    expect(existsSync(keyringLog)).toBe(true)
    expect(readFileSync(`${world.home}/.credentials.json`, 'utf8')).toContain('stored-token')
  }

  /** A loopback server that is no longer listening. */
  async function deadUrl(kind: 'http' | 'sse'): Promise<string> {
    const bed = kind === 'http' ? serveHttp({}) : await serveSse({})
    await bed.stop()
    return bed.url
  }

  test(
    'a connected server that offers tools counts as signed in',
    async () => {
      const bed = serveHttp({ tools: [{ name: 'lookup' }] })
      beds.push(bed)
      setUserServers({ web: { type: 'http', url: bed.url } })
      expect(await authLine('web', ['connected'])).toBe('✔ authenticated')
    },
    WAIT,
  )

  test(
    'a connected server with no tools and nothing stored does not',
    async () => {
      const bed = serveHttp({})
      beds.push(bed)
      setUserServers({ web: { type: 'http', url: bed.url } })
      expect(await authLine('web', ['connected'])).toBe('✘ not authenticated')
    },
    WAIT,
  )

  test(
    'a session access token counts as signed in for a connected server',
    async () => {
      undo.push(withEnv({ CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'session-token' }))
      const bed = serveHttp({})
      beds.push(bed)
      setUserServers({ web: { type: 'http', url: bed.url } })
      expect(await authLine('web', ['connected'])).toBe('✔ authenticated')
    },
    WAIT,
  )

  test(
    'a session access token does not count for a server that failed',
    async () => {
      undo.push(withEnv({ CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'session-token' }))
      setUserServers({ web: { type: 'http', url: await deadUrl('http') } })
      expect(await authLine('web', ['failed'])).toBe('✘ not authenticated')
    },
    WAIT,
  )

  for (const kind of ['http', 'sse'] as const) {
    test(
      `a stored OAuth token counts as signed in even when the ${kind} server is down`,
      async () => {
        const config = { type: kind, url: await deadUrl(kind) }
        setUserServers({ web: config })
        await saveToken('web', config)
        expect(await authLine('web', ['failed'])).toBe('✔ authenticated')
      },
      WAIT,
    )

    test(
      `without a stored token a ${kind} server that is down is not signed in`,
      async () => {
        setUserServers({ web: { type: kind, url: await deadUrl(kind) } })
        expect(await authLine('web', ['failed'])).toBe('✘ not authenticated')
      },
      WAIT,
    )
  }

  test(
    'a token stored for another URL does not count',
    async () => {
      const url = await deadUrl('http')
      setUserServers({ web: { type: 'http', url } })
      await saveToken('web', { type: 'http', url: `${url}/elsewhere` })
      expect(await authLine('web', ['failed'])).toBe('✘ not authenticated')
    },
    WAIT,
  )
})
