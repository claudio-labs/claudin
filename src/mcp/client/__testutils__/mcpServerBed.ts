/**
 * Real MCP servers for the client characterization suites (connection,
 * capabilities, callTool), each on the transport the client is meant to
 * reach it by:
 *
 * - `catalogServer` is an SDK `Server` built from a plain description of
 *   what it offers; `linkInMemory` puts a real SDK `Client` in front of it
 *   over the in-memory transport and hands back the connection record the
 *   rest of the app passes around.
 * - `serveHttp`, `serveSse` and `serveWs` put a catalog server on a loopback
 *   port (Streamable HTTP, legacy SSE, WebSocket) and record every request
 *   that reaches them, headers included.
 * - `writeStdioServer` writes a newline-delimited JSON-RPC server script that
 *   the client spawns, which logs what it saw to a file.
 *
 * Nothing here stands in for the code under test: every byte the client
 * sends crosses a real transport.
 */
import { afterAll, beforeAll } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server as NodeHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  type JSONRPCMessage,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { ConnectedMCPServer, ScopedMcpServerConfig } from 'src/mcp/types.js'

// --- the build constant -------------------------------------------------------------

/** The version the bundle would inline; the suites assert it reaches the server. */
export const BED_VERSION = '9.9.9-client-char'

/**
 * The bundle inlines `MACRO`; under `bun test` the client code reads it as a
 * global, so the calling file defines it for its run and puts it back after.
 */
export function useBuildMacro(): void {
  const globals = globalThis as { MACRO?: { VERSION: string } }
  let before: { VERSION: string } | undefined
  beforeAll(() => {
    before = globals.MACRO
    globals.MACRO = { ...(before ?? {}), VERSION: BED_VERSION }
  })
  afterAll(() => {
    if (before === undefined) delete globals.MACRO
    else globals.MACRO = before
  })
}

// --- what a server offers ------------------------------------------------------

export type ToolCallContext = {
  args: Record<string, unknown>
  meta: Record<string, unknown> | undefined
  progress: (progress: number, total?: number, message?: string) => Promise<void>
  signal: AbortSignal
}

export type BedTool = {
  name: string
  description?: string
  annotations?: Record<string, unknown>
  _meta?: Record<string, unknown>
  inputSchema?: Record<string, unknown>
  /** What tools/call answers; a throw becomes a JSON-RPC error. */
  run?: (ctx: ToolCallContext) => unknown | Promise<unknown>
}

export type BedPrompt = {
  name: string
  description?: string
  arguments?: Array<{ name: string; required?: boolean }>
  reply?: (args: Record<string, string>) => unknown[]
}

export type Catalog = {
  info?: { name: string; version: string }
  instructions?: string
  tools?: BedTool[]
  resources?: Array<Record<string, unknown>>
  prompts?: BedPrompt[]
  /** tools/list answers with an error this many times before it succeeds. */
  toolListFailures?: number
}

export type ServerLedger = {
  /** Every tools/call the server received, in order. */
  calls: Array<{ name: string; args: Record<string, unknown>; meta: Record<string, unknown> | undefined }>
  /** Count of each list request the server answered or refused. */
  lists: { tools: number; resources: number; prompts: number }
  /** prompts/get requests as received. */
  promptGets: Array<{ name: string; args: Record<string, string> | undefined }>
  /** The clientInfo and capabilities the client announced. */
  hello: { clientInfo?: Record<string, unknown>; capabilities?: Record<string, unknown> }
  /** Notifications the client sent, by method. */
  notes: Array<{ method: string; params: unknown }>
}

export function newLedger(): ServerLedger {
  return { calls: [], lists: { tools: 0, resources: 0, prompts: 0 }, promptGets: [], hello: {}, notes: [] }
}

