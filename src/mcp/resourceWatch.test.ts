// A read MCP resource that changes, end to end against real servers of both
// eras: the read subscribes, the server's notifications/resources/updated
// queues a notice, and the thread's next attachment pass carries it once.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer as LegacyMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { getMcpResourceChangeAttachments, processMcpResourceAttachments } from 'src/agent/attachments/services.js'
import type { Attachment } from 'src/agent/attachments/types.js'
import { normalizeAttachmentForAPI } from 'src/agent/messages/attachments.js'
import { type HttpFixture, serveLegacy, serveModern } from 'src/mcp/__testutils__/eraServers.js'
import { connectToServer, getServerCacheKey } from 'src/mcp/client/connection.js'
import { setEraCacheDirForTests } from 'src/mcp/client/eraCache.js'
import { reconnectMcpServerImpl } from 'src/mcp/client/fetchCapabilities.js'
import { getResourceSubscriptions, type ResourceSubscribeClient } from 'src/mcp/client/subscriptions.js'
import { getMcpResourceChanges, MAIN_THREAD, McpResourceChanges } from 'src/mcp/resourceChanges.js'
import { resumeMcpResourceWatches, watchMcpResource } from 'src/mcp/resourceWatch.js'
import type { ConnectedMCPServer, MCPServerConnection } from 'src/mcp/types.js'
import { _setSecureStorageForTesting } from 'src/platform/secureStorage/index.js'
import type { AgentId } from 'src/shared/types/ids.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { ReadMcpResourceTool } from 'src/tools/ReadMcpResourceTool/ReadMcpResourceTool.js'

const README = 'docs://readme'
const LINE = `The MCP resource ${README} on server "docs" changed since you read it. Read it again if you need its current content.`

async function until(check: () => boolean, label: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}

function contextFor(
  mcpClients: MCPServerConnection[],
  extra: Partial<Pick<ToolUseContext, 'agentId' | 'omitClaudeMdAttachments'>> = {},
): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => {},
    options: {
      mcpClients,
      mcpResources: { docs: [{ uri: README, name: 'README' }] },
    },
    ...extra,
  } as unknown as ToolUseContext
}

/** The text the model gets from this thread's next attachment pass. */
function noticeText(context: Pick<ToolUseContext, 'agentId' | 'omitClaudeMdAttachments'>): string[] {
  return getMcpResourceChangeAttachments(context).flatMap((a: Attachment) =>
    normalizeAttachmentForAPI(a).map(m => String(m.message.content)),
  )
}

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {})
  getMcpResourceChanges().clear()
})

/** A 2025 server on the 1.x SDK, joined in memory; `subscribe` adds resources/subscribe. */
async function legacyDocsServer(options: { subscribe: boolean }) {
  const server = new LegacyMcpServer({ name: 'docs', version: '1.0.0' })
  server.registerResource('readme', README, { mimeType: 'text/plain' }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'Hello.' }],
  }))
  const subscribed: string[] = []
  if (options.subscribe) {
    server.server.registerCapabilities({ resources: { subscribe: true } })
    server.server.setRequestHandler(SubscribeRequestSchema, async req => {
      subscribed.push(req.params.uri)
      return {}
    })
    server.server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}))
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const sent: string[] = []
  const send = clientSide.send.bind(clientSide)
  clientSide.send = async (message, sendOptions) => {
    if ('method' in message) sent.push(message.method)
    return send(message, sendOptions)
  }
  const client = new Client({ name: 'resource-watch', version: '1.0.0' })
  await server.connect(serverSide)
  await client.connect(clientSide)
  closers.push(async () => {
    await client.close()
    await server.close()
  })
  const connection: ConnectedMCPServer = {
    type: 'connected',
    name: 'docs',
    client,
    capabilities: client.getServerCapabilities() ?? {},
    config: { type: 'sdk', name: 'docs', scope: 'local' } as ConnectedMCPServer['config'],
    cleanup: async () => {},
  }
  return { server, connection, subscribed, sent }
}

