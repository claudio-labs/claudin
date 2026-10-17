import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Server } from 'bun'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server as NetServer, type Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'

import { getServerKey } from 'src/mcp/auth/serverKey.js'
import { createTransport } from 'src/mcp/client/transport.js'
import { WebSocketTransport } from 'src/mcp/mcpWebSocketTransport.js'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'
import {
  _setSecureStorageForTesting,
  type SecureStorageData,
} from 'src/platform/secureStorage/index.js'
import { clearOAuthTokenCache } from 'src/providers/auth/auth.js'
import { getMCPUserAgent } from 'src/shared/http.js'

/*
 * Characterization of createTransport: which transport each server type
 * builds, and what it puts on the wire. The WebSocket variants connect to a
 * real Bun.serve and assert the upgrade request (subprotocol + headers); the
 * HTTP variants connect to a real local server; stdio spawns a real child.
 * Only the Bun branch of the WebSocket construction runs here — the Node
 * branch (createNodeWsClient) needs `node` and is not covered.
 */

// Every env var createTransport (or what it calls) reads, cleared per test so
// the developer's shell cannot leak a proxy, a token or a shell prefix in.
const ENV_KEYS = [
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDIN_SIMPLE',
  'CLAUDIN_SHELL_PREFIX',
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY',
  'no_proxy',
  'NO_PROXY',
] as const

let savedEnv: Record<string, string | undefined> = {}
// MACRO.* is inlined by the build; under bun test the User-Agent needs it set.
const macroHost = globalThis as Record<string, unknown>
let savedMacro: unknown
const servers: Server<unknown>[] = []
const transports: Transport[] = []
const closers: Array<() => Promise<void>> = []
const tempDirs: string[] = []

