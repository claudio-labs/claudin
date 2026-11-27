import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectToServer, getServerCacheKey } from 'src/mcp/client/connection.js'
import {
  getEraCacheKey,
  readEraVerdict,
  saveEraVerdict,
  setEraCacheDirForTests,
} from 'src/mcp/client/eraCache.js'
import type { EraVerdict } from 'src/mcp/client/negotiation.js'
import type { ConnectedMCPServer, MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { _setSecureStorageForTesting } from 'src/platform/secureStorage/index.js'
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

describe('http, a 2026-07-28 server', () => {
  test('connects as 2026-07-28 and records the version and the verdict', async () => {
    const fixture = track(serveModern(withTool))
    const serverName = name('modern')
    const config = http(fixture.url)
    const connection = await connect(serverName, config)
    expect(connection.protocolVersion).toBe(MODERN)
    expect(connection.client.getProtocolEra()).toBe('modern')
    expect(probes(fixture)).toBe(1)
    expect(fixture.methods()).not.toContain('POST initialize')
    const verdict = await readEraVerdict(getEraCacheKey(serverName, config))
    expect(verdict).toMatchObject({ kind: 'modern', ttlMs: 60 * 60 * 1000, discover: { supportedVersions: [MODERN] } })
    expect(Object.keys(JSON.parse(readFileSync(join(cacheDir, 'mcp-era-cache.json'), 'utf8')))).toEqual([
      getEraCacheKey(serverName, config),
    ])
  })

  test('a second connect adopts the cached verdict and sends nothing to connect', async () => {
    const fixture = track(serveModern(withTool))
    const serverName = name('modern-cached')
    const config = http(fixture.url)
    await connect(serverName, config)
    await closeAll()
    fixture.hits.length = 0
    const again = await connect(serverName, config)
    expect(again.protocolVersion).toBe(MODERN)
    expect(fixture.hits).toEqual([])
    // and the connection works
    expect((await again.client.listTools()).tools.map(t => t.name)).toEqual(['ping'])
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

  test('the env wins over a cached modern verdict', async () => {
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
  test('a modern verdict for a server gone back to 2025: the first request drops it, and the reconnect probes', async () => {
    const fixture = track(serveLegacy())
    const serverName = name('downgraded')
    const config = http(fixture.url)
    const key = getEraCacheKey(serverName, config)
    const stale: EraVerdict = {
      kind: 'modern',
      discover: { supportedVersions: [MODERN], capabilities: { tools: {} } } as never,
      savedAt: Date.now(),
      ttlMs: 60 * 60 * 1000,
    }
    await saveEraVerdict(key, stale)

    const adopted = await connect(serverName, config)
    expect(adopted.protocolVersion).toBe(MODERN)
    expect(fixture.hits).toEqual([])
    await expect(adopted.client.listTools()).rejects.toThrow()
    // The 400 dropped the verdict and closed the connection, which clears the memo.
    await waitForUndefined(() => readEraVerdict(key))

    const reconnected = await connect(serverName, config)
    expect(reconnected.protocolVersion).toBe(LEGACY)
    expect((await reconnected.client.listTools()).tools.map(t => t.name)).toEqual(['hello'])
    expect(await readEraVerdict(key)).toMatchObject({ kind: 'legacy' })
  })

  test('a legacy verdict whose connect fails is dropped and the connect probes on a fresh transport', async () => {
    // A modern-only server refuses initialize, so the legacy verdict fails.
    const fixture = track(serveModern(withTool, { legacyInitialize: 'reject' }))
    const serverName = name('upgraded')
    const config = http(fixture.url)
    const key = getEraCacheKey(serverName, config)
    await saveEraVerdict(key, { kind: 'legacy', savedAt: Date.now(), ttlMs: 60_000 })
    const connection = await connect(serverName, config)
    expect(connection.protocolVersion).toBe(MODERN)
    expect(fixture.methods().slice(0, 2)).toEqual(['POST initialize', 'POST server/discover'])
    expect(await readEraVerdict(key)).toMatchObject({ kind: 'modern' })
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
    await saveEraVerdict(key, {
      kind: 'modern',
      discover: { supportedVersions: [MODERN], capabilities: { tools: {} } } as never,
      savedAt: Date.now(),
      ttlMs: 60 * 60 * 1000,
    })

    const connection = await connect(serverName, config)
    expect(connection.protocolVersion).toBe(LEGACY)
    // The session the verdict was tried on, the probe's sibling, the new session.
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toHaveLength(3)
    expect(await readEraVerdict(key)).toMatchObject({ kind: 'legacy' })
  }, 20_000)
})

async function waitForUndefined(read: () => Promise<unknown>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await read()) === undefined) return
    await Bun.sleep(10)
  }
  throw new Error('the cached verdict was never dropped')
}
