/**
 * The /mcp menu of one stdio server: what it shows for each state, which
 * actions it offers, and what each action does, mounted inside a live
 * connection manager whose servers are real child processes.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import figures from 'figures'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import {
  killAllStdioServers,
  socketConfig,
  startSocketServer,
  stdioServer,
  stopAllSocketServers,
} from 'src/mcp/__testutils__/connectionRig.js'
import { isAlive, writeStdioServer } from 'src/mcp/client/__testutils__/mcpServerBed.js'
import { isMcpServerDisabled, setMcpServerEnabled } from 'src/mcp/config.js'
import type { MCPServerConnection, McpStdioServerConfig, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { MCPStdioServerMenu } from 'src/mcp/ui/MCPStdioServerMenu.js'
import type { StdioServerInfo } from 'src/mcp/ui/types.js'
import { KEYS, menuWorld, mountMenu, ownEnv, plain, SLOW } from 'src/mcp/ui/__testutils__/serverMenuRig.js'
import { saveCurrentProjectConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { getGlobalClaudeFile } from 'src/shared/env.js'

const world = menuWorld()
ownEnv('MCP_TIMEOUT')
const pids: number[] = []
afterEach(() => {
  killAllStdioServers()
  stopAllSocketServers()
  for (const pid of pids.splice(0)) if (isAlive(pid)) process.kill(pid, 'SIGKILL')
})

const FOOTER = '↑↓ to navigate · Enter to select · Esc to back'

const info = (
  name: string,
  type: MCPServerConnection['type'],
  config: McpStdioServerConfig = { type: 'stdio', command: 'mcp-local', args: ['--port', '7'] },
): StdioServerInfo => ({
  name,
  transport: 'stdio',
  scope: 'dynamic',
  config,
  client: { name, type, config: { ...config, scope: 'dynamic' } } as unknown as MCPServerConnection,
})

/** The menu's options, in order, read off the screen. */
const optionsOf = (frame: string) => [...plain(frame).matchAll(/\d\. ([A-Z][a-z]+(?: [a-z]+)?)/g)].map(m => m[1])

type Show = { tools?: number; borderless?: boolean; dynamic?: Record<string, ScopedMcpServerConfig>; deferred?: boolean }

function menu(server: StdioServerInfo | (() => StdioServerInfo), show: Show = {}) {
  return mountMenu(
    cb => (
      <MCPStdioServerMenu
        server={typeof server === 'function' ? server() : server}
        serverToolsCount={show.tools ?? 0}
        borderless={show.borderless}
        {...cb}
      />
    ),
    { dynamic: show.dynamic, deferred: show.deferred },
  )
}