/** An SDK server that answers from `catalog` and writes what it saw to `ledger`. */
export function catalogServer(catalog: Catalog, ledger: ServerLedger = newLedger()): Server {
  const capabilities: Record<string, object> = {}
  if (catalog.tools) capabilities.tools = {}
  if (catalog.resources) capabilities.resources = {}
  if (catalog.prompts) capabilities.prompts = {}
  const server = new Server(catalog.info ?? { name: 'bed', version: '1.0.0' }, {
    capabilities,
    ...(catalog.instructions !== undefined && { instructions: catalog.instructions }),
  })
  server.oninitialized = () => {
    ledger.hello = {
      clientInfo: server.getClientVersion() as Record<string, unknown> | undefined,
      capabilities: server.getClientCapabilities() as Record<string, unknown> | undefined,
    }
  }
  const original = server.fallbackNotificationHandler
  server.fallbackNotificationHandler = async note => {
    ledger.notes.push({ method: note.method, params: note.params })
    await original?.(note)
  }

  if (catalog.tools) {
    let refusals = catalog.toolListFailures ?? 0
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      ledger.lists.tools += 1
      if (refusals > 0) {
        refusals -= 1
        throw new Error('tool listing is warming up')
      }
      return {
        tools: catalog.tools!.map(tool => ({
          name: tool.name,
          ...(tool.description !== undefined && { description: tool.description }),
          ...(tool.annotations && { annotations: tool.annotations }),
          ...(tool._meta && { _meta: tool._meta }),
          inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        })),
      }
    })
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>
      const meta = request.params._meta as Record<string, unknown> | undefined
      ledger.calls.push({ name: request.params.name, args, meta })
      const tool = catalog.tools!.find(t => t.name === request.params.name)
      if (!tool) throw new Error(`no tool named ${request.params.name}`)
      const token = meta?.progressToken
      const progress = async (value: number, total?: number, message?: string) => {
        if (token === undefined) return
        await extra.sendNotification({
          method: 'notifications/progress',
          params: { progressToken: token as string | number, progress: value, total, message },
        })
      }
      const reply = await (tool.run ?? (() => ({ content: [{ type: 'text', text: 'ok' }] })))({
        args,
        meta,
        progress,
        signal: extra.signal,
      })
      return reply as never
    })
  }

  if (catalog.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      ledger.lists.resources += 1
      return { resources: catalog.resources! } as never
    })
  }

  if (catalog.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      ledger.lists.prompts += 1
      return {
        prompts: catalog.prompts!.map(p => ({
          name: p.name,
          ...(p.description !== undefined && { description: p.description }),
          ...(p.arguments && { arguments: p.arguments }),
        })),
      }
    })
    server.setRequestHandler(GetPromptRequestSchema, async request => {
      const args = request.params.arguments as Record<string, string> | undefined
      ledger.promptGets.push({ name: request.params.name, args })
      const prompt = catalog.prompts!.find(p => p.name === request.params.name)
      if (!prompt?.reply) throw new Error(`prompt ${request.params.name} has no body`)
      return { messages: prompt.reply(args ?? {}) } as never
    })
  }
  return server
}

/** The client Claudin builds, minus the transport: what the in-memory links use. */
function bedClient(): Client {
  return new Client(
    { name: 'bed-client', version: '1.0.0' },
    { capabilities: { roots: {}, elicitation: {} } },
  )
}

export type InMemoryLink = {
  connection: ConnectedMCPServer
  ledger: ServerLedger
  close: () => Promise<void>
}

/**
 * A connected record for `name`, backed by a real client and server over the
 * in-memory pair. The default config is an SDK server, the one kind the
 * connection cache leaves alone.
 */
export async function linkInMemory(
  name: string,
  catalog: Catalog,
  config: ScopedMcpServerConfig = { type: 'sdk', name, scope: 'dynamic' } as ScopedMcpServerConfig,
): Promise<InMemoryLink> {
  const ledger = newLedger()
  const server = catalogServer(catalog, ledger)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = bedClient()
  await client.connect(clientSide)
  const connection: ConnectedMCPServer = {
    name,
    type: 'connected',
    client,
    capabilities: client.getServerCapabilities() ?? {},
    config,
    cleanup: async () => {
      await client.close()
    },
  }
  return {
    connection,
    ledger,
    close: async () => {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    },
  }
}

