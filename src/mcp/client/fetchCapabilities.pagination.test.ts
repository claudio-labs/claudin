import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as log from 'src/shared/log.js'
import { connectToServer, getServerCacheKey } from 'src/mcp/client/connection.js'
import { setEraCacheDirForTests } from 'src/mcp/client/eraCache.js'
import {
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
} from 'src/mcp/client/fetchCapabilities.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { _setSecureStorageForTesting } from 'src/platform/secureStorage/index.js'
import { type ModernFixture, serveModern } from 'src/mcp/__testutils__/eraServers.js'
import { connectRawMcpServer, type RawMcpServer, type RawParams } from 'src/mcp/__testutils__/rawMcpServer.js'

const servers: RawMcpServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

// A server that pages every list: page one carries a cursor, page two ends it.
async function pagingServer(name: string): Promise<RawMcpServer> {
  const pages: Record<string, [Record<string, unknown>, Record<string, unknown>]> = {
    'tools/list': [
      { tools: [{ name: 'first', inputSchema: { type: 'object' } }], nextCursor: 'p2' },
      { tools: [{ name: 'second', inputSchema: { type: 'object' } }] },
    ],
    'resources/list': [
      { resources: [{ uri: 'file:///one', name: 'one' }], nextCursor: 'p2' },
      { resources: [{ uri: 'file:///two', name: 'two' }] },
    ],
    'prompts/list': [
      { prompts: [{ name: 'alpha' }], nextCursor: 'p2' },
      { prompts: [{ name: 'beta' }] },
    ],
  }
  const answers = Object.fromEntries(
    Object.entries(pages).map(([method, [first, second]]) => [
      method,
      (params: RawParams) => (params?.cursor === 'p2' ? second : first),
    ]),
  )
  const server = await connectRawMcpServer(name, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    answers,
  })
  servers.push(server)
  return server
}

describe('MCP list calls follow nextCursor', () => {
  test('tools/list returns the tools of every page', async () => {
    const server = await pagingServer('pager-tools')
    const tools = await fetchToolsForClient(server.connection)
    expect(tools.map(t => t.mcpInfo?.toolName)).toEqual(['first', 'second'])
    expect(server.requests.map(r => r.params?.cursor)).toEqual([undefined, 'p2'])
  })

  test('resources/list returns the resources of every page', async () => {
    const server = await pagingServer('pager-resources')
    const resources = await fetchResourcesForClient(server.connection)
    expect(resources.map(r => r.uri)).toEqual(['file:///one', 'file:///two'])
  })

  test('prompts/list returns the prompts of every page', async () => {
    const server = await pagingServer('pager-prompts')
    const commands = await fetchCommandsForClient(server.connection)
    expect(commands.map(c => c.name)).toEqual(['mcp__pager-prompts__alpha', 'mcp__pager-prompts__beta'])
  })

  test('a malformed entry on a later page is dropped from that page only', async () => {
    const server = await connectRawMcpServer('pager-malformed', {
      capabilities: { tools: {} },
      answers: {
        'tools/list': params =>
          params?.cursor === 'p2'
            ? { tools: [{ name: 'bad', inputSchema: { type: 'string' } }, { name: 'third', inputSchema: { type: 'object' } }] }
            : { tools: [{ name: 'first', inputSchema: { type: 'object' } }], nextCursor: 'p2' },
      },
    })
    servers.push(server)
    const tools = await fetchToolsForClient(server.connection)
    expect(tools.map(t => t.mcpInfo?.toolName)).toEqual(['first', 'third'])
  })
})

// cursor → [tool name, next cursor]
async function cursorServer(name: string, chain: Record<string, [string, string | undefined]>) {
  const server = await connectRawMcpServer(name, {
    capabilities: { tools: {} },
    answers: {
      'tools/list': params => {
        const [tool, nextCursor] = chain[(params?.cursor as string | undefined) ?? '']!
        return { tools: [{ name: tool, inputSchema: { type: 'object' } }], ...(nextCursor && { nextCursor }) }
      },
    },
  })
  servers.push(server)
  return server
}

