import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SKILLS_EXTENSION_ID } from '@modelcontextprotocol/client/ext/skills'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { connectToServer, getServerCacheKey } from 'src/mcp/client/connection.js'
import {
  getEraCacheKey,
  readEraVerdict,
  saveEraVerdict,
  setEraCacheDirForTests,
} from 'src/mcp/client/eraCache.js'
import { fetchCommandsForClient, getMcpToolsCommandsAndResources } from 'src/mcp/client/fetchCapabilities.js'
import type { EraVerdict } from 'src/mcp/client/negotiation.js'
import type { ConnectedMCPServer, MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { _setSecureStorageForTesting } from 'src/platform/secureStorage/index.js'
import type { Tool } from 'src/tools/Tool.js'
import { writeStdioServer } from 'src/mcp/__testutils__/connectionHarness.js'
import {
  type HttpFixture,
  serveLegacy,
  serveModern,
  type StdioEraFixture,
  writeModernStdioServer,
} from 'src/mcp/__testutils__/eraServers.js'

/*
 * connectToServer choosing the protocol era against real servers of both
 * eras: the probe, the 2025 fallback, the cached verdict that skips the probe,
 * and the switches that turn negotiation off. The era cache lives in a temp
 * dir per test.
 */

const MODERN = '2026-07-28'
const LEGACY = '2025-11-25'

const macroHost = globalThis as Record<string, unknown>
let savedMacro: unknown
let savedNegotiation: string | undefined
let savedConfigDir: string | undefined
let cacheDir = ''
const fixtures: Array<{ stop: () => Promise<void> } | { dispose: () => void }> = []
const connections: MCPServerConnection[] = []
let seq = 0

beforeEach(() => {
  savedMacro = macroHost.MACRO
  macroHost.MACRO = { ...(savedMacro as Record<string, unknown> | undefined), VERSION: '0.0.0-test' }
  savedNegotiation = process.env.MCP_PROTOCOL_NEGOTIATION
  delete process.env.MCP_PROTOCOL_NEGOTIATION
  cacheDir = mkdtempSync(join(tmpdir(), 'mcp-era-cache-'))
  savedConfigDir = process.env.CLAUDIN_CONFIG_DIR
  process.env.CLAUDIN_CONFIG_DIR = cacheDir
  setEraCacheDirForTests(cacheDir)
  _setSecureStorageForTesting({
    name: 'memory',
    read: () => ({}),
    readAsync: async () => ({}),
    update: () => ({ success: true }),
    delete: () => true,
  })
})

afterEach(async () => {
  await closeAll()
  for (const fixture of fixtures.splice(0)) {
    if ('stop' in fixture) await fixture.stop()
    else fixture.dispose()
  }
  _setSecureStorageForTesting(null)
  setEraCacheDirForTests(undefined)
  if (savedConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = savedConfigDir
  rmSync(cacheDir, { recursive: true, force: true })
  if (savedNegotiation === undefined) delete process.env.MCP_PROTOCOL_NEGOTIATION
  else process.env.MCP_PROTOCOL_NEGOTIATION = savedNegotiation
  if (savedMacro === undefined) delete macroHost.MACRO
  else macroHost.MACRO = savedMacro
})

async function closeAll(): Promise<void> {
  for (const connection of connections.splice(0)) {
    if (connection.type === 'connected') await connection.cleanup().catch(() => {})
    connectToServer.cache.delete(getServerCacheKey(connection.name, connection.config))
  }
}

function track<T extends { stop: () => Promise<void> } | { dispose: () => void }>(fixture: T): T {
  fixtures.push(fixture)
  return fixture
}

function name(prefix: string): string {
  return `${prefix}-${process.pid}-${++seq}`
}

async function connect(serverName: string, config: ScopedMcpServerConfig): Promise<ConnectedMCPServer> {
  const connection = await connectToServer(serverName, config)
  connections.push(connection)
  if (connection.type !== 'connected') {
    throw new Error(`expected connected, got ${connection.type}: ${'error' in connection ? connection.error : ''}`)
  }
  return connection
}

const http = (url: string, extra: Partial<ScopedMcpServerConfig> = {}): ScopedMcpServerConfig =>
  ({ type: 'http', url, scope: 'user', ...extra }) as ScopedMcpServerConfig

function withTool(fixtureServer: { registerTool: ModernToolRegistrar }) {
  fixtureServer.registerTool('ping', { description: 'pong' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
}
type ModernToolRegistrar = Parameters<Parameters<typeof serveModern>[0]>[0]['registerTool']

const probes = (fixture: HttpFixture) => fixture.methods().filter(m => m === 'POST server/discover').length

const HOUR_MS = 60 * 60 * 1000

function modernVerdict(capabilities: Record<string, unknown>): EraVerdict {
  return {
    kind: 'modern',
    discover: { supportedVersions: [MODERN], capabilities } as never,
    savedAt: Date.now(),
    ttlMs: HOUR_MS,
  }
}

describe('http, a 2026-07-28 server', () => {
  test('connects as 2026-07-28 and records the version, but no verdict: over HTTP a modern one is never replayed', async () => {
    const fixture = track(serveModern(withTool))
    const serverName = name('modern')
    const config = http(fixture.url)
    const connection = await connect(serverName, config)
    expect(connection.protocolVersion).toBe(MODERN)
    expect(connection.client.getProtocolEra()).toBe('modern')
    expect(probes(fixture)).toBe(1)
    expect(fixture.methods()).not.toContain('POST initialize')
    expect(await readEraVerdict(getEraCacheKey(serverName, config))).toBeUndefined()
  })

  test('a second connect probes again, with one request', async () => {
    const fixture = track(serveModern(withTool))
    const serverName = name('modern-cached')
    const config = http(fixture.url)
    await connect(serverName, config)
    await closeAll()
    fixture.hits.length = 0
    const again = await connect(serverName, config)
    expect(again.protocolVersion).toBe(MODERN)
    expect(fixture.methods()).toEqual(['POST server/discover'])
    // and the connection works
    expect((await again.client.listTools()).tools.map(t => t.name)).toEqual(['ping'])
  })

  test('a prompt the redeployed server now offers is listed on the next connect', async () => {
    let withPrompt = false
    const fixture = track(
      serveModern(server => {
        withTool(server)
        if (withPrompt) {
          server.registerPrompt('greet', { description: 'hi' }, async () => ({
            messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
          }))
        }
      }),
    )
    const serverName = name('redeployed')
    const config = http(fixture.url)
    await connect(serverName, config)
    await closeAll()

    // createMcpHandler builds a new server per request: the next one has the prompt.
    withPrompt = true
    const again = await connect(serverName, config)
    fetchCommandsForClient.cache.delete(serverName)
    const prompts = await fetchCommandsForClient(again)
    expect({ hasPromptsCapability: again.capabilities.prompts !== undefined, prompts: prompts.length }).toEqual({
      hasPromptsCapability: true,
      prompts: 1,
    })
  })

  test('the client announces the skills, tasks and events extensions; extensions.skills: false leaves skills out', async () => {
    const fixture = track(serveModern(withTool))
    const metaOfList = () =>
      JSON.stringify(fixture.hits.findLast(h => h.body?.method === 'tools/list')?.body?.params)

    const all = await connect(name('extensions'), http(fixture.url))
    await all.client.listTools()
    expect(metaOfList()).toContain(SKILLS_EXTENSION_ID)
    expect(metaOfList()).toContain('io.modelcontextprotocol/tasks')
    expect(metaOfList()).toContain('io.modelcontextprotocol/events')

    const noSkills = await connect(name('no-skills'), http(fixture.url, { extensions: { skills: false } }))
    await noSkills.client.listTools()
    expect(metaOfList()).not.toContain(SKILLS_EXTENSION_ID)
    expect(metaOfList()).toContain('io.modelcontextprotocol/tasks')
  })
})

describe('http, a 2025 server', () => {
  test('the SDK falls back to initialize by itself, and the legacy verdict is cached', async () => {
    const fixture = track(serveLegacy())
    const serverName = name('legacy')
    const config = http(fixture.url)
    const connection = await connect(serverName, config)
    expect(connection.protocolVersion).toBe(LEGACY)
    expect(fixture.hits.slice(0, 2).map(h => `${h.method} ${h.status}`)).toEqual([
      'POST server/discover 400',
      'POST initialize 200',
    ])
    expect(fixture.initializeCapabilities()).toEqual([{ roots: {}, elicitation: {} }])
    expect(await readEraVerdict(getEraCacheKey(serverName, config))).toMatchObject({
      kind: 'legacy',
      ttlMs: 24 * 60 * 60 * 1000,
    })

    await closeAll()
    fixture.hits.length = 0
    const again = await connect(serverName, config)
    expect(again.protocolVersion).toBe(LEGACY)
    expect(probes(fixture)).toBe(0)
  })

  test('a probe answered 500 (Spring AI) is retried in the 2025 protocol on a fresh transport, and cached', async () => {
    const fixture = track(serveLegacy({ discoverStatus: 500 }))
    const serverName = name('spring')
    const config = http(fixture.url)
    const connection = await connect(serverName, config)
    expect(connection.protocolVersion).toBe(LEGACY)
    expect(fixture.hits.slice(0, 2).map(h => `${h.method} ${h.status}`)).toEqual([
      'POST server/discover 500',
      'POST initialize 200',
    ])
    expect(fixture.initializeCapabilities()).toEqual([{ roots: {}, elicitation: {} }])
    expect((await connection.client.callTool({ name: 'hello', arguments: {} })).content).toEqual([
      { type: 'text', text: 'hi' },
    ])
    expect(await readEraVerdict(getEraCacheKey(serverName, config))).toMatchObject({ kind: 'legacy' })
  })
})

/** A 2026-07-28 server that starts listening on `port` only `afterMs` from now. */
function serveLate(port: number, legacy: 'stateless' | 'reject', afterMs: number): { stop: () => Promise<void> } {
  let srv: ReturnType<typeof Bun.serve> | undefined
  const timer = setTimeout(() => {
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({ name: 'late', version: '2.4.0' })
        withTool(server)
        return server
      },
      { legacy },
    )
    srv = Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 0, fetch: req => handler.fetch(req) })
  }, afterMs)
  return {
    stop: async () => {
      clearTimeout(timer)
      srv?.stop(true)
    },
  }
}