beforeEach(() => {
  savedMacro = macroHost.MACRO
  macroHost.MACRO = {
    ...(savedMacro as Record<string, unknown> | undefined),
    VERSION: '0.0.0-test',
  }
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(async () => {
  for (const t of transports.splice(0)) {
    await t.close().catch(() => undefined)
  }
  for (const close of closers.splice(0)) {
    await close()
  }
  for (const srv of servers.splice(0)) {
    srv.stop(true)
  }
  _setSecureStorageForTesting(null)
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  clearOAuthTokenCache()
  if (savedMacro === undefined) delete macroHost.MACRO
  else macroHost.MACRO = savedMacro
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

async function build(
  name: string,
  config: ScopedMcpServerConfig,
): Promise<Transport> {
  const { transport, inProcessServer } = await createTransport(name, config)
  expect(inProcessServer).toBeUndefined()
  transports.push(transport)
  return transport
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-transport-'))
  tempDirs.push(dir)
  return dir
}

function memoryStorage(data: SecureStorageData): void {
  _setSecureStorageForTesting({
    name: 'memory',
    read: () => data,
    readAsync: async () => data,
    update: () => ({ success: true }),
    delete: () => true,
  })
}

function storedTokenFor(
  name: string,
  config: Extract<ScopedMcpServerConfig, { type: 'sse' | 'http' }>,
  accessToken: string,
): SecureStorageData {
  return {
    mcpOAuth: {
      [getServerKey(name, config)]: {
        serverName: name,
        serverUrl: config.url,
        accessToken,
        expiresAt: Date.now() + 3_600_000,
      },
    },
  }
}

// ── WebSocket server ────────────────────────────────────────────────────────

type Upgrade = { protocol: string | null; headers: Headers }

// Bun empties a Request's headers once the handler has returned, so every
// server below snapshots what it saw while the request is live.
type SeenRequest = { method: string; headers: Headers }

function snapshot(req: Request): SeenRequest {
  return { method: req.method, headers: new Headers(req.headers) }
}

function startWsServer(): {
  url: string
  upgrades: Upgrade[]
} {
  const upgrades: Upgrade[] = []
  const srv = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, server) {
      const protocol = req.headers.get('sec-websocket-protocol')
      upgrades.push({ protocol, headers: new Headers(req.headers) })
      // Accept only the MCP subprotocol, echoing it back as a real server does.
      if (protocol !== 'mcp') {
        return new Response('subprotocol mcp required', { status: 400 })
      }
      if (
        server.upgrade(req, { headers: { 'Sec-WebSocket-Protocol': 'mcp' } })
      ) {
        return undefined
      }
      return new Response('upgrade failed', { status: 500 })
    },
    websocket: {
      // Echo every frame, so a send proves the socket is the one we upgraded.
      message(ws, message) {
        ws.send(String(message))
      },
    },
  })
  servers.push(srv)
  return { url: `ws://127.0.0.1:${srv.port}`, upgrades }
}

async function roundTrip(transport: Transport): Promise<JSONRPCMessage> {
  const reply = new Promise<JSONRPCMessage>(resolve => {
    transport.onmessage = resolve
  })
  await transport.start()
  await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  return reply
}

describe('createTransport — ws-ide', () => {
  test('connects with the mcp subprotocol, the MCP User-Agent and the IDE auth token', async () => {
    const server = startWsServer()

    const transport = await build('ide', {
      type: 'ws-ide',
      url: server.url,
      ideName: 'VS Code',
      authToken: 'ide-secret',
      scope: 'dynamic',
    })

    expect(transport).toBeInstanceOf(WebSocketTransport)
    expect(await roundTrip(transport)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    expect(server.upgrades).toHaveLength(1)
    const [upgrade] = server.upgrades
    expect(upgrade!.protocol).toBe('mcp')
    expect(upgrade!.headers.get('user-agent')).toBe(getMCPUserAgent())
    expect(upgrade!.headers.get('x-claude-code-ide-authorization')).toBe(
      'ide-secret',
    )
    expect(upgrade!.headers.get('authorization')).toBeNull()
  })

  test('without an auth token the IDE header is omitted, and the session ingress token is not sent', async () => {
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'ingress-jwt'
    const server = startWsServer()

    const transport = await build('ide', {
      type: 'ws-ide',
      url: server.url,
      ideName: 'VS Code',
      scope: 'dynamic',
    })
    await roundTrip(transport)

    const [upgrade] = server.upgrades
    expect(upgrade!.protocol).toBe('mcp')
    expect(upgrade!.headers.get('x-claude-code-ide-authorization')).toBeNull()
    expect(upgrade!.headers.get('authorization')).toBeNull()
  })
})

describe('createTransport — ws', () => {
  test('connects with the mcp subprotocol, the session ingress token and the static headers', async () => {
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'ingress-jwt'
    const server = startWsServer()

    const transport = await build('remote', {
      type: 'ws',
      url: server.url,
      headers: { 'X-Static': 'static-value' },
      scope: 'user',
    })

    expect(transport).toBeInstanceOf(WebSocketTransport)
    expect(await roundTrip(transport)).toMatchObject({ id: 1 })
    const [upgrade] = server.upgrades
    expect(upgrade!.protocol).toBe('mcp')
    expect(upgrade!.headers.get('user-agent')).toBe(getMCPUserAgent())
    expect(upgrade!.headers.get('authorization')).toBe('Bearer ingress-jwt')
    expect(upgrade!.headers.get('x-static')).toBe('static-value')
  })

  test('without a session ingress token no Authorization is sent', async () => {
    const server = startWsServer()

    const transport = await build('remote', {
      type: 'ws',
      url: server.url,
      scope: 'user',
    })
    await roundTrip(transport)

    expect(server.upgrades[0]!.headers.get('authorization')).toBeNull()
  })

  test('configured headers win over the session ingress token', async () => {
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'ingress-jwt'
    const server = startWsServer()

    const transport = await build('remote', {
      type: 'ws',
      url: server.url,
      headers: { Authorization: 'Bearer from-config' },
      scope: 'user',
    })
    await roundTrip(transport)

    expect(server.upgrades[0]!.headers.get('authorization')).toBe(
      'Bearer from-config',
    )
  })

  test('headers from headersHelper reach the upgrade and override static ones', async () => {
    const dir = tempDir()
    const helper = join(dir, 'headers.sh')
    writeFileSync(
      helper,
      `#!/bin/sh\necho '{"X-Static":"from-helper","X-Dynamic":"'"$CLAUDIN_MCP_SERVER_NAME"'"}'\n`,
    )
    chmodSync(helper, 0o755)
    const server = startWsServer()

    const transport = await build('helped', {
      type: 'ws',
      url: server.url,
      headers: { 'X-Static': 'static-value' },
      headersHelper: helper,
      scope: 'user',
    })
    await roundTrip(transport)

    const headers = server.upgrades[0]!.headers
    expect(headers.get('x-static')).toBe('from-helper')
    expect(headers.get('x-dynamic')).toBe('helped')
  })

  test('a refused upgrade surfaces when the transport starts', async () => {
    const srv = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('forbidden', { status: 403 }),
      websocket: { message() {} },
    })
    servers.push(srv)

    const transport = await build('remote', {
      type: 'ws',
      url: `ws://127.0.0.1:${srv.port}`,
      scope: 'user',
    })
    transport.onerror = () => undefined

    await expect(transport.start()).rejects.toBeDefined()
  })
})