describe('a 2025 server that offers resources/subscribe', () => {
  test('ReadMcpResource subscribes; an update is told to the next request once, then it is gone', async () => {
    const docs = await legacyDocsServer({ subscribe: true })
    const context = contextFor([docs.connection])
    await ReadMcpResourceTool.call({ server: 'docs', uri: README }, context)
    await until(() => docs.subscribed.length === 1, 'the subscribe')
    expect(docs.subscribed).toEqual([README])
    expect(noticeText(context)).toEqual([])

    // Two updates before the next request: one line.
    await docs.server.server.sendResourceUpdated({ uri: README })
    await docs.server.server.sendResourceUpdated({ uri: README })
    await Bun.sleep(30)
    const text = noticeText(context)
    expect(text).toHaveLength(1)
    expect(text[0]).toBe(`<system-reminder>\n${LINE}\n</system-reminder>`)
    expect(noticeText(context)).toEqual([])
  })

  test('an @-mention subscribes too, and a second read of the same URI sends nothing more', async () => {
    const docs = await legacyDocsServer({ subscribe: true })
    const context = contextFor([docs.connection])
    const attachments = await processMcpResourceAttachments(`look at @docs:${README}`, context)
    expect(attachments.map(a => a.type)).toEqual(['mcp_resource'])
    await until(() => docs.subscribed.length === 1, 'the subscribe')
    await ReadMcpResourceTool.call({ server: 'docs', uri: README }, context)
    await Bun.sleep(20)
    expect(docs.subscribed).toEqual([README])
    expect(getResourceSubscriptions(docs.connection.client)).toEqual([README])
  })

  test('a sub-agent is told of what it read, the main thread too; a slim agent read is not watched', async () => {
    const docs = await legacyDocsServer({ subscribe: true })
    const child = contextFor([docs.connection], { agentId: 'child' as AgentId })
    await ReadMcpResourceTool.call({ server: 'docs', uri: README }, child)
    await until(() => docs.subscribed.length === 1, 'the subscribe')
    await docs.server.server.sendResourceUpdated({ uri: README })
    let childText: string[] = []
    await until(() => (childText = noticeText(child)).length > 0, 'the child notice')
    expect(childText[0]).toContain(LINE)
    expect(noticeText(contextFor([docs.connection], { agentId: 'other' as AgentId }))).toEqual([])
    expect(noticeText(contextFor([docs.connection]))[0]).toContain(LINE)

    const slim = await legacyDocsServer({ subscribe: true })
    const plan = contextFor([slim.connection], { agentId: 'plan' as AgentId, omitClaudeMdAttachments: true })
    await ReadMcpResourceTool.call({ server: 'docs', uri: README }, plan)
    await Bun.sleep(20)
    expect(slim.subscribed).toEqual([])
    expect(noticeText(plan)).toEqual([])
  })
})

describe('a server without resources.subscribe', () => {
  test('the read sends no resources/subscribe and sets nothing up', async () => {
    const docs = await legacyDocsServer({ subscribe: false })
    const context = contextFor([docs.connection])
    await ReadMcpResourceTool.call({ server: 'docs', uri: README }, context)
    await processMcpResourceAttachments(`@docs:${README}`, context)
    await Bun.sleep(20)
    expect(docs.sent).toContain('resources/read')
    expect(docs.sent).not.toContain('resources/subscribe')
    expect(getResourceSubscriptions(docs.connection.client)).toEqual([])
  })
})

describe('watchMcpResource', () => {
  test('a subscription that throws is logged, and the read still counts', async () => {
    const changes = new McpResourceChanges()
    const client = {
      getServerCapabilities: () => ({ resources: { subscribe: true } }),
      getProtocolEra: () => 'legacy',
      transport: {},
      setNotificationHandler: () => {
        throw new Error('no handlers today')
      },
    } as unknown as ResourceSubscribeClient
    await watchMcpResource({ name: 'docs', client: client as unknown as ConnectedMCPServer['client'] }, README, {}, changes)
    changes.record({ server: 'docs', uri: README })
    expect(changes.take(MAIN_THREAD)).toEqual([{ server: 'docs', uri: README }])
  })

  test('a client that cannot even say its capabilities fails nothing and records nothing', async () => {
    const changes = new McpResourceChanges()
    const client = {} as unknown as ConnectedMCPServer['client']
    await watchMcpResource({ name: 'docs', client }, README, {}, changes)
    changes.record({ server: 'docs', uri: README })
    expect(changes.take(MAIN_THREAD)).toEqual([])
  })
})

describe('resumeMcpResourceWatches', () => {
  test("subscribes a new connection to the server's resources read before, the oldest forgotten past 50", async () => {
    const changes = new McpResourceChanges()
    for (let i = 0; i < 51; i++) changes.noteRead(MAIN_THREAD, { server: 'docs', uri: `docs://r${i}` })
    changes.noteRead(MAIN_THREAD, { server: 'other', uri: README })
    const subscribed: string[] = []
    const client = {
      getServerCapabilities: () => ({ resources: { subscribe: true } }),
      getProtocolEra: () => 'legacy',
      transport: {},
      setNotificationHandler: () => {},
      subscribeResource: async ({ uri }: { uri: string }) => {
        subscribed.push(uri)
        return {}
      },
      unsubscribeResource: async () => ({}),
    } as unknown as ConnectedMCPServer['client']
    await resumeMcpResourceWatches({ name: 'docs', client }, changes)
    expect(subscribed).toHaveLength(50)
    expect(subscribed[0]).toBe('docs://r1')
    expect(changes.watchedUris('docs')).toEqual(subscribed)
    expect(changes.watchedUris('other')).toEqual([README])
  })
})

