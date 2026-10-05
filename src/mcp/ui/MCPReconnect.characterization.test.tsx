/**
 * `/mcp reconnect <server>`: the screen that redials one server on mount and
 * reports the outcome to the command, as the session runs it: inside a live
 * connection manager whose servers are real (a WebSocket server, stdio
 * children, an HTTP server behind OAuth).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import React from 'react'
import { startAuthBed } from 'src/mcp/auth/__testutils__/oauthTestBed.js'
import { socketConfig, startSocketServer, stopAllSocketServers } from 'src/mcp/__testutils__/connectionRig.js'
import { isAlive, writeStdioServer } from 'src/mcp/client/__testutils__/mcpServerBed.js'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'
import { MCPReconnect } from 'src/mcp/ui/MCPReconnect.js'
import { Box, Text } from 'src/terminal/ink.js'
import { flat, menuWorld, mountMenu, ownEnv, SLOW, startGatedServer, stopAfter } from 'src/mcp/ui/__testutils__/serverMenuRig.js'

const world = menuWorld()
ownEnv('MCP_TIMEOUT')
const pids: number[] = []
afterEach(() => {
  stopAllSocketServers()
  for (const pid of pids.splice(0)) if (isAlive(pid)) process.kill(pid, 'SIGKILL')
})

/** Starts the manager, lets it settle, notes `count()`, then mounts the screen. */
async function reconnecting(
  name: string,
  dynamic: Record<string, ScopedMcpServerConfig>,
  settled: string[],
  count: () => number = () => 0,
) {
  // The marker keeps a frame on screen when the component renders nothing.
  const screen = await mountMenu(
    cb => (
      <Box flexDirection="column">
        <Text>[above]</Text>
        <MCPReconnect serverName={name} onComplete={cb.onComplete} />
      </Box>
    ),
    { dynamic, deferred: true },
  )
  for (const server of Object.keys(dynamic)) await screen.reaches(server, ...(settled as never[]))
  const before = count()
  await screen.show()
  return Object.assign(screen, { before })
}

describe('MCPReconnect', () => {
  test('a server that comes back: reports success and leaves nothing on screen', async () => {
    const ws = startSocketServer({ tools: ['ping'] })
    const screen = await reconnecting('live', { live: socketConfig(ws, 'dynamic') }, ['connected'], ws.sessions)
    expect(await screen.completes()).toBe('Successfully reconnected to live')
    await screen.reaches('live', 'connected')
    expect(ws.sessions()).toBeGreaterThan(screen.before)
    expect(flat(await screen.until(f => !f.includes('Reconnecting'), 'the spinner to go'))).toBe('[above]')
    expect(screen.calls.completed).toHaveLength(1)
  }, SLOW)

  test('a server that is not listed: says so, on screen and to the command, without dialling', async () => {
    const ws = startSocketServer()
    const screen = await reconnecting('ghost', { live: socketConfig(ws, 'dynamic') }, ['connected'], ws.sessions)
    expect(await screen.completes()).toBe('MCP server "ghost" not found')
    await screen.until(f => f.includes('Error:'), 'the error view')
    expect(flat(screen.text())).toBe('[above] ✘ Failed to reconnect to ghost Error: MCP server "ghost" not found')
    expect(ws.sessions()).toBe(screen.before)
  }, SLOW)

  test('a server that wants a login: points at /mcp', async () => {
    const bed = startAuthBed()
    stopAfter(bed.stop)
    const gate = startGatedServer(bed, { tools: [{ name: 'lookup' }] })
    const screen = await reconnecting('vault', { vault: { type: 'http', url: gate.url, scope: 'dynamic' } }, ['needs-auth'], gate.refused)
    expect(await screen.completes()).toBe('vault requires authentication. Use /mcp to authenticate.')
    await screen.until(f => f.includes('Error:'), 'the error view')
    expect(flat(screen.text())).toBe('[above] ✘ Failed to reconnect to vault Error: vault requires authentication')
    expect(gate.refused()).toBeGreaterThan(screen.before)
  }, SLOW)

  test('a server that fails: shows the spinner while it tries, then the failure', async () => {
    process.env.MCP_TIMEOUT = '1500'
    const stdio = writeStdioServer(world.root())
    const mute = { ...stdio.config({ BED_SILENT: '1' }), scope: 'dynamic' } as ScopedMcpServerConfig
    const screen = await reconnecting('mute', { mute }, ['failed'], () => stdio.pids().length)
    const spinning = await screen.until(f => f.includes('Reconnecting to'), 'the spinner')
    expect(flat(spinning)).toContain('Reconnecting to mute')
    expect(flat(spinning)).toContain('Establishing connection to MCP server')
    expect(screen.calls.completed).toEqual([])
    expect(await screen.completes()).toBe('Failed to reconnect to mute')
    await screen.until(f => f.includes('Error:'), 'the error view')
    expect(flat(screen.text())).toBe('[above] ✘ Failed to reconnect to mute Error: Failed to reconnect to mute')
    expect(stdio.pids().length).toBe(screen.before + 1)
    pids.push(...stdio.pids())
  }, SLOW)

  test('a command that cannot start fails the same way', async () => {
    const screen = await reconnecting(
      'broken',
      { broken: { type: 'stdio', command: '/nonexistent/mcp-server-binary', args: [], scope: 'dynamic' } as ScopedMcpServerConfig },
      ['failed'],
    )
    expect(await screen.completes()).toBe('Failed to reconnect to broken')
    expect(flat(await screen.until(f => f.includes('Error:'), 'the error view'))).toBe(
      '[above] ✘ Failed to reconnect to broken Error: Failed to reconnect to broken',
    )
  }, SLOW)

  test('it dials once per mount', async () => {
    const ws = startSocketServer()
    const screen = await reconnecting('live', { live: socketConfig(ws, 'dynamic') }, ['connected'])
    await screen.completes()
    await Bun.sleep(300)
    expect(screen.calls.completed).toEqual(['Successfully reconnected to live'])
  }, SLOW)
})