// ── WebSocket proxying ──────────────────────────────────────────────────────

/** A TCP listener standing in for an HTTP proxy: records each request line, then hangs up. */
async function startProxy(): Promise<{ url: string; requestLines: string[] }> {
  const requestLines: string[] = []
  const sockets = new Set<Socket>()
  const proxy: NetServer = createServer(sock => {
    sockets.add(sock)
    sock.once('data', data => {
      requestLines.push(data.toString().split('\r\n')[0]!)
      sock.destroy()
    })
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const { port } = proxy.address() as { port: number }
  closers.push(async () => {
    for (const sock of sockets) sock.destroy()
    await new Promise<void>(resolve => proxy.close(() => resolve()))
  })
  return { url: `http://127.0.0.1:${port}`, requestLines }
}

const WS_VARIANTS: Array<{
  label: string
  config: (url: string) => ScopedMcpServerConfig
}> = [
  {
    label: 'ws',
    config: (url: string): ScopedMcpServerConfig => ({
      type: 'ws',
      url,
      scope: 'user',
    }),
  },
  {
    label: 'ws-ide',
    config: (url: string): ScopedMcpServerConfig => ({
      type: 'ws-ide',
      url,
      ideName: 'VS Code',
      scope: 'dynamic',
    }),
  },
]

describe.each(WS_VARIANTS)('createTransport — $label proxying', ({ config }) => {
  test('HTTPS_PROXY tunnels the upgrade through a CONNECT to the proxy', async () => {
    const server = startWsServer()
    const proxy = await startProxy()
    process.env.HTTPS_PROXY = proxy.url
    const target = new URL(server.url)

    const transport = await build('proxied', config(server.url))
    transport.onerror = () => undefined

    // The stand-in proxy hangs up, so the socket never opens.
    await expect(transport.start()).rejects.toBeDefined()
    expect(proxy.requestLines).toEqual([`CONNECT ${target.host} HTTP/1.1`])
    expect(server.upgrades).toEqual([])
  })

  test('NO_PROXY matching the host connects directly', async () => {
    const server = startWsServer()
    const proxy = await startProxy()
    process.env.HTTPS_PROXY = proxy.url
    process.env.NO_PROXY = '127.0.0.1'

    const transport = await build('direct', config(server.url))
    await roundTrip(transport)

    expect(proxy.requestLines).toEqual([])
    expect(server.upgrades).toHaveLength(1)
  })
})

// ── SSE ─────────────────────────────────────────────────────────────────────

type SseServer = { url: string; requests: SeenRequest[] }

function startSseServer(): SseServer {
  const requests: SeenRequest[] = []
  const srv = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      requests.push(snapshot(req))
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('event: endpoint\ndata: /messages\n\n'),
          )
          // Left open: the event stream is long-lived.
        },
      })
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })
  servers.push(srv)
  return { url: `http://127.0.0.1:${srv.port}/sse`, requests }
}

