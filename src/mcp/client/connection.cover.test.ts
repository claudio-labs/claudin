import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SdkErrorCode, SdkHttpError, UnauthorizedError } from '@modelcontextprotocol/client'
import type { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { CallToolResultSchema } from '@modelcontextprotocol/core'
// The fixture server stays on the 1.x SDK: a realistic legacy server.
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  areMcpConfigsEqual,
  clearServerCache,
  isLocalMcpServer,
  connectToServer,
  ensureConnectedClient,
  getServerCacheKey,
  MAX_MCP_DESCRIPTION_LENGTH,
} from 'src/mcp/client/connection.js'
import { fetchToolsForClient } from 'src/mcp/client/fetchCapabilities.js'
import { clearMcpAuthCache } from 'src/mcp/client/authCache.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
  ScopedMcpServerConfig,
} from 'src/mcp/types.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import * as log from 'src/shared/log.js'
import {
  createInMemoryRemote,
  failingTransport,
  fakeInProcessServer,
  isAlive,
  silentTransport,
  stubCreateTransport,
  writeStdioServer,
  type StdioFixture,
} from 'src/mcp/__testutils__/connectionHarness.js'

/*
 * Characterization of connectToServer and the lifecycle it hands back:
 * what each server type and failure resolves to, what the client announces
 * in initialize, the roots/list and early elicitation answers, how transport
 * errors close the connection, and what cleanup does to a stdio child.
 * Pins today's behaviour ahead of the SDK v2 migration.
 */

const macroHost = globalThis as Record<string, unknown>
let savedMacro: unknown
const connections: MCPServerConnection[] = []
const spies: { mockRestore: () => void }[] = []
let seq = 0

beforeEach(() => {
  savedMacro = macroHost.MACRO
  macroHost.MACRO = { ...(savedMacro as Record<string, unknown> | undefined), VERSION: '0.0.0-test' }
})

