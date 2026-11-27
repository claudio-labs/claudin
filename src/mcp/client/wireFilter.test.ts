import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
  Client,
  type JSONRPCMessage,
  StreamableHTTPClientTransport,
  type Transport,
} from '@modelcontextprotocol/client'
import { createMcpHandler, Server } from '@modelcontextprotocol/server'
import * as log from 'src/shared/log.js'
import type { SkippedEntry } from 'src/mcp/client/listValidation.js'
import { attachWireFilter } from 'src/mcp/client/wireFilter.js'
import type { WireRule } from 'src/mcp/client/wireRules.js'

const GOOD = { name: 'good', inputSchema: { type: 'object', properties: {} } }
const BAD = { name: 'bad', inputSchema: { type: 'string' } }

// --- the primitive, on a hand-driven transport -----------------------------

type Delivered = { message: JSONRPCMessage; seen: string }

function ruledOf(delivered: Delivered | undefined): string | undefined {
  return (delivered?.message as unknown as { result?: { ruled?: string } }).result?.ruled
}

function fakeTransport() {
  const sent: JSONRPCMessage[] = []
  const transport: Transport = {
    start: async () => {},
    close: async () => {},
    send: async message => {
      sent.push(message)
    },
  }
  return { transport, sent }
}

// A rule table that stamps what it saw, so a test can tell which rule ran.
const stamp = (label: string): WireRule => result => {
  result.ruled = label
}
const RULES: Record<string, WireRule> = { 'tools/list': stamp('tools'), 'prompts/list': stamp('prompts') }

function attached(rules: Record<string, WireRule> = RULES) {
  const { transport, sent } = fakeTransport()
  const delivered: Delivered[] = []
  attachWireFilter(transport, { onSkipped: () => {}, rules })
  // What the SDK's Protocol.connect does with an onmessage set before it.
  const filter = transport.onmessage!
  transport.onmessage = (message, extra) => {
    filter(message, extra)
    delivered.push({ message, seen: JSON.stringify(message) })
  }
  const receive = (message: Record<string, unknown>) =>
    transport.onmessage!({ jsonrpc: '2.0', ...message } as JSONRPCMessage)
  const request = (id: string | number, method: string) =>
    transport.send({ jsonrpc: '2.0', id, method } as JSONRPCMessage)
  return { transport, sent, delivered, receive, request }
}

describe('attachWireFilter', () => {
  test('applies the rule of the method a response answers, in place, before the SDK sees it', async () => {
    const wire = attached()
    await wire.request(1, 'tools/list')
    wire.receive({ id: 1, result: { tools: [] } })
    expect(wire.delivered[0]!.seen).toBe(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [], ruled: 'tools' } }))
  })

  test('still sends every request as it was', async () => {
    const wire = attached()
    await wire.request(1, 'tools/list')
    await wire.request(2, 'tools/call')
    expect(wire.sent.map(m => (m as { method: string }).method)).toEqual(['tools/list', 'tools/call'])
  })

  test('tells a numeric id from the same id as a string', async () => {
    const wire = attached()
    await wire.request(7, 'tools/list')
    await wire.request('7', 'prompts/list')
    wire.receive({ id: '7', result: {} })
    wire.receive({ id: 7, result: {} })
    expect(wire.delivered.map(ruledOf)).toEqual(['prompts', 'tools'])
  })

  test('leaves a response to a method with no rule alone', async () => {
    const wire = attached()
    await wire.request(1, 'tools/call')
    wire.receive({ id: 1, result: { content: [] } })
    expect(wire.delivered[0]!.message).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [] } } as JSONRPCMessage)
  })

  test('forgets an id once it is answered, by a result or an error', async () => {
    const wire = attached()
    await wire.request(1, 'tools/list')
    await wire.request(2, 'tools/list')
    wire.receive({ id: 1, result: {} })
    wire.receive({ id: 2, error: { code: -32603, message: 'boom' } })
    wire.receive({ id: 1, result: {} })
    wire.receive({ id: 2, result: {} })
    expect(wire.delivered.map(ruledOf)).toEqual(['tools', undefined, undefined, undefined])
  })

  test('does not take a server request that reuses an id for the answer', async () => {
    const wire = attached()
    await wire.request(1, 'tools/list')
    wire.receive({ id: 1, method: 'roots/list', params: {} })
    wire.receive({ id: 1, result: {} })
    expect(ruledOf(wire.delivered[1])).toBe('tools')
  })

  test('skips a result that is not an object, and a message with no id', async () => {
    const rule = { 'tools/list': (() => { throw new Error('must not run') }) as WireRule }
    const wire = attached(rule)
    await wire.request(1, 'tools/list')
    wire.receive({ id: 1, result: [] })
    wire.receive({ method: 'notifications/tools/list_changed' })
    expect(wire.delivered).toHaveLength(2)
  })

  test('a rule that throws is logged and the message still reaches the SDK', async () => {
    const logged = spyOn(log, 'logError').mockImplementation(() => {})
    try {
      const wire = attached({ 'tools/list': () => { throw new Error('rule broke') } })
      await wire.request(1, 'tools/list')
      wire.receive({ id: 1, result: { tools: [] } })
      expect(wire.delivered).toHaveLength(1)
      expect(String(logged.mock.calls[0]![0])).toContain('rule broke')
    } finally {
      logged.mockRestore()
    }
  })

  test('chains an onmessage that was already set, after the rule', async () => {
    const { transport } = fakeTransport()
    const seen: string[] = []
    transport.onmessage = message => seen.push(JSON.stringify(message))
    attachWireFilter(transport, { onSkipped: () => {}, rules: RULES })
    await transport.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' } as JSONRPCMessage)
    transport.onmessage!({ jsonrpc: '2.0', id: 3, result: {} } as JSONRPCMessage)
    expect(seen).toEqual([JSON.stringify({ jsonrpc: '2.0', id: 3, result: { ruled: 'tools' } })])
  })

  test('cuts a listing whose server repeats a cursor, and reports it once', async () => {
    const { transport } = fakeTransport()
    const cycles: Array<[string, string]> = []
    attachWireFilter(transport, { onSkipped: () => {}, rules: RULES, onCursorCycle: (m, c) => cycles.push([m, c]) })
    const pages: Array<[string | undefined, string]> = [[undefined, 'a'], ['a', 'b'], ['b', 'a']]
    const results: Array<Record<string, unknown>> = []
    for (const [index, [cursor, next]] of pages.entries()) {
      await transport.send({ jsonrpc: '2.0', id: index, method: 'tools/list', ...(cursor && { params: { cursor } }) } as JSONRPCMessage)
      const result = { nextCursor: next }
      results.push(result)
      transport.onmessage!({ jsonrpc: '2.0', id: index, result } as unknown as JSONRPCMessage)
    }
    expect(results.map(r => r.nextCursor)).toEqual(['a', 'b', undefined])
    expect(cycles).toEqual([['tools/list', 'a']])
  })

  test('an error answer drops the request from the cursor record', async () => {
    const { transport } = fakeTransport()
    const cycles: string[] = []
    attachWireFilter(transport, { onSkipped: () => {}, rules: RULES, onCursorCycle: (_m, c) => cycles.push(c) })
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' } as JSONRPCMessage)
    transport.onmessage!({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'boom' } } as JSONRPCMessage)
    await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' } as JSONRPCMessage)
    transport.onmessage!({ jsonrpc: '2.0', id: 2, result: { nextCursor: 'a' } } as unknown as JSONRPCMessage)
    expect(cycles).toEqual([])
  })

  test('uses the list rules by default', async () => {
    const { transport } = fakeTransport()
    const skips: Array<[string, SkippedEntry[]]> = []
    attachWireFilter(transport, { onSkipped: (kind, skipped) => skips.push([kind, skipped]) })
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' } as JSONRPCMessage)
    const message = { jsonrpc: '2.0', id: 1, result: { tools: [GOOD, BAD] } } as JSONRPCMessage
    transport.onmessage!(message)
    expect((message as unknown as { result: { tools: unknown[] } }).result.tools).toEqual([GOOD])
    expect(skips.map(([kind, skipped]) => [kind, skipped.map(s => s.name)])).toEqual([['tool', ['bad']]])
  })
})

