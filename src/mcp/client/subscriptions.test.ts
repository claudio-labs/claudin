import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpSubscription, SubscriptionFilter } from '@modelcontextprotocol/client'
import { connectToServer, getServerCacheKey } from 'src/mcp/client/connection.js'
import { setEraCacheDirForTests } from 'src/mcp/client/eraCache.js'
import {
  DEFAULT_SUBSCRIPTION_TIMINGS,
  getMcpSubscriptions,
  isEmptyFilter,
  type ListenClient,
  listenFilter,
  reopenDelayMs,
  startMcpSubscriptions,
  stopMcpSubscriptions,
  type SubscriptionTimings,
  unhonored,
} from 'src/mcp/client/subscriptions.js'
import type { ConnectedMCPServer, MCPServerConnection } from 'src/mcp/types.js'
import { _setSecureStorageForTesting } from 'src/platform/secureStorage/index.js'
import { type ModernFixture, serveLegacy, serveModern } from 'src/mcp/__testutils__/eraServers.js'

const FAST: SubscriptionTimings = { baseDelayMs: 10, maxDelayMs: 40, stableMs: 10_000 }

/** A response that never comes, for a server that stopped answering. */
const NEVER = new Promise<Response>(() => {})

async function until(check: () => boolean, label: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}

describe('listenFilter', () => {
  test('asks for the list_changed flags the server advertises, and the resource URIs', () => {
    expect(listenFilter({ tools: { listChanged: true }, prompts: {}, resources: { listChanged: true } }, [])).toEqual({
      toolsListChanged: true,
      resourcesListChanged: true,
    })
    expect(listenFilter({ prompts: { listChanged: true } }, ['file:///a'])).toEqual({
      promptsListChanged: true,
      resourceSubscriptions: ['file:///a'],
    })
  })

  test('is empty for a server with nothing to announce', () => {
    expect(isEmptyFilter(listenFilter(undefined, []))).toBe(true)
    expect(isEmptyFilter(listenFilter({ tools: {} }, []))).toBe(true)
    expect(isEmptyFilter({ toolsListChanged: true })).toBe(false)
  })
})

describe('unhonored', () => {
  test('names each flag and URI asked for and not agreed to', () => {
    const asked: SubscriptionFilter = {
      toolsListChanged: true,
      promptsListChanged: true,
      resourcesListChanged: true,
      resourceSubscriptions: ['file:///a', 'file:///b'],
    }
    expect(unhonored(asked, { toolsListChanged: true, resourceSubscriptions: ['file:///a'] })).toEqual([
      'promptsListChanged',
      'resourcesListChanged',
      'file:///b',
    ])
    expect(unhonored(asked, asked)).toEqual([])
    expect(unhonored({}, {})).toEqual([])
  })
})

describe('reopenDelayMs', () => {
  test('doubles from 1 s up to 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(a => reopenDelayMs(a, DEFAULT_SUBSCRIPTION_TIMINGS))).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000,
    ])
  })
})

/** A listen that the test settles by hand, and a client that hands them out. */
function fakeClient(options: { era?: 'modern' | 'legacy' } = {}) {
  type Pending = {
    filter: SubscriptionFilter
    resolve: (s: McpSubscription) => void
    reject: (e: Error) => void
  }
  const listens: Pending[] = []
  const closes: string[] = []
  let transport: object | undefined = {}
  const client = {
    getProtocolEra: () => options.era ?? 'modern',
    getServerCapabilities: () => ({ tools: { listChanged: true } }),
    listen: (filter: SubscriptionFilter) =>
      new Promise<McpSubscription>((resolve, reject) => listens.push({ filter, resolve, reject })),
    get transport() {
      return transport
    },
  } as unknown as ListenClient
  function subscription(label: string, honoredFilter: SubscriptionFilter = { toolsListChanged: true }, closeError?: Error) {
    let end!: (reason: 'local' | 'graceful' | 'remote') => void
    const closed = new Promise<'local' | 'graceful' | 'remote'>(resolve => (end = resolve))
    const sub: McpSubscription = {
      honoredFilter,
      closed,
      close: async () => {
        closes.push(label)
        end('local')
        if (closeError) throw closeError
      },
    }
    return { sub, end }
  }
  return {
    client,
    listens,
    closes,
    subscription,
    dropTransport: () => {
      transport = undefined
    },
  }
}