describe('createTransport — sse', () => {
  test('the event stream is opened with the MCP User-Agent, the stored OAuth token and the configured headers', async () => {
    const server = startSseServer()
    const config = {
      type: 'sse' as const,
      url: server.url,
      headers: { 'X-Static': 'static-value' },
      scope: 'user' as const,
    }
    memoryStorage(storedTokenFor('sse-srv', config, 'stored-access'))

    const transport = await build('sse-srv', config)
    expect(transport).toBeInstanceOf(SSEClientTransport)
    await transport.start()

    expect(server.requests).toHaveLength(1)
    const headers = server.requests[0]!.headers
    expect(headers.get('accept')).toBe('text/event-stream')
    expect(headers.get('user-agent')).toBe(getMCPUserAgent())
    expect(headers.get('authorization')).toBe('Bearer stored-access')
    expect(headers.get('x-static')).toBe('static-value')
  })

  test('without stored tokens the event stream carries no Authorization', async () => {
    const server = startSseServer()
    memoryStorage({})

    const transport = await build('sse-srv', {
      type: 'sse',
      url: server.url,
      scope: 'user',
    })
    await transport.start()

    expect(server.requests[0]!.headers.get('authorization')).toBeNull()
    expect(server.requests[0]!.headers.get('accept')).toBe('text/event-stream')
  })
})

describe('createTransport — sse-ide', () => {
  test('with no proxy configured it is a plain SSE transport that connects with the default fetch', async () => {
    const server = startSseServer()

    const transport = await build('ide-sse', {
      type: 'sse-ide',
      url: server.url,
      ideName: 'VS Code',
      scope: 'dynamic',
    })

    expect(transport).toBeInstanceOf(SSEClientTransport)
    await transport.start()
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]!.headers.get('accept')).toBe('text/event-stream')
    // The MCP User-Agent is only added by the proxied branch.
    expect(server.requests[0]!.headers.get('user-agent')).not.toBe(
      getMCPUserAgent(),
    )
  })
})

// ── Streamable HTTP ─────────────────────────────────────────────────────────

function startHttpServer(): { url: string; requests: SeenRequest[] } {
  const requests: SeenRequest[] = []
  const srv = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      requests.push(snapshot(req))
      return new Response(null, { status: 202 })
    },
  })
  servers.push(srv)
  return { url: `http://127.0.0.1:${srv.port}/mcp`, requests }
}

async function postNotification(transport: Transport): Promise<void> {
  await transport.start()
  await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
}

describe('createTransport — http', () => {
  test('without stored OAuth tokens the session ingress token is the Authorization', async () => {
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'ingress-jwt'
    const server = startHttpServer()
    memoryStorage({})

    const transport = await build('http-srv', {
      type: 'http',
      url: server.url,
      headers: { 'X-Static': 'static-value' },
      scope: 'user',
    })
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
    await postNotification(transport)

    expect(server.requests).toHaveLength(1)
    const headers = server.requests[0]!.headers
    expect(server.requests[0]!.method).toBe('POST')
    expect(headers.get('user-agent')).toBe(getMCPUserAgent())
    expect(headers.get('authorization')).toBe('Bearer ingress-jwt')
    expect(headers.get('x-static')).toBe('static-value')
  })

  test('stored OAuth tokens take Authorization over the session ingress token', async () => {
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'ingress-jwt'
    const server = startHttpServer()
    const config = {
      type: 'http' as const,
      url: server.url,
      scope: 'user' as const,
    }
    memoryStorage(storedTokenFor('http-srv', config, 'stored-access'))

    const transport = await build('http-srv', config)
    await postNotification(transport)

    expect(server.requests[0]!.headers.get('authorization')).toBe(
      'Bearer stored-access',
    )
  })

  test('with neither token no Authorization is sent', async () => {
    const server = startHttpServer()
    memoryStorage({})

    const transport = await build('http-srv', {
      type: 'http',
      url: server.url,
      scope: 'user',
    })
    await postNotification(transport)

    expect(server.requests[0]!.headers.get('authorization')).toBeNull()
  })
})