// --- a real v2 Client on the 2026-07-28 wire -------------------------------

type Body = { id?: string | number; method?: string }

// A v2 low-level Server behind createMcpHandler, whose tools/list answers the
// raw tools as given. `raw` answers a method by hand instead, so a result can
// leave out what the server encoder would have filled in.
function serveModern(tools: unknown[], raw: Record<string, (body: Body) => unknown> = {}) {
  const handler = createMcpHandler(() => {
    const server = new Server({ name: 'modern-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler('tools/list', async () => ({ tools }) as never)
    return server
  })
  const httpServer = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      if (req.method === 'POST') {
        const body = (await req.clone().json()) as Body
        const answer = body.method ? raw[body.method] : undefined
        if (answer) return Response.json({ jsonrpc: '2.0', id: body.id, result: answer(body) })
      }
      return handler.fetch(req)
    },
  })
  return {
    url: new URL(`http://127.0.0.1:${httpServer.port}/mcp`),
    stop: () => {
      httpServer.stop(true)
      void handler.close()
    },
  }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function connectModern(url: URL, filtered: boolean) {
  const client = new Client(
    { name: 'wire-filter-test', version: '0' },
    { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 5000 } } },
  )
  const transport = new StreamableHTTPClientTransport(url)
  const skips: Array<[string, SkippedEntry[]]> = []
  if (filtered) attachWireFilter(transport, { onSkipped: (kind, skipped) => skips.push([kind, skipped]) })
  await client.connect(transport)
  cleanups.push(() => client.close())
  return { client, skips }
}

describe('on the 2026-07-28 era', () => {
  test('control: the SDK alone drops the whole page for one malformed tool', async () => {
    const server = serveModern([GOOD, BAD])
    cleanups.push(server.stop)
    const { client } = await connectModern(server.url, false)
    expect(client.getProtocolEra()).toBe('modern')
    await expect(client.listTools()).rejects.toThrow('Invalid result for tools/list')
  })

  test('listTools keeps the good tool and drops the bad one', async () => {
    const server = serveModern([GOOD, BAD])
    cleanups.push(server.stop)
    const { client, skips } = await connectModern(server.url, true)
    expect(client.getProtocolEra()).toBe('modern')
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['good'])
    expect(skips.map(([kind, skipped]) => [kind, skipped.map(s => s.name)])).toEqual([['tool', ['bad']]])
  })

  const bareList = { 'tools/list': () => ({ tools: [GOOD] }) }

  test('control: the SDK alone rejects a list result without resultType, ttlMs and cacheScope', async () => {
    const server = serveModern([], bareList)
    cleanups.push(server.stop)
    const { client } = await connectModern(server.url, false)
    await expect(client.listTools()).rejects.toThrow('Invalid result for tools/list')
  })

  test('a list result without resultType, ttlMs and cacheScope is accepted', async () => {
    const server = serveModern([], bareList)
    cleanups.push(server.stop)
    const { client } = await connectModern(server.url, true)
    expect(client.getProtocolEra()).toBe('modern')
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['good'])
  })
})
