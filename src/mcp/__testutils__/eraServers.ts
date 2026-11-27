/**
 * Real MCP servers of both protocol eras for the negotiation suites: a
 * 2026-07-28 server on the v2 SDK (`createMcpHandler`, which also serves 2025
 * clients statelessly), a 2025 server on the 1.x SDK, and stdio scripts of
 * each that log every spawn. Every HTTP fixture records the JSON-RPC method of
 * each POST and can be told to answer the `server/discover` probe with a
 * status of its own (Spring AI answers 500).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { McpServer as LegacyMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

export type Hit = { method: string; status: number; body?: Record<string, unknown> }

export type HttpFixture = {
  url: string
  hits: Hit[]
  /** The JSON-RPC methods posted, in order. */
  methods: () => string[]
  stop: () => Promise<void>
}

type Tap = (body: Record<string, unknown> | undefined) => Response | undefined

async function readBody(req: Request): Promise<Record<string, unknown> | undefined> {
  if (req.method !== 'POST') return undefined
  try {
    const parsed: unknown = JSON.parse(await req.clone().text())
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function discoverAnswer(status: number | undefined): Tap {
  return body =>
    status !== undefined && body?.method === 'server/discover'
      ? new Response('probe refused', { status })
      : undefined
}

export type ModernFixture = HttpFixture & {
  notify: ReturnType<typeof createMcpHandler>['notify']
  /** Ends every open subscriptions/listen stream without a response, as a dropped connection would. */
  dropListenStreams: () => void
  listens: () => number
}

/**
 * A 2026-07-28 server built by `build` on every request, as createMcpHandler
 * asks. `answer` may answer a request itself, raw, before the SDK server sees
 * it — a reply no SDK server would build (a task, SEP-2663).
 */
export function serveModern(
  build: (server: McpServer) => void,
  options: {
    discoverStatus?: number
    legacyInitialize?: 'stateless' | 'reject'
    answer?: Tap
  } = {},
): ModernFixture {
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: 'modern-fixture', version: '2.4.0' })
      build(server)
      return server
    },
    { legacy: options.legacyInitialize ?? 'stateless' },
  )
  const hits: Hit[] = []
  const tap = discoverAnswer(options.discoverStatus)
  const openStreams = new Set<() => void>()
  let listens = 0
  const srv = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const body = await readBody(req)
      const hit: Hit = { method: `${req.method} ${String(body?.method ?? '')}`.trim(), status: 0, body }
      hits.push(hit)
      const tapped = tap(body)
      const res = tapped ?? options.answer?.(body) ?? (await handler.fetch(req))
      hit.status = res.status
      if (body?.method !== 'subscriptions/listen' || !res.body) return res
      listens++
      const reader = res.body.getReader()
      let end = () => {}
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          end = () => {
            openStreams.delete(end)
            void reader.cancel().catch(() => {})
            try {
              controller.close()
            } catch {
              // already closed
            }
          }
          openStreams.add(end)
        },
        async pull(controller) {
          const { done, value } = await reader.read()
          if (done) {
            openStreams.delete(end)
            controller.close()
          } else {
            controller.enqueue(value)
          }
        },
      })
      return new Response(stream, { status: res.status, headers: res.headers })
    },
  })
  return {
    url: `http://127.0.0.1:${srv.port}/mcp`,
    hits,
    methods: () => hits.map(h => h.method),
    notify: handler.notify,
    dropListenStreams: () => {
      for (const end of [...openStreams]) end()
    },
    listens: () => listens,
    stop: async () => {
      for (const end of [...openStreams]) end()
      await handler.close()
      srv.stop(true)
    },
  }
}

export type LegacyFixture = HttpFixture & {
  /** The `params.capabilities` of every initialize, as it arrived. */
  initializeCapabilities: () => unknown[]
}

/** A stateful 2025 server on the 1.x SDK, one session per initialize. */
export function serveLegacy(options: { discoverStatus?: number } = {}): LegacyFixture {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()
  const hits: Hit[] = []
  const tap = discoverAnswer(options.discoverStatus)
  const srv = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const body = await readBody(req)
      const hit: Hit = { method: `${req.method} ${String(body?.method ?? '')}`.trim(), status: 0, body }
      hits.push(hit)
      const sessionId = req.headers.get('mcp-session-id')
      let res = tap(body)
      if (!res) {
        const existing = sessionId ? sessions.get(sessionId) : undefined
        if (existing) {
          res = await existing.handleRequest(req, { parsedBody: body })
        } else {
          const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: id => {
              sessions.set(id, transport)
            },
          })
          const server = new LegacyMcpServer({ name: 'legacy-fixture', version: '1.32.2' })
          server.registerTool('hello', { description: 'says hi' }, async () => ({
            content: [{ type: 'text', text: 'hi' }],
          }))
          await server.connect(transport)
          res = await transport.handleRequest(req, { parsedBody: body })
        }
      }
      hit.status = res.status
      return res
    },
  })
  return {
    url: `http://127.0.0.1:${srv.port}/mcp`,
    hits,
    methods: () => hits.map(h => h.method),
    initializeCapabilities: () =>
      hits
        .filter(h => h.body?.method === 'initialize')
        .map(h => (h.body?.params as { capabilities?: unknown } | undefined)?.capabilities),
    stop: async () => {
      for (const transport of sessions.values()) await transport.close().catch(() => {})
      srv.stop(true)
    },
  }
}

const MODERN_STDIO_SOURCE = (stdioEntry: string, serverEntry: string) => `
import { appendFileSync } from 'node:fs'
import { serveStdio } from ${JSON.stringify(stdioEntry)}
import { McpServer } from ${JSON.stringify(serverEntry)}
appendFileSync(process.env.SPAWN_LOG, 'spawn ' + process.pid + '\\n')
serveStdio(() => {
  const server = new McpServer({ name: 'stdio-modern', version: '2.4.0' })
  server.registerTool('t', { description: 'x' }, async () => ({ content: [{ type: 'text', text: 'ok' }] }))
  return server
}, { legacy: 'serve' })
`

export type StdioEraFixture = {
  command: string
  args: string[]
  env: Record<string, string>
  spawns: () => number
  dispose: () => void
}

/** A 2026-07-28 stdio server (v2 `serveStdio`, which also serves 2025 clients). */
export function writeModernStdioServer(): StdioEraFixture {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-era-stdio-'))
  const script = join(dir, 'server.mjs')
  const log = join(dir, 'spawns.log')
  writeFileSync(log, '')
  // The script runs from a temp dir, so the SDK is imported by absolute path.
  writeFileSync(
    script,
    MODERN_STDIO_SOURCE(
      Bun.resolveSync('@modelcontextprotocol/server/stdio', import.meta.dir),
      Bun.resolveSync('@modelcontextprotocol/server', import.meta.dir),
    ),
  )
  return {
    command: process.execPath,
    args: [script],
    env: { SPAWN_LOG: log },
    spawns: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).length,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}