function freePort(): number {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = probe.port!
  probe.stop(true)
  return port
}

describe('http, a probe the network refused (the server was not up yet)', () => {
  test('a dual-era 2026-07-28 server that comes up during the retries is reached in 2026-07-28', async () => {
    const port = freePort()
    track(serveLate(port, 'stateless', 120))
    const connection = await connect(name('late-dual'), http(`http://127.0.0.1:${port}/mcp`))
    expect(connection.protocolVersion).toBe(MODERN)
  })

  test('a 2026-07-28-only server that comes up during the retries connects', async () => {
    const port = freePort()
    track(serveLate(port, 'reject', 120))
    const connection = await connect(name('late-only'), http(`http://127.0.0.1:${port}/mcp`))
    expect(connection.protocolVersion).toBe(MODERN)
  })
})

describe('turning negotiation off', () => {
  test('MCP_PROTOCOL_NEGOTIATION=legacy sends no probe to a 2026-07-28 server and caches nothing', async () => {
    process.env.MCP_PROTOCOL_NEGOTIATION = 'legacy'
    const fixture = track(serveModern(withTool))
    const serverName = name('env-legacy')
    const config = http(fixture.url)
    const connection = await connect(serverName, config)
    expect(connection.protocolVersion).toBe(LEGACY)
    expect(probes(fixture)).toBe(0)
    expect(await readEraVerdict(getEraCacheKey(serverName, config))).toBeUndefined()
  })

  test("a server's own protocol: 'legacy' sends no probe", async () => {
    const fixture = track(serveModern(withTool))
    const connection = await connect(name('own-legacy'), http(fixture.url, { protocol: 'legacy' }))
    expect(connection.protocolVersion).toBe(LEGACY)
    expect(probes(fixture)).toBe(0)
  })

  test('the env wins over a server that answered the probe as 2026-07-28', async () => {
    const fixture = track(serveModern(withTool))
    const serverName = name('env-over-cache')
    const config = http(fixture.url)
    await connect(serverName, config)
    await closeAll()
    process.env.MCP_PROTOCOL_NEGOTIATION = 'legacy'
    const again = await connect(serverName, config)
    expect(again.protocolVersion).toBe(LEGACY)
  })
})