describe('the listen loop (a hand-settled client)', () => {
  test('a legacy connection opens nothing', () => {
    const fake = fakeClient({ era: 'legacy' })
    expect(startMcpSubscriptions('srv', fake.client)).toBeUndefined()
    expect(fake.listens).toHaveLength(0)
  })

  test('starts once per client', async () => {
    const fake = fakeClient()
    const first = startMcpSubscriptions('srv', fake.client, { timings: FAST })
    expect(startMcpSubscriptions('srv', fake.client, { timings: FAST })).toBe(first!)
    expect(getMcpSubscriptions(fake.client)).toBe(first!)
    expect(fake.listens).toHaveLength(1)
    await stopMcpSubscriptions(fake.client)
    expect(getMcpSubscriptions(fake.client)).toBeUndefined()
    await stopMcpSubscriptions(fake.client)
  })

  test('a failed listen is tried again after the backoff', async () => {
    const fake = fakeClient()
    startMcpSubscriptions('srv', fake.client, { timings: FAST })
    fake.listens[0]!.reject(new Error('ack timed out'))
    await until(() => fake.listens.length === 2, 'a second listen')
    await stopMcpSubscriptions(fake.client)
  })

  test('a remote end reopens; a graceful end does not', async () => {
    const fake = fakeClient()
    startMcpSubscriptions('srv', fake.client, { timings: FAST })
    const first = fake.subscription('first')
    fake.listens[0]!.resolve(first.sub)
    await Bun.sleep(5)
    first.end('remote')
    await until(() => fake.listens.length === 2, 'the reopen')
    const second = fake.subscription('second')
    fake.listens[1]!.resolve(second.sub)
    await Bun.sleep(5)
    second.end('graceful')
    await Bun.sleep(50)
    expect(fake.listens).toHaveLength(2)
    await stopMcpSubscriptions(fake.client)
  })

  test('the reopen delay starts over once a stream has stayed open', async () => {
    const fake = fakeClient()
    let now = 0
    startMcpSubscriptions('srv', fake.client, {
      timings: { baseDelayMs: 10, maxDelayMs: 10_000, stableMs: 1000 },
      now: () => now,
    })
    // Two quick failures put the next delay at 40 ms.
    fake.listens[0]!.reject(new Error('x'))
    await until(() => fake.listens.length === 2, 'listen 2')
    fake.listens[1]!.reject(new Error('x'))
    await until(() => fake.listens.length === 3, 'listen 3')
    const stable = fake.subscription('stable')
    fake.listens[2]!.resolve(stable.sub)
    await Bun.sleep(5)
    now += 1000
    const started = Date.now()
    stable.end('remote')
    await until(() => fake.listens.length === 4, 'listen 4')
    expect(Date.now() - started).toBeLessThan(35)
    await stopMcpSubscriptions(fake.client)
  })

  test('a closed connection is not listened on again', async () => {
    const fake = fakeClient()
    startMcpSubscriptions('srv', fake.client, { timings: FAST })
    const sub = fake.subscription('only')
    fake.listens[0]!.resolve(sub.sub)
    await Bun.sleep(5)
    fake.dropTransport()
    sub.end('remote')
    await Bun.sleep(50)
    expect(fake.listens).toHaveLength(1)
    await stopMcpSubscriptions(fake.client)
  })

  test('a listen that resolves after stop is closed at once', async () => {
    const fake = fakeClient()
    startMcpSubscriptions('srv', fake.client, { timings: FAST })
    await stopMcpSubscriptions(fake.client)
    fake.listens[0]!.resolve(fake.subscription('late').sub)
    await until(() => fake.closes.includes('late'), 'the late close')
  })

  test('a listen that fails after stop is not retried', async () => {
    const fake = fakeClient()
    startMcpSubscriptions('srv', fake.client, { timings: FAST })
    await stopMcpSubscriptions(fake.client)
    fake.listens[0]!.reject(new Error('closed'))
    await Bun.sleep(50)
    expect(fake.listens).toHaveLength(1)
  })

  test('new resource URIs reopen with the whole filter and close the old stream', async () => {
    const fake = fakeClient()
    const loop = startMcpSubscriptions('srv', fake.client, { timings: FAST })!
    const old = fake.subscription('old')
    fake.listens[0]!.resolve(old.sub)
    await Bun.sleep(5)
    loop.setResourceSubscriptions(['file:///a'])
    expect(fake.listens[1]!.filter).toEqual({ toolsListChanged: true, resourceSubscriptions: ['file:///a'] })
    await until(() => fake.closes.includes('old'), 'the old stream to close')
    // The old stream's end does not reopen anything.
    await Bun.sleep(30)
    expect(fake.listens).toHaveLength(2)
    await stopMcpSubscriptions(fake.client)
  })

  test('a close that throws is logged, and stop still finishes', async () => {
    const fake = fakeClient()
    startMcpSubscriptions('srv', fake.client, { timings: FAST })
    fake.listens[0]!.resolve(fake.subscription('bad', { toolsListChanged: true }, new Error('send failed')).sub)
    await Bun.sleep(5)
    await stopMcpSubscriptions(fake.client)
    expect(fake.closes).toEqual(['bad'])
  })
})