describe('what the menu shows', () => {
  test('a connected server: status, command, args, where it is configured, what it offers', async () => {
    const child = stdioServer(world.root(), 'full', { tools: ['t1', 't2'], prompts: ['p1'] })
    const config = { ...child.config, scope: 'dynamic' } as ScopedMcpServerConfig
    const screen = await mountMenu(
      cb => <MCPStdioServerMenu server={{ ...info('local', 'connected', config as McpStdioServerConfig) }} serverToolsCount={2} {...cb} />,
      { dynamic: { local: config }, deferred: true },
    )
    await screen.reaches('local', 'connected')
    await screen.show()
    const lines = screen.text().split('\n').map(l => l.replace(/[│╭╮╰╯─]/g, '').trim()).filter(Boolean)
    const args = (config as McpStdioServerConfig).args!.join(' ')
    expect(lines).toEqual([
      'Local MCP Server',
      `Status: ${figures.tick} connected`,
      `Command: ${process.execPath}`,
      `Args: ${args}`,
      'Config location: Dynamically configured',
      'Capabilities: tools · prompts',
      'Tools: 2 tools',
      '❯ 1. View tools',
      '2. Reconnect',
      '3. Disable',
      FOOTER,
    ])
  }, SLOW)

  test('prompts and resources are counted from app state, by server name', async () => {
    // This server has resources and no prompts; the other one has prompts.
    const ws = startSocketServer({ tools: ['a'], resources: ['r1'] })
    const other = startSocketServer({ tools: ['b'], prompts: ['q'], resources: ['s1', 's2'] })
    const screen = await menu(info('local', 'connected'), {
      tools: 1,
      dynamic: { local: socketConfig(ws, 'dynamic'), other: socketConfig(other, 'dynamic') },
      deferred: true,
    })
    await screen.reaches('local', 'connected')
    await screen.reaches('other', 'connected')
    await screen.show()
    expect(screen.state().mcp.commands.map(c => c.name)).toEqual(['mcp__other__q'])
    expect(plain(screen.text())).toContain('Capabilities: tools · resources Tools: 1 tools')
  }, SLOW)

  const states: Array<[string, MCPServerConnection['type'], number, string, string[], boolean]> = [
    ['connected without tools', 'connected', 0, `${figures.tick} connected`, ['Reconnect', 'Disable'], true],
    ['failed, tools still counted', 'failed', 3, `${figures.cross} failed`, ['View tools', 'Reconnect', 'Disable'], false],
    ['pending', 'pending', 0, `${figures.radioOff} connecting…`, ['Reconnect', 'Disable'], false],
    ['needs-auth reads as failed', 'needs-auth', 1, `${figures.cross} failed`, ['View tools', 'Reconnect', 'Disable'], false],
    ['disabled, tools hidden', 'disabled', 4, `${figures.radioOff} disabled`, ['Enable'], false],
  ]
  for (const [why, type, tools, status, options, capabilities] of states) {
    test(`${why}: "${status}", offers ${options.join(', ')}`, async () => {
      const screen = await menu(info('local', type), { tools })
      const text = plain(screen.text())
      expect(text).toContain(`Status: ${status} Command: mcp-local Args: --port 7`)
      expect(optionsOf(screen.text())).toEqual(options)
      expect(text.includes('Capabilities:')).toBe(capabilities)
      expect(text.includes('Tools:')).toBe(false)
      if (capabilities) expect(text).toContain('Capabilities: none')
    }, SLOW)
  }

  test('no args line when there are none', async () => {
    const seen: boolean[] = []
    for (const config of [
      { type: 'stdio' as const, command: 'bare' },
      { type: 'stdio' as const, command: 'bare', args: [] },
      { type: 'stdio' as const, command: 'bare', args: ['x', 'y z'] },
    ]) {
      // A config with no args at all is what an older settings file holds.
      const screen = await menu(info('a', 'failed', config as McpStdioServerConfig))
      seen.push(plain(screen.text()).includes('Args:'))
      if (config.args?.length) expect(plain(screen.text())).toContain('Args: x y z')
      await screen.close()
    }
    expect(seen).toEqual([false, false, true])
  }, SLOW)

  test('"Config location" follows the scope the server is configured in, by name', async () => {
    const stdio = { command: 'mcp-local', args: [] }
    const cases: Array<[string, () => void, () => string]> = [
      ['nowhere', () => {}, () => 'Dynamically configured'],
      ['user', () => saveGlobalConfig(c => ({ ...c, mcpServers: { local: stdio } as never })), () => getGlobalClaudeFile()],
      ['project', () => writeFileSync(join(world.project(), '.mcp.json'), JSON.stringify({ mcpServers: { local: stdio } })), () => join(world.project(), '.mcp.json')],
      ['local', () => saveCurrentProjectConfig(c => ({ ...c, mcpServers: { local: stdio } as never })), () => `${getGlobalClaudeFile()} [project: ${world.project()}]`],
    ]
    const seen: string[] = []
    for (const [, put, expected] of cases) {
      put()
      const screen = await menu(info('local', 'failed'))
      seen.push(plain(screen.text()).includes(`Config location: ${expected()}`) ? 'ok' : plain(screen.text()))
      await screen.close()
      saveGlobalConfig(c => ({ ...c, mcpServers: {} }))
      saveCurrentProjectConfig(c => ({ ...c, mcpServers: {} }))
    }
    expect(seen).toEqual(['ok', 'ok', 'ok', 'ok'])
  }, SLOW)

  test('the title capitalizes the first letter only; borderless drops the frame', async () => {
    const boxed = await menu(info('mcp-github', 'failed'))
    expect(boxed.text()).toContain('╭')
    expect(plain(boxed.text())).toContain('Mcp-github MCP Server')
    await boxed.close()
    const bare = await menu(info('mcp-github', 'failed'), { borderless: true })
    expect(bare.text().includes('╭') || bare.text().includes('│')).toBe(false)
    expect(plain(bare.text())).toStartWith('Mcp-github MCP Server Status:')
    expect(plain(bare.text())).toEndWith(FOOTER)
  }, SLOW)

  test('Ctrl+C once swaps the key hints for the exit warning', async () => {
    const screen = await menu(info('local', 'failed'))
    expect(plain(screen.text())).toEndWith(FOOTER)
    await screen.press(KEYS.ctrlC)
    expect(plain(screen.text())).toEndWith('Press Ctrl-C again to exit')
    expect(screen.calls).toEqual({ completed: [], cancelled: 0, viewedTools: 0 })
  }, SLOW)
})