afterEach(async () => {
  for (const connection of connections.splice(0)) {
    if (connection.type === 'connected') await connection.cleanup().catch(() => {})
    connectToServer.cache.delete(getServerCacheKey(connection.name, connection.config))
  }
  for (const spy of spies.splice(0)) spy.mockRestore()
  if (savedMacro === undefined) delete macroHost.MACRO
  else macroHost.MACRO = savedMacro
})

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${++seq}`
}

async function connect(name: string, config: ScopedMcpServerConfig): Promise<MCPServerConnection> {
  const connection = await connectToServer(name, config)
  connections.push(connection)
  return connection
}

function track<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy)
  return spy
}

function asConnected(connection: MCPServerConnection): ConnectedMCPServer {
  if (connection.type !== 'connected') {
    throw new Error(`expected connected, got ${connection.type}: ${'error' in connection ? connection.error : ''}`)
  }
  return connection
}

const httpConfig = (url = 'http://127.0.0.1:1/mcp'): ScopedMcpServerConfig => ({ type: 'http', url, scope: 'user' })

/** What the Streamable HTTP transport throws for a non-OK response. */
const httpError = (status: number, message: string) =>
  new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, message, { status })

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor timed out')
    await Bun.sleep(10)
  }
}

describe('connectToServer — a connected in-process server', () => {
  test('announces roots and an empty elicitation capability, and the client info', async () => {
    const remote = createInMemoryRemote()
    track(stubCreateTransport(() => ({ transport: remote.clientTransport })))
    asConnected(await connect(uniqueName('caps'), httpConfig()))
    // On the wire elicitation is the bare {}: Spring AI servers reject
    // {form:{}} (the receiving SDK reads {} as form support).
    const initialize = remote.sent.find(m => 'method' in m && m.method === 'initialize') as unknown as {
      params: { capabilities: unknown }
    }
    expect(initialize.params.capabilities).toEqual({ roots: {}, elicitation: {} })
    expect(remote.server.getClientVersion()).toMatchObject({ name: 'claude-code', title: 'Claudin', version: '0.0.0-test' })
  })

  test('returns capabilities, server info and instructions', async () => {
    const remote = createInMemoryRemote({ capabilities: { tools: {}, resources: { subscribe: true } }, instructions: 'be brief' })
    track(stubCreateTransport(() => ({ transport: remote.clientTransport })))
    const config = httpConfig()
    const name = uniqueName('info')
    const connection = asConnected(await connect(name, config))
    expect(connection.name).toBe(name)
    expect(connection.config).toBe(config)
    expect(connection.capabilities).toEqual({ tools: {}, resources: { subscribe: true } })
    expect(connection.serverInfo).toEqual({ name: 'fixture', version: '9.9.9' })
    expect(connection.instructions).toBe('be brief')
  })

  test('truncates instructions longer than the description cap', async () => {
    const long = 'x'.repeat(MAX_MCP_DESCRIPTION_LENGTH + 10)
    const remote = createInMemoryRemote({ instructions: long })
    track(stubCreateTransport(() => ({ transport: remote.clientTransport })))
    const connection = asConnected(await connect(uniqueName('instr'), httpConfig()))
    expect(connection.instructions).toBe('x'.repeat(MAX_MCP_DESCRIPTION_LENGTH) + '… [truncated]')
  })

  test('instructions exactly at the cap are kept whole', async () => {
    const exact = 'y'.repeat(MAX_MCP_DESCRIPTION_LENGTH)
    const remote = createInMemoryRemote({ instructions: exact })
    track(stubCreateTransport(() => ({ transport: remote.clientTransport })))
    const connection = asConnected(await connect(uniqueName('instr-exact'), httpConfig()))
    expect(connection.instructions).toBe(exact)
  })

  test('answers roots/list with the original cwd as a file URI', async () => {
    const remote = createInMemoryRemote()
    track(stubCreateTransport(() => ({ transport: remote.clientTransport })))
    asConnected(await connect(uniqueName('roots'), httpConfig()))
    expect(await remote.server.listRoots()).toEqual({ roots: [{ uri: `file://${getOriginalCwd()}` }] })
  })

  test('cancels an elicitation that arrives before the real handler is registered', async () => {
    const remote = createInMemoryRemote()
    track(stubCreateTransport(() => ({ transport: remote.clientTransport })))
    asConnected(await connect(uniqueName('elicit'), httpConfig()))
    const result = await remote.server.elicitInput({
      message: 'name?',
      requestedSchema: { type: 'object', properties: { n: { type: 'string' } } },
    })
    expect(result).toEqual({ action: 'cancel' })
  })

  test('an IDE server is sent ide_connected with this pid', async () => {
    for (const type of ['sse-ide', 'ws-ide'] as const) {
      const remote = createInMemoryRemote()
      const seen: unknown[] = []
      remote.server.fallbackNotificationHandler = async n => {
        seen.push(n)
      }
      const spy = stubCreateTransport(() => ({ transport: remote.clientTransport }))
      const config =
        type === 'sse-ide'
          ? ({ type, url: 'http://127.0.0.1:1/sse', ideName: 'vscode', scope: 'dynamic' } as ScopedMcpServerConfig)
          : ({ type, url: 'ws://127.0.0.1:1', ideName: 'vscode', scope: 'dynamic' } as ScopedMcpServerConfig)
      asConnected(await connect(uniqueName(type), config))
      spy.mockRestore()
      await waitFor(() => seen.length > 0)
      expect(seen).toEqual([{ jsonrpc: '2.0', method: 'ide_connected', params: { pid: process.pid } }])
    }
  })

  test('a non-IDE server is not sent ide_connected', async () => {
    const remote = createInMemoryRemote()
    const seen: unknown[] = []
    remote.server.fallbackNotificationHandler = async n => {
      seen.push(n)
    }
    track(stubCreateTransport(() => ({ transport: remote.clientTransport })))
    asConnected(await connect(uniqueName('not-ide'), httpConfig()))
    await Bun.sleep(20)
    expect(seen).toEqual([])
  })

  test('memoizes by name and config', async () => {
    const remote = createInMemoryRemote()
    const spy = track(stubCreateTransport(() => ({ transport: remote.clientTransport })))
    const name = uniqueName('memo')
    const config = httpConfig()
    const first = await connect(name, config)
    const second = await connectToServer(name, config)
    expect(second).toBe(first)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  test('lists through the wire filter: one malformed tool is skipped, logged, and the rest kept', async () => {
    const remote = createInMemoryRemote()
    remote.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: 'good', inputSchema: { type: 'object' } },
        { name: 'bad', inputSchema: { type: 'string' } } as never,
      ],
    }))
    track(stubCreateTransport(() => ({ transport: remote.clientTransport })))
    const name = uniqueName('wire-filter')
    const connection = asConnected(await connect(name, httpConfig()))
    const logged = track(spyOn(log, 'logMCPError'))
    try {
      expect((await fetchToolsForClient(connection)).map(t => t.mcpInfo?.toolName)).toEqual(['good'])
      expect(logged.mock.calls).toContainEqual([name, 'Skipped tool "bad": inputSchema type is not "object"'])
    } finally {
      fetchToolsForClient.cache.delete(name)
    }
  })

  test('an unparsable http URL still connects (the URL is only logged)', async () => {
    const remote = createInMemoryRemote()
    track(stubCreateTransport(() => ({ transport: remote.clientTransport })))
    const connection = await connect(uniqueName('bad-url'), { type: 'http', url: 'not a url', scope: 'user' })
    expect(connection.type).toBe('connected')
  })
})