describe('createTransport — claudeai-proxy', () => {
  test('throws when there is no claude.ai OAuth token', async () => {
    // Bare mode makes getClaudeAIOAuthTokens() return null without reading storage.
    process.env.CLAUDIN_SIMPLE = '1'
    clearOAuthTokenCache()

    await expect(
      createTransport('proxied', {
        type: 'claudeai-proxy',
        url: 'https://claude.ai/connector',
        id: 'srv_123',
        scope: 'claudeai',
      }),
    ).rejects.toThrow('No claude.ai OAuth token found')
  })

  test('with a claude.ai token it builds a streamable HTTP transport (no request is made)', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'cai-token'
    clearOAuthTokenCache()

    const transport = await build('proxied', {
      type: 'claudeai-proxy',
      url: 'https://claude.ai/connector',
      id: 'srv_123',
      scope: 'claudeai',
    })

    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
  })
})

describe('createTransport — rejected types', () => {
  test('sdk servers are refused here', async () => {
    await expect(
      createTransport('sdk-srv', { type: 'sdk', name: 'x', scope: 'dynamic' }),
    ).rejects.toThrow('SDK servers should be handled in print.ts')
  })

  test('an unknown type is refused', async () => {
    await expect(
      createTransport('weird', {
        type: 'carrier-pigeon',
        scope: 'user',
      } as unknown as ScopedMcpServerConfig),
    ).rejects.toThrow('Unsupported server type: carrier-pigeon')
  })
})

// ── stdio ───────────────────────────────────────────────────────────────────

// The child announces its argv and two env vars as one JSON-RPC notification,
// then stays alive until stdin closes.
const CHILD_SOURCE = `
process.stdout.write(JSON.stringify({
  jsonrpc: '2.0',
  method: 'notifications/probe',
  params: {
    argv: process.argv.slice(2),
    probe: process.env.MCP_PROBE ?? null,
    prefixed: process.env.PREFIX_SEEN ?? null,
  },
}) + '\\n')
process.stdin.on('data', () => {})
process.stdin.on('end', () => process.exit(0))
`

function writeChild(): string {
  const path = join(tempDir(), 'child.js')
  writeFileSync(path, CHILD_SOURCE)
  return path
}

async function firstMessage(transport: Transport): Promise<JSONRPCMessage> {
  const got = new Promise<JSONRPCMessage>(resolve => {
    transport.onmessage = resolve
  })
  await transport.start()
  return got
}

describe('createTransport — stdio', () => {
  test('spawns the command with its args and the configured env on top of the subprocess env', async () => {
    const child = writeChild()

    const transport = await build('local', {
      type: 'stdio',
      command: process.execPath,
      args: [child, 'one', 'two'],
      env: { MCP_PROBE: 'from-config' },
      scope: 'user',
    })

    expect(transport).toBeInstanceOf(StdioClientTransport)
    expect(await firstMessage(transport)).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/probe',
      params: { argv: ['one', 'two'], probe: 'from-config', prefixed: null },
    })
  })

  test('a config with no type is treated as stdio', async () => {
    const child = writeChild()

    const transport = await build('legacy', {
      command: process.execPath,
      args: [child],
      scope: 'user',
    } as ScopedMcpServerConfig)

    expect(transport).toBeInstanceOf(StdioClientTransport)
    expect(await firstMessage(transport)).toMatchObject({
      params: { argv: [], probe: null },
    })
  })

  test('CLAUDIN_SHELL_PREFIX runs the prefix with the whole command line as its single argument', async () => {
    const child = writeChild()
    const prefix = join(tempDir(), 'prefix.sh')
    writeFileSync(prefix, '#!/bin/sh\nPREFIX_SEEN="$1" exec /bin/sh -c "$1"\n')
    chmodSync(prefix, 0o755)
    process.env.CLAUDIN_SHELL_PREFIX = prefix

    const transport = await build('wrapped', {
      type: 'stdio',
      command: process.execPath,
      args: [child, 'alpha'],
      scope: 'user',
    })

    expect(await firstMessage(transport)).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/probe',
      params: {
        argv: ['alpha'],
        probe: null,
        prefixed: `${process.execPath} ${child} alpha`,
      },
    })
  })
})