describe('what each action does', () => {
  test('View tools hands over to the caller and does nothing else', async () => {
    const screen = await menu(info('local', 'connected'), { tools: 2 })
    await screen.press(KEYS.enter)
    expect(screen.calls).toEqual({ completed: [], cancelled: 0, viewedTools: 1 })
  }, SLOW)

  test('Esc goes back', async () => {
    const screen = await menu(info('local', 'connected'), { tools: 2 })
    await screen.press(KEYS.esc)
    expect(screen.calls).toEqual({ completed: [], cancelled: 1, viewedTools: 0 })
  }, SLOW)

  test('Reconnect restarts the process and reports the result', async () => {
    const bed = writeStdioServer(world.root())
    const config = { ...bed.config(), scope: 'dynamic' } as ScopedMcpServerConfig
    const screen = await menu(info('local', 'connected', config as McpStdioServerConfig), { dynamic: { local: config }, deferred: true })
    await screen.reaches('local', 'connected')
    await screen.show()
    const first = bed.pids()
    expect(first).toHaveLength(1)
    await screen.press(KEYS.enter)
    expect(await screen.completes()).toBe('Reconnected to local.')
    expect(bed.pids()).toHaveLength(2)
    pids.push(...bed.pids())
    await Bun.sleep(100)
    expect(isAlive(first[0]!)).toBe(false)
    expect(screen.calls.cancelled).toBe(0)
  }, SLOW)

  test('while it reconnects the menu gives way to a spinner; a failure is reported', async () => {
    process.env.MCP_TIMEOUT = '1200'
    const bed = writeStdioServer(world.root())
    const config = { ...bed.config({ BED_SILENT: '1' }), scope: 'dynamic' } as ScopedMcpServerConfig
    const screen = await menu(info('mute', 'failed', config as McpStdioServerConfig), { dynamic: { mute: config }, deferred: true })
    await screen.reaches('mute', 'failed')
    await screen.show()
    await screen.press(KEYS.enter)
    const spinning = plain(await screen.until(f => f.includes('Reconnecting'), 'the spinner'))
    expect(spinning).toContain('Reconnecting to mute')
    expect(spinning).toContain('Restarting MCP server process')
    expect(spinning).toContain('This may take a few moments.')
    expect(spinning.includes('Disable')).toBe(false)
    expect(await screen.completes()).toBe('Failed to reconnect to mute.')
    expect(optionsOf(await screen.until(f => f.includes('Disable'), 'the menu again'))).toEqual(['Reconnect', 'Disable'])
    pids.push(...bed.pids())
  }, SLOW)

  test('a reconnect that throws is reported with the error', async () => {
    const screen = await menu(info('local', 'failed'))
    await screen.press(KEYS.enter)
    expect(await screen.completes()).toBe('Error reconnecting to local: MCP server local not found')
  }, SLOW)

  test('Disable switches the server off on disk, stops it, and goes back', async () => {
    const child = stdioServer(world.root(), 'off', { tools: ['t'] })
    const config = { ...child.config, scope: 'dynamic' } as ScopedMcpServerConfig
    const screen = await menu(info('local', 'connected', config as McpStdioServerConfig), { dynamic: { local: config }, deferred: true })
    await screen.reaches('local', 'connected')
    await screen.show()
    const pid = child.pid()!
    expect(isMcpServerDisabled('local')).toBe(false)
    await screen.press(KEYS.down, KEYS.enter)
    await screen.reaches('local', 'disabled')
    await Bun.sleep(150)
    expect(screen.calls).toEqual({ completed: [], cancelled: 1, viewedTools: 0 })
    expect(isMcpServerDisabled('local')).toBe(true)
    expect(isAlive(pid)).toBe(false)
  }, SLOW)

  test('Enable switches it back on, on disk and in the session, and goes back', async () => {
    const child = stdioServer(world.root(), 'on', { tools: ['t'] })
    const config = { ...child.config, scope: 'dynamic' } as ScopedMcpServerConfig
    setMcpServerEnabled('local', false)
    const screen = await menu(info('local', 'disabled', config as McpStdioServerConfig), { dynamic: { local: config }, deferred: true })
    await screen.reaches('local', 'disabled')
    await screen.show()
    expect(child.pid()).toBeUndefined()
    await screen.press(KEYS.enter)
    await screen.reaches('local', 'connected')
    expect(screen.calls).toEqual({ completed: [], cancelled: 1, viewedTools: 0 })
    expect(isMcpServerDisabled('local')).toBe(false)
    expect(child.pid()).toBeNumber()
  }, SLOW)

  test('a switch that fails is reported, naming the direction, and the menu stays', async () => {
    const seen: Array<string | undefined> = []
    for (const [type, keys] of [['connected', [KEYS.down, KEYS.enter]], ['disabled', [KEYS.enter]]] as const) {
      const screen = await menu(info('local', type))
      await screen.press(...keys)
      seen.push(await screen.completes())
      expect(screen.calls.cancelled).toBe(0)
      await screen.close()
    }
    expect(seen).toEqual([
      "Failed to disable MCP server 'local': MCP server local not found",
      "Failed to enable MCP server 'local': MCP server local not found",
    ])
  }, SLOW)
})