describe('a cached verdict the server no longer matches', () => {
  test('a modern verdict for an HTTP server gone back to 2025 is not adopted: the probe finds 2025, and the first list has its tools', async () => {
    const fixture = track(serveLegacy())
    const serverName = name('downgraded')
    const config = http(fixture.url)
    const key = getEraCacheKey(serverName, config)
    await saveEraVerdict(key, modernVerdict({ tools: {} }))

    // The first list runs before the hook's reconnecting onclose exists, as at startup.
    const attempts: Array<{ client: MCPServerConnection; tools: Tool[] }> = []
    await getMcpToolsCommandsAndResources(
      ({ client, tools }) => {
        connections.push(client)
        attempts.push({ client, tools })
      },
      { [serverName]: config },
    )

    const last = attempts.at(-1)!
    expect(last.client.type).toBe('connected')
    expect(last.tools.map(t => t.name.split('__').at(-1))).toEqual(['hello'])
    expect((last.client as ConnectedMCPServer).protocolVersion).toBe(LEGACY)
    expect(fixture.hits.slice(0, 2).map(h => `${h.method} ${h.status}`)).toEqual([
      'POST server/discover 400',
      'POST initialize 200',
    ])
    expect(await readEraVerdict(key)).toMatchObject({ kind: 'legacy' })
  })

  test('a legacy verdict whose connect fails is dropped and the connect probes on a fresh transport, caching nothing', async () => {
    // A modern-only server refuses initialize, so the legacy verdict fails.
    const fixture = track(serveModern(withTool, { legacyInitialize: 'reject' }))
    const serverName = name('upgraded')
    const config = http(fixture.url)
    const key = getEraCacheKey(serverName, config)
    await saveEraVerdict(key, { kind: 'legacy', savedAt: Date.now(), ttlMs: 60_000 })
    const connection = await connect(serverName, config)
    expect(connection.protocolVersion).toBe(MODERN)
    expect(fixture.methods().slice(0, 2)).toEqual(['POST initialize', 'POST server/discover'])
    expect(await readEraVerdict(key)).toBeUndefined()
  })

  test('an expired verdict is not used', async () => {
    const fixture = track(serveModern(withTool))
    const serverName = name('expired')
    const config = http(fixture.url)
    await saveEraVerdict(getEraCacheKey(serverName, config), {
      kind: 'legacy',
      savedAt: Date.now() - 2000,
      ttlMs: 1000,
    })
    const connection = await connect(serverName, config)
    expect(connection.protocolVersion).toBe(MODERN)
    expect(probes(fixture)).toBe(1)
  })

  test('a cached verdict whose connect keeps failing is dropped, even when nothing replaces it', async () => {
    const fixture = track(serveModern(withTool, { answer: () => new Response('down', { status: 500 }) }))
    const serverName = name('down')
    const config = http(fixture.url, { startupTimeout: 1000 })
    const key = getEraCacheKey(serverName, config)
    await saveEraVerdict(key, { kind: 'legacy', savedAt: Date.now(), ttlMs: 60_000 })
    const connection = await connectToServer(serverName, config)
    connections.push(connection)
    expect(connection.type).toBe('failed')
    expect(fixture.methods().slice(0, 2)).toEqual(['POST initialize', 'POST server/discover'])
    expect(await readEraVerdict(key)).toBeUndefined()
  })
})