describe('against a real 2026-07-28 server', () => {
  let fixture: ModernFixture | undefined
  const connections: MCPServerConnection[] = []
  const macroHost = globalThis as Record<string, unknown>
  let savedMacro: unknown
  let savedConfigDir: string | undefined
  let dir = ''

  beforeEach(() => {
    savedMacro = macroHost.MACRO
    macroHost.MACRO = { ...(savedMacro as Record<string, unknown> | undefined), VERSION: '0.0.0-test' }
    dir = mkdtempSync(join(tmpdir(), 'mcp-listen-'))
    savedConfigDir = process.env.CLAUDIN_CONFIG_DIR
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
    for (const connection of connections.splice(0)) {
      if (connection.type === 'connected') await connection.cleanup().catch(() => {})
      connectToServer.cache.delete(getServerCacheKey(connection.name, connection.config))
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

  async function connect(name: string, url: string): Promise<ConnectedMCPServer> {
    const connection = await connectToServer(name, { type: 'http', url, scope: 'user' })
    connections.push(connection)
    if (connection.type !== 'connected') throw new Error(`not connected: ${connection.type}`)
    return connection
  }

  function serveTools(options: Parameters<typeof serveModern>[1] = {}): ModernFixture {
    return serveModern(server => {
      server.registerTool('ping', { description: 'pong' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
    }, options)
  }

  test('tools/list_changed arrives on the stream at the handler, and a dropped stream is listened again', async () => {
    fixture = serveTools()
    const connection = await connect(`listen-${process.pid}`, fixture.url)
    expect(connection.capabilities.tools?.listChanged).toBe(true)
    let changes = 0
    connection.client.setNotificationHandler('notifications/tools/list_changed', async () => {
      changes++
    })
    startMcpSubscriptions(connection.name, connection.client, { timings: FAST })
    await until(() => fixture!.listens() === 1, 'the listen')
    const listen = fixture.hits.find(h => h.body?.method === 'subscriptions/listen')
    expect((listen?.body?.params as { notifications?: unknown }).notifications).toEqual({ toolsListChanged: true })

    // The server routes a notification to the stream only once it acked it.
    await until(() => fixture!.acks() === 1, 'the ack')
    fixture.notify.toolsChanged()
    await until(() => changes === 1, 'the first notification')

    fixture.dropListenStreams()
    await until(() => fixture!.listens() === 2, 'the re-listen')
    await until(() => fixture!.acks() === 2, 'the second ack')
    fixture.notify.toolsChanged()
    await until(() => changes === 2, 'a notification on the new stream')
  })

  test('cleanup closes the stream for good', async () => {
    fixture = serveTools()
    const connection = await connect(`listen-stop-${process.pid}`, fixture.url)
    startMcpSubscriptions(connection.name, connection.client, { timings: FAST })
    await until(() => fixture!.listens() === 1, 'the listen')
    await connection.cleanup()
    expect(getMcpSubscriptions(connection.client)).toBeUndefined()
    await Bun.sleep(60)
    expect(fixture.listens()).toBe(1)
  })

  test('cleanup does not wait out a server that stopped answering: the listen cancel gets at most a second', async () => {
    let hang = false
    // Once `hang` is set no POST is answered again; the open listen stream stays open.
    fixture = serveTools({ answer: () => (hang ? (NEVER as unknown as Response) : undefined) })
    const connection = await connect(`listen-hung-${process.pid}`, fixture.url)
    startMcpSubscriptions(connection.name, connection.client, { timings: FAST })
    await until(() => fixture!.acks() === 1, 'the ack')
    hang = true

    const cleanup = connection.cleanup().then(() => 'done' as const)
    const outcome = await Promise.race([cleanup, Bun.sleep(2000).then(() => 'still pending' as const)])
    // What cleanup would wait on: the listen's cancel, posted to the hung server.
    expect(fixture.methods().at(-1)).toBe('POST notifications/cancelled')
    // Stopping the server ends the hung POST, so a cleanup still pending finishes too.
    await fixture.stop()
    fixture = undefined
    await cleanup
    expect(outcome).toBe('done')
  })

  test('control: a 2025 connection opens no stream', async () => {
    const legacy = serveLegacy()
    try {
      const connection = await connect(`listen-legacy-${process.pid}`, legacy.url)
      expect(startMcpSubscriptions(connection.name, connection.client)).toBeUndefined()
      expect(legacy.methods()).not.toContain('POST subscriptions/listen')
    } finally {
      for (const connection of connections.splice(0)) {
        if (connection.type === 'connected') await connection.cleanup().catch(() => {})
        connectToServer.cache.delete(getServerCacheKey(connection.name, connection.config))
      }
      await legacy.stop()
    }
  })
})