describe('over HTTP', () => {
  let fixture: HttpFixture | undefined
  const connections: MCPServerConnection[] = []
  const macroHost = globalThis as Record<string, unknown>
  let savedMacro: unknown
  let savedConfigDir: string | undefined
  let dir = ''

  beforeEach(() => {
    savedMacro = macroHost.MACRO
    macroHost.MACRO = { ...(savedMacro as Record<string, unknown> | undefined), VERSION: '0.0.0-test' }
    dir = mkdtempSync(join(tmpdir(), 'mcp-resource-watch-'))
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

  function serveModernDocs() {
    return serveModern(server => {
      server.server.registerCapabilities({ resources: { subscribe: true } })
      server.registerResource('readme', README, { mimeType: 'text/plain' }, async uri => ({
        contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'Hello.' }],
      }))
    })
  }

  async function connectDocs(url: string): Promise<ConnectedMCPServer> {
    const connection = await connectToServer('docs', { type: 'http', url, scope: 'user' })
    connections.push(connection)
    if (connection.type !== 'connected') throw new Error(`not connected: ${connection.type}`)
    return connection
  }

  /** What /mcp reconnect and the hook's automatic retry both run. */
  async function reconnectDocs(previous: ConnectedMCPServer): Promise<ConnectedMCPServer> {
    const { client } = await reconnectMcpServerImpl('docs', previous.config)
    connections.push(client)
    if (client.type !== 'connected') throw new Error(`reconnect failed: ${client.type}`)
    expect(client.client).not.toBe(previous.client)
    return client
  }

  test('2026-07-28: the read reopens listen with the URI, and resourceUpdated becomes the notice', async () => {
    const modern = serveModernDocs()
    fixture = modern
    const connection = await connectDocs(modern.url)
    expect(connection.client.getProtocolEra()).toBe('modern')
    const context = contextFor([connection])

    await ReadMcpResourceTool.call({ server: 'docs', uri: README }, context)
    const listenWith = () =>
      modern.hits.filter(h => h.body?.method === 'subscriptions/listen').map(h => (h.body?.params as { notifications?: unknown }).notifications)
    await until(() => listenWith().some(n => JSON.stringify(n).includes(README)), 'the listen with the URI')
    expect(listenWith().at(-1)).toMatchObject({ resourceSubscriptions: [README] })
    expect(modern.methods()).not.toContain('POST resources/subscribe')

    // The ack has to land before a notification is routed to the stream.
    await Bun.sleep(50)
    modern.notify.resourceUpdated(README)
    let text: string[] = []
    await until(() => (text = noticeText(context)).length > 0, 'the notice')
    expect(text[0]).toContain(LINE)
    expect(noticeText(context)).toEqual([])
  })

  test('2026-07-28: a resource read before a reconnect is listened for on the new connection, and its change is told', async () => {
    const modern = serveModernDocs()
    fixture = modern
    const first = await connectDocs(modern.url)
    const context = contextFor([first])
    await ReadMcpResourceTool.call({ server: 'docs', uri: README }, context)
    const listensWithReadme = () =>
      modern.hits.filter(h => h.body?.method === 'subscriptions/listen' && JSON.stringify(h.body).includes(README)).length
    await until(() => listensWithReadme() === 1, 'the first listen with the URI')

    await reconnectDocs(first)
    await until(() => listensWithReadme() === 2, 'the listen with the URI on the new connection')
    // The server routes a notification to the stream only once it acked it.
    await until(() => modern.acks() === modern.listens(), 'the new stream acked')
    modern.notify.resourceUpdated(README)
    let text: string[] = []
    await until(() => (text = noticeText(context)).length > 0, 'the notice')
    expect(text[0]).toContain(LINE)
  })

  test('2025: a resource read before a reconnect is subscribed again on the new session, and its change is told', async () => {
    const subscribed: string[] = []
    const legacy = serveLegacy({
      build: server => {
        server.registerResource('readme', README, { mimeType: 'text/plain' }, async uri => ({
          contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'Hello.' }],
        }))
        server.server.registerCapabilities({ resources: { subscribe: true } })
        server.server.setRequestHandler(SubscribeRequestSchema, async req => {
          subscribed.push(req.params.uri)
          return {}
        })
        server.server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}))
      },
    })
    fixture = legacy
    const first = await connectDocs(legacy.url)
    expect(first.client.getProtocolEra()).toBe('legacy')
    const context = contextFor([first])
    await ReadMcpResourceTool.call({ server: 'docs', uri: README }, context)
    await until(() => subscribed.length === 1, 'the subscribe')

    await reconnectDocs(first)
    await until(() => subscribed.length === 2, 'the subscribe on the new session')
    await legacy.servers().at(-1)!.server.sendResourceUpdated({ uri: README })
    let text: string[] = []
    await until(() => (text = noticeText(context)).length > 0, 'the notice')
    expect(text[0]).toContain(LINE)
  })
})