/**
 * A `sendMcpMessage` callback in front of an SDK server, playing the role the
 * SDK host plays for `sdk` servers: a request gets the server's response, a
 * notification is delivered and answered with nothing the client waits for.
 */
export async function sdkHost(catalog: Catalog): Promise<{
  send: (serverName: string, message: JSONRPCMessage) => Promise<JSONRPCMessage>
  ledger: ServerLedger
  routed: string[]
  close: () => Promise<void>
}> {
  const ledger = newLedger()
  const server = catalogServer(catalog, ledger)
  const [hostSide, serverSide] = InMemoryTransport.createLinkedPair()
  const waiting = new Map<string | number, (m: JSONRPCMessage) => void>()
  hostSide.onmessage = message => {
    if ('id' in message && !('method' in message)) {
      waiting.get(message.id!)?.(message)
      waiting.delete(message.id!)
    }
  }
  await server.connect(serverSide)
  await hostSide.start()
  const routed: string[] = []
  return {
    ledger,
    routed,
    send: async (serverName, message) => {
      routed.push(serverName)
      if ('method' in message && 'id' in message) {
        const answer = new Promise<JSONRPCMessage>(resolve => waiting.set(message.id, resolve))
        await hostSide.send(message)
        return answer
      }
      await hostSide.send(message)
      // Nothing to answer: hand back a notification the client ignores.
      return { jsonrpc: '2.0', method: 'notifications/bed/ack' } as JSONRPCMessage
    },
    close: async () => {
      await server.close().catch(() => {})
    },
  }
}

// --- loopback servers ------------------------------------------------------------

export type SeenRequest = {
  method: string
  path: string
  headers: Record<string, string>
}

function headersOf(source: Headers | IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {}
  if (source instanceof Headers) {
    source.forEach((value, key) => {
      out[key] = value
    })
  } else {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string') out[key] = value
      else if (Array.isArray(value)) out[key] = value.join(', ')
    }
  }
  return out
}

export type LoopbackBed = {
  url: string
  seen: SeenRequest[]
  ledger: ServerLedger
  /** Answer every request with this instead of serving MCP, while set. */
  refuse: Response | undefined
  stop: () => Promise<void>
}

export type HttpBed = LoopbackBed & {
  /** Forget every session, so the next request carrying one gets 404 / -32001. */
  expireSessions: () => void
}

/** A Streamable HTTP MCP server on a loopback port; `url` points at `/mcp`, but any path is served. */
export function serveHttp(catalog: Catalog): HttpBed {
  const ledger = newLedger()
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()
  const servers: Server[] = []
  const bed: HttpBed = {
    url: '',
    seen: [],
    ledger,
    refuse: undefined,
    expireSessions: () => sessions.clear(),
    stop: async () => {
      http.stop(true)
      for (const s of servers) await s.close().catch(() => {})
    },
  }
  const http = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      bed.seen.push({ method: request.method, path: url.pathname, headers: headersOf(request.headers) })
      if (bed.refuse) return bed.refuse.clone()
      const sid = request.headers.get('mcp-session-id')
      if (sid) {
        const known = sessions.get(sid)
        if (!known) {
          return Response.json(
            { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null },
            { status: 404 },
          )
        }
        return known.handleRequest(request)
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: id => {
          sessions.set(id, transport)
        },
      })
      const server = catalogServer(catalog, ledger)
      servers.push(server)
      await server.connect(transport)
      return transport.handleRequest(request)
    },
  })
  bed.url = `http://127.0.0.1:${http.port}/mcp`
  return bed
}