describe('connectToServer — failures', () => {
  test('an http UnauthorizedError is needs-auth and is written to the auth cache', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mcp-conn-auth-'))
    const savedDir = process.env.CLAUDIN_CONFIG_DIR
    process.env.CLAUDIN_CONFIG_DIR = configDir
    try {
      for (const type of ['http', 'sse'] as const) {
        const transport = failingTransport(new UnauthorizedError('no token'))
        const spy = stubCreateTransport(() => ({ transport }))
        const name = uniqueName(`auth-${type}`)
        const config = { type, url: 'http://127.0.0.1:1/mcp', scope: 'user' } as ScopedMcpServerConfig
        const connection = await connect(name, config)
        spy.mockRestore()
        expect(connection).toEqual({ name, type: 'needs-auth', config })
        // An auth failure leaves the transport to the caller.
        expect(transport.closes()).toBe(0)
        const cachePath = join(configDir, 'mcp-needs-auth-cache.json')
        await waitFor(() => existsSync(cachePath) && readFileSync(cachePath, 'utf8').includes(name))
      }
    } finally {
      clearMcpAuthCache()
      await Bun.sleep(20)
      if (savedDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
      else process.env.CLAUDIN_CONFIG_DIR = savedDir
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('a claude.ai proxy 401 is needs-auth; another status fails', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mcp-conn-proxy-'))
    const savedDir = process.env.CLAUDIN_CONFIG_DIR
    process.env.CLAUDIN_CONFIG_DIR = configDir
    try {
      const config = { type: 'claudeai-proxy', url: 'https://x', id: 'srv', scope: 'claudeai' } as ScopedMcpServerConfig
      const err401 = httpError(401, 'Unauthorized')
      let spy = stubCreateTransport(() => ({ transport: failingTransport(err401) }))
      const authName = uniqueName('proxy-401')
      expect(await connect(authName, config)).toEqual({ name: authName, type: 'needs-auth', config })
      spy.mockRestore()
      await waitFor(() => existsSync(join(configDir, 'mcp-needs-auth-cache.json')))

      const transport = failingTransport(httpError(403, 'Forbidden'))
      spy = stubCreateTransport(() => ({ transport }))
      const failName = uniqueName('proxy-403')
      expect(await connect(failName, config)).toEqual({ name: failName, type: 'failed', config, error: 'Forbidden' })
      spy.mockRestore()
      expect(transport.closes()).toBe(0)
    } finally {
      clearMcpAuthCache()
      await Bun.sleep(20)
      if (savedDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
      else process.env.CLAUDIN_CONFIG_DIR = savedDir
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('a non-auth http or sse failure is failed with the message, transport left open', async () => {
    for (const type of ['http', 'sse'] as const) {
      const transport = failingTransport(new Error('bad request'))
      const spy = stubCreateTransport(() => ({ transport }))
      const name = uniqueName(`fail-${type}`)
      const config = { type, url: 'http://127.0.0.1:1/mcp', scope: 'user' } as ScopedMcpServerConfig
      expect(await connect(name, config)).toEqual({ name, type: 'failed', config, error: 'bad request' })
      spy.mockRestore()
      expect(transport.closes()).toBe(0)
    }
  })

  test('a non-remote failure closes the transport, and the in-process server too', async () => {
    const transport = failingTransport(new Error('spawn ENOENT'))
    const inProcessServer = fakeInProcessServer()
    track(stubCreateTransport(() => ({ transport, inProcessServer })))
    const name = uniqueName('fail-local')
    const config: ScopedMcpServerConfig = { type: 'stdio', command: 'nope', args: [], scope: 'user' }
    expect(await connect(name, config)).toEqual({ name, type: 'failed', config, error: 'spawn ENOENT' })
    expect(transport.closes()).toBe(1)
    // Closed once by the failure cleanup and once more by the outer catch.
    expect(inProcessServer.closes()).toBe(2)
  })

  test('a non-remote failure without an in-process server closes only the transport', async () => {
    const transport = failingTransport(new Error('boom'))
    track(stubCreateTransport(() => ({ transport })))
    const name = uniqueName('fail-ws')
    const config = { type: 'ws', url: 'ws://127.0.0.1:1', scope: 'user' } as ScopedMcpServerConfig
    // ws is retried only on a transient error; this one is not.
    expect(await connect(name, config)).toMatchObject({ type: 'failed', error: 'boom' })
    expect(transport.closes()).toBe(1)
  })

  test('a createTransport error is failed with its message', async () => {
    const name = uniqueName('sdk')
    const config = { type: 'sdk', name, scope: 'dynamic' } as ScopedMcpServerConfig
    expect(await connect(name, config)).toEqual({
      name,
      type: 'failed',
      config,
      error: 'SDK servers should be handled in print.ts',
    })
  })

  test('a server that never answers times out at startupTimeout and is closed', async () => {
    const transport = silentTransport()
    const inProcessServer = fakeInProcessServer()
    track(stubCreateTransport(() => ({ transport, inProcessServer })))
    const name = uniqueName('timeout')
    const config: ScopedMcpServerConfig = { type: 'stdio', command: 'x', args: [], startupTimeout: 30, scope: 'user' }
    const connection = await connect(name, config)
    expect(connection).toEqual({
      name,
      type: 'failed',
      config,
      error: `MCP server "${name}" connection timed out after 30ms`,
    })
    expect(transport.closes()).toBeGreaterThanOrEqual(1)
    expect(inProcessServer.closes()).toBeGreaterThanOrEqual(1)
  })
})

describe('connectToServer — transport errors after connect', () => {
  async function connectWithHangingTool(type: 'http' | 'sse' | 'claudeai-proxy' | 'stdio') {
    const remote = createInMemoryRemote()
    remote.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
    remote.server.setRequestHandler(CallToolRequestSchema, () => new Promise(() => {}))
    track(stubCreateTransport(() => ({ transport: remote.clientTransport })))
    const name = uniqueName(`err-${type}`)
    const config =
      type === 'stdio'
        ? ({ type, command: 'x', args: [], scope: 'user' } as ScopedMcpServerConfig)
        : type === 'claudeai-proxy'
          ? ({ type, url: 'https://x', id: 'srv', scope: 'claudeai' } as ScopedMcpServerConfig)
          : ({ type, url: 'http://127.0.0.1:1/mcp', scope: 'user' } as ScopedMcpServerConfig)
    const connection = asConnected(await connect(name, config))
    const pending = connection.client
      .request({ method: 'tools/call', params: { name: 't', arguments: {} } }, CallToolResultSchema)
      .then(
        () => 'resolved',
        (e: Error) => e.message,
      )
    const fireError = (error: Error) => remote.clientTransport.onerror?.(error)
    return { remote, name, config, connection, pending, fireError }
  }

  const settled = async (p: Promise<string>) => Promise.race([p, Bun.sleep(30).then(() => 'pending')])

  test('three consecutive terminal errors close the transport and reject pending calls', async () => {
    const { remote, pending, fireError, name, config } = await connectWithHangingTool('http')
    fireError(new Error('read ECONNRESET'))
    fireError(new Error('connect ETIMEDOUT'))
    expect(await settled(pending)).toBe('pending')
    expect(remote.closes()).toBe(0)
    fireError(new Error('write EPIPE'))
    expect(await pending).toBe('Connection closed')
    expect(remote.closes()).toBe(1)
    // onclose dropped the memoized connection so the next call reconnects.
    expect(connectToServer.cache.has(getServerCacheKey(name, config))).toBe(false)
  })

  test('a non-terminal error resets the terminal error count', async () => {
    const { remote, pending, fireError } = await connectWithHangingTool('sse')
    fireError(new Error('ECONNREFUSED'))
    fireError(new Error('EHOSTUNREACH'))
    fireError(new Error('something else'))
    fireError(new Error('Body Timeout Error'))
    fireError(new Error('terminated'))
    expect(await settled(pending)).toBe('pending')
    expect(remote.closes()).toBe(0)
    fireError(new Error('SSE stream disconnected'))
    expect(await pending).toBe('Connection closed')
  })

  test('an exhausted SSE reconnect closes at once', async () => {
    const { remote, pending, fireError } = await connectWithHangingTool('claudeai-proxy')
    fireError(new Error('Maximum reconnection attempts (2) exceeded.'))
    expect(await pending).toBe('Connection closed')
    expect(remote.closes()).toBe(1)
  })

  test('an http session-expired 404 closes at once', async () => {
    const { remote, pending, fireError } = await connectWithHangingTool('http')
    fireError(httpError(404, 'Error POSTing: {"error":{"code":-32001,"message":"Session not found"}}'))
    expect(await pending).toBe('Connection closed')
    expect(remote.closes()).toBe(1)
  })

  test('a plain 404 on http is not a session expiry', async () => {
    const { remote, pending, fireError } = await connectWithHangingTool('http')
    fireError(httpError(404, 'Not Found'))
    expect(await settled(pending)).toBe('pending')
    expect(remote.closes()).toBe(0)
  })

  test('the same 404 on sse is not treated as an expiry', async () => {
    const { remote, pending, fireError } = await connectWithHangingTool('sse')
    fireError(httpError(404, '{"code":-32001}'))
    expect(await settled(pending)).toBe('pending')
    expect(remote.closes()).toBe(0)
  })

  test('stdio errors never close the transport', async () => {
    const { remote, pending, fireError } = await connectWithHangingTool('stdio')
    for (const message of ['ECONNRESET', 'ECONNRESET', 'ECONNRESET', 'ESRCH', 'spawn x', 'Maximum reconnection attempts', '']) {
      fireError(new Error(message))
    }
    expect(await settled(pending)).toBe('pending')
    expect(remote.closes()).toBe(0)
  })

  test('a remote close clears the connection and fetch caches', async () => {
    const remote = createInMemoryRemote()
    remote.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 't', inputSchema: { type: 'object' } }],
    }))
    track(stubCreateTransport(() => ({ transport: remote.clientTransport })))
    const name = uniqueName('onclose')
    const config = httpConfig()
    const connection = asConnected(await connect(name, config))
    await fetchToolsForClient(connection)
    expect(fetchToolsForClient.cache.has(name)).toBe(true)
    expect(connectToServer.cache.has(getServerCacheKey(name, config))).toBe(true)
    await remote.server.close()
    await waitFor(() => !connectToServer.cache.has(getServerCacheKey(name, config)))
    expect(fetchToolsForClient.cache.has(name)).toBe(false)
  })
})

describe('cleanup', () => {
  test('an in-process server is closed, then the client', async () => {
    const remote = createInMemoryRemote()
    const inProcessServer = fakeInProcessServer()
    track(stubCreateTransport(() => ({ transport: remote.clientTransport, inProcessServer })))
    const connection = asConnected(await connect(uniqueName('inproc'), { type: 'stdio', command: 'x', args: [], scope: 'user' }))
    await connection.cleanup()
    expect(inProcessServer.closes()).toBe(1)
    expect(remote.closes()).toBe(1)
  })

  test('an in-process server that fails to close still closes the client', async () => {
    const remote = createInMemoryRemote()
    const inProcessServer = fakeInProcessServer({ closeError: new Error('nope') })
    track(stubCreateTransport(() => ({ transport: remote.clientTransport, inProcessServer })))
    const connection = asConnected(await connect(uniqueName('inproc-err'), { type: 'stdio', command: 'x', args: [], scope: 'user' }))
    const closeSpy = track(spyOn(connection.client, 'close').mockImplementation(async () => {
      throw new Error('close failed')
    }))
    await expect(connection.cleanup()).resolves.toBeUndefined()
    expect(inProcessServer.closes()).toBe(1)
    expect(closeSpy).toHaveBeenCalledTimes(1)
    closeSpy.mockRestore()
  })

  test('a remote server is closed through the client; a close error is swallowed', async () => {
    const remote = createInMemoryRemote()
    track(stubCreateTransport(() => ({ transport: remote.clientTransport })))
    const connection = asConnected(await connect(uniqueName('remote-clean'), httpConfig()))
    await connection.cleanup()
    expect(remote.closes()).toBe(1)

    const remote2 = createInMemoryRemote()
    spies.pop()?.mockRestore()
    track(stubCreateTransport(() => ({ transport: remote2.clientTransport })))
    const connection2 = asConnected(await connect(uniqueName('remote-clean-err'), httpConfig()))
    const closeSpy = track(spyOn(connection2.client, 'close').mockImplementation(async () => {
      throw new Error('close failed')
    }))
    await expect(connection2.cleanup()).resolves.toBeUndefined()
    expect(closeSpy).toHaveBeenCalledTimes(1)
    closeSpy.mockRestore()
  })
})

describe('clearServerCache and ensureConnectedClient', () => {
  test('clearServerCache cleans up a connected server and drops it from the caches', async () => {
    const remote = createInMemoryRemote()
    const spy = track(stubCreateTransport(() => ({ transport: remote.clientTransport })))
    const name = uniqueName('clear')
    const config = httpConfig()
    await connect(name, config)
    await clearServerCache(name, config)
    expect(remote.closes()).toBe(1)
    expect(connectToServer.cache.has(getServerCacheKey(name, config))).toBe(false)

    const remote2 = createInMemoryRemote()
    spy.mockImplementation(async () => ({ transport: remote2.clientTransport }))
    const again = await connect(name, config)
    expect(again.type).toBe('connected')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  test('clearServerCache on a failed server only drops it', async () => {
    const transport = failingTransport(new Error('boom'))
    track(stubCreateTransport(() => ({ transport })))
    const name = uniqueName('clear-failed')
    const config = httpConfig()
    expect((await connect(name, config)).type).toBe('failed')
    await clearServerCache(name, config)
    expect(connectToServer.cache.has(getServerCacheKey(name, config))).toBe(false)
  })

  test('ensureConnectedClient returns an sdk client as is', async () => {
    const client = { name: 'sdk1', type: 'connected', config: { type: 'sdk', name: 'sdk1', scope: 'dynamic' } } as unknown as ConnectedMCPServer
    expect(await ensureConnectedClient(client)).toBe(client)
  })

  test('ensureConnectedClient returns the memoized connection', async () => {
    const remote = createInMemoryRemote()
    track(stubCreateTransport(() => ({ transport: remote.clientTransport })))
    const name = uniqueName('ensure')
    const config = httpConfig()
    const connection = asConnected(await connect(name, config))
    const stale = { ...connection }
    expect(await ensureConnectedClient(stale)).toBe(connection)
  })

  test('ensureConnectedClient throws when the server does not connect', async () => {
    track(stubCreateTransport(() => ({ transport: failingTransport(new Error('down')) })))
    const name = uniqueName('ensure-fail')
    const config = httpConfig()
    const stale = { name, type: 'connected', config } as unknown as ConnectedMCPServer
    await expect(ensureConnectedClient(stale)).rejects.toThrow(`MCP server "${name}" is not connected`)
    connectToServer.cache.delete(getServerCacheKey(name, config))
  })
})

describe('config predicates', () => {
  test('isLocalMcpServer is stdio, untyped and sdk only', () => {
    const local = [{ type: 'stdio' }, {}, { type: 'sdk' }]
    const remote = [{ type: 'http' }, { type: 'sse' }, { type: 'ws' }, { type: 'claudeai-proxy' }]
    for (const c of local) expect(isLocalMcpServer(c as ScopedMcpServerConfig)).toBe(true)
    for (const c of remote) expect(isLocalMcpServer(c as ScopedMcpServerConfig)).toBe(false)
  })

  test('areMcpConfigsEqual ignores scope but not type or fields', () => {
    const a = { type: 'http', url: 'http://a', scope: 'user' } as ScopedMcpServerConfig
    expect(areMcpConfigsEqual(a, { ...a, scope: 'project' } as ScopedMcpServerConfig)).toBe(true)
    expect(areMcpConfigsEqual(a, { ...a, url: 'http://b' } as ScopedMcpServerConfig)).toBe(false)
    expect(areMcpConfigsEqual(a, { ...a, type: 'sse' } as ScopedMcpServerConfig)).toBe(false)
  })
})

describe('stdio servers (a real child process)', () => {
  let fixture: StdioFixture
  const pids: number[] = []

  beforeAll(() => {
    fixture = writeStdioServer()
  })

  afterEach(() => {
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  })

  afterAll(() => {
    fixture.dispose()
  })

  function stdioConfig(env: Record<string, string> = {}, type: 'stdio' | null = 'stdio'): ScopedMcpServerConfig {
    return { ...(type ? { type } : {}), command: fixture.command, args: fixture.args, env, scope: 'user' } as ScopedMcpServerConfig
  }

  async function connectStdio(prefix: string, config: ScopedMcpServerConfig) {
    const connection = asConnected(await connect(uniqueName(prefix), config))
    const pid = (connection.client.transport as StdioClientTransport).pid!
    expect(pid).toBeGreaterThan(0)
    pids.push(pid)
    return { connection, pid }
  }

  test('stderr written during startup is logged once connected', async () => {
    const logSpy = track(spyOn(log, 'logMCPError'))
    const { connection } = await connectStdio('stderr', stdioConfig({ FIXTURE_STDERR: 'warming up' }))
    expect(logSpy).toHaveBeenCalledWith(connection.name, 'Server stderr: warming up')
  })

  test('a child that exits during initialize fails, with its stderr logged', async () => {
    const logSpy = track(spyOn(log, 'logMCPError'))
    const name = uniqueName('early-exit')
    const connection = await connect(name, stdioConfig({ FIXTURE_STDERR: 'fatal: no config', FIXTURE_EXIT_EARLY: '1' }))
    expect(connection).toMatchObject({ type: 'failed', error: 'Connection closed' })
    expect(logSpy).toHaveBeenCalledWith(name, 'Server stderr: fatal: no config')
  })

  test('cleanup ends a child with SIGINT and detaches stderr', async () => {
    const killSpy = track(spyOn(process, 'kill'))
    const { connection, pid } = await connectStdio('sigint', stdioConfig())
    const stderr = (connection.client.transport as StdioClientTransport).stderr!
    expect(stderr.listenerCount('data')).toBe(1)
    await connection.cleanup()
    expect(isAlive(pid)).toBe(false)
    expect(stderr.listenerCount('data')).toBe(0)
    const signals = killSpy.mock.calls.filter(([p]) => p === pid).map(([, s]) => s)
    expect(signals[0]).toBe('SIGINT')
    expect(signals).not.toContain('SIGTERM')
    expect(signals).not.toContain('SIGKILL')
  })

  test('a child that ignores SIGINT gets SIGTERM', async () => {
    const killSpy = track(spyOn(process, 'kill'))
    const { connection, pid } = await connectStdio('sigterm', stdioConfig({ FIXTURE_IGNORE: 'INT' }))
    await connection.cleanup()
    expect(isAlive(pid)).toBe(false)
    const signals = killSpy.mock.calls.filter(([p, s]) => p === pid && s !== 0).map(([, s]) => s)
    expect(signals).toEqual(['SIGINT', 'SIGTERM'])
  })

  test('a child that ignores SIGINT and SIGTERM gets SIGKILL', async () => {
    const killSpy = track(spyOn(process, 'kill'))
    const { connection, pid } = await connectStdio('sigkill', stdioConfig({ FIXTURE_IGNORE: 'INT,TERM' }))
    await connection.cleanup()
    expect(isAlive(pid)).toBe(false)
    const signals = killSpy.mock.calls.filter(([p, s]) => p === pid && s !== 0).map(([, s]) => s)
    expect(signals).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL'])
  })

  test('when SIGINT cannot be sent, cleanup returns without closing the client', async () => {
    const { connection, pid } = await connectStdio('sigint-err', stdioConfig())
    const closeSpy = track(spyOn(connection.client, 'close'))
    const realKill = process.kill.bind(process)
    const killSpy = track(spyOn(process, 'kill').mockImplementation(((p: number, s?: string | number) => {
      if (p === pid && s === 'SIGINT') throw new Error('EPERM')
      return realKill(p, s)
    }) as typeof process.kill))
    await connection.cleanup()
    killSpy.mockRestore()
    expect(closeSpy).not.toHaveBeenCalled()
    expect(isAlive(pid)).toBe(true)
    closeSpy.mockRestore()
    await connection.client.close()
  })

  test('when SIGTERM cannot be sent, cleanup stops escalating and closes the client', async () => {
    const { connection, pid } = await connectStdio('sigterm-err', stdioConfig())
    const closeSpy = track(spyOn(connection.client, 'close'))
    const realKill = process.kill.bind(process)
    const sent: unknown[] = []
    const killSpy = track(spyOn(process, 'kill').mockImplementation(((p: number, s?: string | number) => {
      if (p !== pid) return realKill(p, s)
      if (s !== 0) sent.push(s)
      if (s === 'SIGTERM') throw new Error('EPERM')
      return true // pretend SIGINT was ignored and the child is alive
    }) as typeof process.kill))
    await connection.cleanup()
    killSpy.mockRestore()
    expect(sent).toEqual(['SIGINT', 'SIGTERM'])
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  test('when SIGKILL cannot be sent, cleanup still closes the client', async () => {
    const { connection, pid } = await connectStdio('sigkill-err', stdioConfig())
    const closeSpy = track(spyOn(connection.client, 'close'))
    const realKill = process.kill.bind(process)
    const sent: unknown[] = []
    const killSpy = track(spyOn(process, 'kill').mockImplementation(((p: number, s?: string | number) => {
      if (p !== pid) return realKill(p, s)
      if (s !== 0) sent.push(s)
      if (s === 'SIGKILL') throw new Error('EPERM')
      return true
    }) as typeof process.kill))
    await connection.cleanup()
    killSpy.mockRestore()
    expect(sent).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL'])
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  test('a server with no type is not signalled, only closed', async () => {
    const killSpy = track(spyOn(process, 'kill'))
    const { connection, pid } = await connectStdio('untyped', stdioConfig({}, null))
    const stderr = (connection.client.transport as StdioClientTransport).stderr!
    await connection.cleanup()
    expect(killSpy.mock.calls.filter(([p]) => p === pid)).toEqual([])
    expect(stderr.listenerCount('data')).toBe(0)
    await waitFor(() => !isAlive(pid))
  })
})