describe('a server whose cursors cycle', () => {
  test('control: a three-page list is followed to its end', async () => {
    const server = await cursorServer('pager-three', { '': ['one', 'a'], a: ['two', 'b'], b: ['three', undefined] })
    const tools = await fetchToolsForClient(server.connection)
    expect(tools.map(t => t.mcpInfo?.toolName)).toEqual(['one', 'two', 'three'])
    expect(server.requests.map(r => r.params?.cursor)).toEqual([undefined, 'a', 'b'])
  })

  test('keeps the tools listed before the repeated cursor, and logs it once', async () => {
    // a → b → a: the SDK alone would page until its 64-page cap and throw.
    const server = await cursorServer('pager-cycle', { '': ['one', 'a'], a: ['two', 'b'], b: ['three', 'a'] })
    const logged = spyOn(log, 'logMCPError')
    try {
      const tools = await fetchToolsForClient(server.connection)
      expect(tools.map(t => t.mcpInfo?.toolName)).toEqual(['one', 'two', 'three'])
      expect(server.requests.map(r => r.params?.cursor)).toEqual([undefined, 'a', 'b'])
      const cycles = logged.mock.calls.filter(call => String(call[1]).includes('repeated the cursor'))
      expect(cycles).toEqual([
        ['pager-cycle', 'tools/list repeated the cursor "a"; the list stops at the entries already received'],
      ])
    } finally {
      logged.mockRestore()
    }
  })
})

// Claudin's own pager stopped at 100 pages and kept what it had; the SDK's
// list*() throws past its listMaxPages (64 by default), and the server lost
// every tool. Reached the way a session reaches a server: connectToServer.
describe('a listing longer than the SDK’s default page cap', () => {
  const macroHost = globalThis as Record<string, unknown>
  let savedMacro: unknown
  let savedConfigDir: string | undefined
  let dir = ''
  let fixture: ModernFixture | undefined
  const connections: MCPServerConnection[] = []

  beforeEach(() => {
    savedMacro = macroHost.MACRO
    macroHost.MACRO = { ...(savedMacro as Record<string, unknown> | undefined), VERSION: '0.0.0-test' }
    savedConfigDir = process.env.CLAUDIN_CONFIG_DIR
    dir = mkdtempSync(join(tmpdir(), 'pager-cap-'))
    process.env.CLAUDIN_CONFIG_DIR = dir
    setEraCacheDirForTests(dir)
    _setSecureStorageForTesting({
      name: 'memory',
      read: () => ({}),
      readAsync: async () => ({}),
      update: () => ({ success: true }),
      delete: () => true,
    })
  })

  afterEach(async () => {
    for (const c of connections.splice(0)) {
      if (c.type === 'connected') await c.cleanup().catch(() => {})
      connectToServer.cache.delete(getServerCacheKey(c.name, c.config))
      fetchToolsForClient.cache.delete(c.name)
    }
    await fixture?.stop()
    fixture = undefined
    _setSecureStorageForTesting(null)
    setEraCacheDirForTests(undefined)
    if (savedConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
    else process.env.CLAUDIN_CONFIG_DIR = savedConfigDir
    rmSync(dir, { recursive: true, force: true })
    if (savedMacro === undefined) delete macroHost.MACRO
    else macroHost.MACRO = savedMacro
  })

  // Page n lists tool tn and points at page n + 1, up to `pages`.
  async function connectPaging(name: string, pages: number) {
    fixture = serveModern(server => {
      server.server.registerCapabilities({ tools: {} })
      server.server.setRequestHandler('tools/list', async request => {
        const page = Number(request.params?.cursor ?? 1)
        return {
          tools: [{ name: `t${page}`, inputSchema: { type: 'object' } }],
          ...(page < pages && { nextCursor: String(page + 1) }),
        } as never
      })
    })
    const config = { type: 'http', url: fixture.url, scope: 'user' } as ScopedMcpServerConfig
    const connection = await connectToServer(name, config)
    connections.push(connection)
    if (connection.type !== 'connected') throw new Error(`not connected: ${connection.type}`)
    return { connection, fixture }
  }

  test('a 90-page list is followed to its end', async () => {
    const { connection, fixture } = await connectPaging(`pager-90-${process.pid}`, 90)
    const tools = await fetchToolsForClient(connection)
    expect(tools).toHaveLength(90)
    expect(tools.at(-1)?.mcpInfo?.toolName).toBe('t90')
    expect(fixture.methods().filter(m => m === 'POST tools/list')).toHaveLength(90)
  })

  test('a 150-page list stops at page 100 with the tools of those pages, and says so in the debug log', async () => {
    const name = `pager-150-${process.pid}`
    const logged = spyOn(log, 'logMCPDebug')
    try {
      const { connection, fixture } = await connectPaging(name, 150)
      const tools = await fetchToolsForClient(connection)
      expect(tools.map(t => t.mcpInfo?.toolName)).toEqual(Array.from({ length: 100 }, (_, i) => `t${i + 1}`))
      expect(fixture.methods().filter(m => m === 'POST tools/list')).toHaveLength(100)
      const cuts = logged.mock.calls.filter(call => call[0] === name && String(call[1]).includes('pages'))
      expect(cuts).toEqual([[name, 'tools/list still had a next page after 100 pages; the list stops at the entries already received']])
    } finally {
      logged.mockRestore()
    }
  }, 20_000)
})