/** A response that never comes: a server that took the request and hangs. */
const NEVER = new Promise<Response>(() => {})

describe('the probe and the startup deadline', () => {
  test('a probe the server never answers gets 5 s, and the 2025 protocol the rest of the startup timeout', async () => {
    const fixture = track(
      serveModern(withTool, {
        answer: body => (body?.method === 'server/discover' ? (NEVER as unknown as Response) : undefined),
      }),
    )
    const serverName = name('silent-probe')
    const config = http(fixture.url, { startupTimeout: 8000 })
    const started = Date.now()
    const connection = await connect(serverName, config)
    expect(connection.protocolVersion).toBe(LEGACY)
    expect(Date.now() - started).toBeLessThan(7000)
    expect(fixture.methods().slice(0, 2)).toEqual(['POST server/discover', 'POST initialize'])
    expect(await readEraVerdict(getEraCacheKey(serverName, config))).toMatchObject({ kind: 'legacy' })
  }, 15_000)

  test('a probe turned down after the deadline fails the connect instead of starting another one', async () => {
    const realNow = Date.now.bind(Date)
    let skew = 0
    const now = spyOn(Date, 'now').mockImplementation(() => realNow() + skew)
    try {
      const fixture = track(
        serveModern(withTool, {
          answer: body => {
            if (body?.method !== 'server/discover') return undefined
            // The startup timeout is spent by the time the 500 is read.
            skew = 10_000
            return new Response('probe refused', { status: 500 })
          },
        }),
      )
      const connection = await connectToServer(name('late-500'), http(fixture.url, { startupTimeout: 2000 }))
      connections.push(connection)
      expect(connection).toMatchObject({ type: 'failed', error: expect.stringContaining('HTTP 500') })
      expect(fixture.methods()).toEqual(['POST server/discover'])
    } finally {
      now.mockRestore()
    }
  })
})