/** A legacy SSE MCP server on a loopback port: GET `/sse`, POST `/messages`. */
export async function serveSse(catalog: Catalog): Promise<LoopbackBed> {
  const ledger = newLedger()
  const streams = new Map<string, SSEServerTransport>()
  const servers: Server[] = []
  const bed: LoopbackBed = {
    url: '',
    seen: [],
    ledger,
    refuse: undefined,
    stop: async () => {
      for (const s of servers) await s.close().catch(() => {})
      await new Promise<void>(resolve => {
        node.closeAllConnections()
        node.close(() => resolve())
      })
    },
  }
  const node: NodeHttpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    bed.seen.push({ method: req.method ?? '', path: url.pathname, headers: headersOf(req.headers) })
    if (bed.refuse) {
      const refusal = bed.refuse.clone()
      res.writeHead(refusal.status, Object.fromEntries(refusal.headers.entries()))
      res.end(await refusal.text())
      return
    }
    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages', res)
      streams.set(transport.sessionId, transport)
      const server = catalogServer(catalog, ledger)
      servers.push(server)
      await server.connect(transport)
      return
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const transport = streams.get(url.searchParams.get('sessionId') ?? '')
      if (!transport) {
        res.writeHead(404).end('no such stream')
        return
      }
      await transport.handlePostMessage(req, res)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>(resolve => node.listen(0, '127.0.0.1', () => resolve()))
  bed.url = `http://127.0.0.1:${(node.address() as AddressInfo).port}/sse`
  return bed
}

type WsPeer = { send(data: string): unknown; close(): void }

/** The server end of one WebSocket connection, as an SDK transport. */
function wsServerSide(peer: WsPeer): Transport {
  const side: Transport = {
    start: async () => {},
    send: async message => void peer.send(JSON.stringify(message)),
    close: async () => side.onclose?.(),
  }
  return side
}

export type WsBed = LoopbackBed & {
  /** Subprotocols the client offered, per connection. */
  protocols: string[]
  /** Sends raw text to every open connection. */
  shout: (text: string) => void
  /** Closes every open connection from the server side. */
  hangUp: () => void
}

/** A WebSocket MCP server on a loopback port that accepts the `mcp` subprotocol. */
export function serveWs(catalog: Catalog): WsBed {
  const ledger = newLedger()
  const open = new Map<object, { side: Transport; server: Server }>()
  type Peer = { data: undefined } & WsPeer
  const bed: WsBed = {
    url: '',
    seen: [],
    ledger,
    refuse: undefined,
    protocols: [],
    shout: text => {
      for (const peer of open.keys()) (peer as WsPeer).send(text)
    },
    hangUp: () => {
      for (const peer of open.keys()) (peer as WsPeer).close()
    },
    stop: async () => {
      for (const { server } of open.values()) await server.close().catch(() => {})
      ws.stop(true)
    },
  }
  const ws = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, srv) {
      const url = new URL(request.url)
      bed.seen.push({ method: request.method, path: url.pathname, headers: headersOf(request.headers) })
      if (bed.refuse) return bed.refuse.clone()
      bed.protocols.push(request.headers.get('sec-websocket-protocol') ?? '')
      const upgraded = srv.upgrade(request, { headers: { 'Sec-WebSocket-Protocol': 'mcp' } })
      return upgraded ? undefined : new Response('upgrade failed', { status: 400 })
    },
    websocket: {
      async open(peer: Peer) {
        const side = wsServerSide(peer)
        const server = catalogServer(catalog, ledger)
        open.set(peer, { side, server })
        await server.connect(side)
      },
      message(peer: Peer, text) {
        const entry = open.get(peer)
        entry?.side.onmessage?.(JSON.parse(String(text)) as JSONRPCMessage)
      },
      close(peer: Peer) {
        const entry = open.get(peer)
        open.delete(peer)
        entry?.side.onclose?.()
      },
    },
  })
  bed.url = `ws://127.0.0.1:${ws.port}/`
  return bed
}

// --- a stdio server ---------------------------------------------------------------