describe('stdio', () => {
  let stdio: StdioEraFixture

  beforeAll(() => {
    stdio = writeModernStdioServer()
  })

  afterAll(() => {
    stdio.dispose()
  })

  test('a cache miss spawns a sibling for the probe (2 spawns); a hit spawns once', async () => {
    const serverName = name('stdio')
    const config = { type: 'stdio', command: stdio.command, args: stdio.args, env: stdio.env, scope: 'user' } as ScopedMcpServerConfig
    // A modern connect sends nothing to the session child, so each count is
    // read after a request it had to answer.
    const first = await connect(serverName, config)
    expect(first.protocolVersion).toBe(MODERN)
    expect((await first.client.listTools()).tools.map(t => t.name)).toEqual(['t'])
    expect(stdio.spawns()).toBe(2)
    await closeAll()

    const second = await connect(serverName, config)
    expect(second.protocolVersion).toBe(MODERN)
    expect((await second.client.listTools()).tools.map(t => t.name)).toEqual(['t'])
    expect(stdio.spawns()).toBe(3)
  }, 20_000)
})

describe('stdio, a cached modern verdict for a server gone back to 2025', () => {
  test('the in-place confirmation fails once, the verdict is dropped, and the probe connects it as 2025', async () => {
    // Answers initialize, and -32601 to anything else: 2025 only.
    const legacyOnly = track(writeStdioServer())
    const log = join(cacheDir, 'spawns.log')
    writeFileSync(log, '')
    const serverName = name('stdio-downgraded')
    const config = {
      type: 'stdio',
      command: legacyOnly.command,
      args: legacyOnly.args,
      env: { FIXTURE_SPAWN_LOG: log },
      scope: 'user',
    } as ScopedMcpServerConfig
    const key = getEraCacheKey(serverName, config)
    await saveEraVerdict(key, modernVerdict({ tools: {} }))

    const connection = await connect(serverName, config)
    expect(connection.protocolVersion).toBe(LEGACY)
    // The session the verdict was tried on, the probe's sibling, the new session.
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toHaveLength(3)
    expect(await readEraVerdict(key)).toMatchObject({ kind: 'legacy' })
  }, 20_000)
})