/*
 * Behaviour comes from its environment, so one script serves every case:
 *   BED_LOG           file it appends one JSON object per event to
 *   BED_INSTRUCTIONS  instructions returned by initialize
 *   BED_STDERR        text written to stderr at start
 *   BED_SILENT        "1": never answer initialize
 *   BED_TRAP          signals to ignore, comma-separated (each is logged)
 *   BED_ASK           "1": once initialized, ask the client for roots and for
 *                     an elicitation, and log both answers
 *   BED_ECHO_ENV      variable names whose values it logs at start
 */
const STDIO_SCRIPT = `
const fs = require('node:fs')
const readline = require('node:readline')
const env = process.env
const log = entry => env.BED_LOG && fs.appendFileSync(env.BED_LOG, JSON.stringify(entry) + '\\n')
const echoed = {}
for (const key of (env.BED_ECHO_ENV || '').split(',').filter(Boolean)) echoed[key] = env[key] ?? null
log({ event: 'start', pid: process.pid, argv: process.argv.slice(2), env: echoed })
if (env.BED_STDERR) process.stderr.write(env.BED_STDERR)
for (const sig of (env.BED_TRAP || '').split(',').filter(Boolean)) {
  process.on(sig, () => log({ event: 'signal', name: sig, pid: process.pid }))
}
const write = message => process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0' }, message)) + '\\n')
const tools = [{ name: 'echo', description: 'repeats its input', inputSchema: { type: 'object', properties: {} } }]
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === undefined) {
    log({ event: 'answer', id: message.id, result: message.result ?? null, error: message.error ?? null })
    return
  }
  if (message.id === undefined) {
    log({ event: 'note', method: message.method })
    if (message.method === 'notifications/initialized' && env.BED_ASK === '1') {
      write({ id: 'ask-roots', method: 'roots/list', params: {} })
      write({ id: 'ask-elicit', method: 'elicitation/create', params: { message: 'pick one', requestedSchema: { type: 'object', properties: {} } } })
    }
    return
  }
  if (message.method === 'initialize') {
    log({ event: 'initialize', params: message.params })
    if (env.BED_SILENT === '1') return
    const result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stdio-bed', version: '2.0.0' } }
    if (env.BED_INSTRUCTIONS !== undefined) result.instructions = env.BED_INSTRUCTIONS
    write({ id: message.id, result })
  } else if (message.method === 'tools/list') {
    write({ id: message.id, result: { tools } })
  } else if (message.method === 'tools/call') {
    write({ id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(message.params.arguments ?? {}) }] } })
  } else if (message.method === 'ping') {
    write({ id: message.id, result: {} })
  } else {
    write({ id: message.id, error: { code: -32601, message: 'no method ' + message.method } })
  }
})
`

export type StdioBed = {
  script: string
  logPath: string
  /** A stdio config entry for the script, with these variables set. */
  config: (env?: Record<string, string>) => ScopedMcpServerConfig
  /** Events the script logged, parsed. */
  events: () => Array<Record<string, any>>
  /** Pids of every copy of the script started so far. */
  pids: () => number[]
}

export function writeStdioServer(dir: string, logName = 'stdio-bed.log'): StdioBed {
  const script = join(dir, 'stdio-bed.cjs')
  const logPath = join(dir, logName)
  writeFileSync(script, STDIO_SCRIPT)
  const events = () =>
    existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line) as Record<string, any>)
      : []
  return {
    script,
    logPath,
    config: (env = {}) =>
      ({
        type: 'stdio',
        command: process.execPath,
        args: [script],
        env: { BED_LOG: logPath, ...env },
        scope: 'user',
      }) as ScopedMcpServerConfig,
    events,
    pids: () => events().filter(e => e.event === 'start').map(e => e.pid as number),
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Polls `read` until `done` holds; throws after `ms`. */
export async function until<T>(read: () => T, done: (value: T) => boolean, what: string, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = read()
    if (done(value)) return value
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`)
    await Bun.sleep(10)
  }
}
