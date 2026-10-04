/**
 * Characterization of the pieces `connectToServer` is built from, pinned
 * before the clean-base rewrite:
 *
 * - the fetch wrappers (src/mcp/client/fetch.ts): the per-request timeout and
 *   Accept rule for MCP POSTs, and the claude.ai proxy fetch with its bearer
 *   token and its single retry after a 401;
 * - the needs-auth cache file (src/mcp/client/authCache.ts);
 * - the WebSocket transport (src/mcp/mcpWebSocketTransport.ts);
 * - the small rules callers lean on: cache keys, config equality, which
 *   servers count as local, which IDE tools are kept, and the env knobs.
 *
 * Requests go to loopback servers; credentials live in a temp
 * CLAUDIN_CONFIG_DIR (oauthTestBed).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server as NodeHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import {
  areMcpConfigsEqual,
  cleanupFailedConnection,
  clearMcpAuthCache,
  createClaudeAiProxyFetch,
  getMcpServerConnectionBatchSize,
  getServerCacheKey,
  wrapFetchWithTimeout,
} from 'src/mcp/client.js'
import { useIsolatedStore } from 'src/mcp/auth/__testutils__/oauthTestBed.js'
import { isMcpAuthCached, setMcpAuthCacheEntry } from 'src/mcp/client/authCache.js'
import { isIncludedMcpTool, isLocalMcpServer, MAX_MCP_DESCRIPTION_LENGTH } from 'src/mcp/client/connection.js'
import {
  getConnectionTimeoutMs,
  getRemoteMcpServerConnectionBatchSize,
  MCP_REQUEST_TIMEOUT_MS,
} from 'src/mcp/client/fetch.js'
import { serveWs, until, type WsBed } from 'src/mcp/client/__testutils__/mcpServerBed.js'
import { WebSocketTransport } from 'src/mcp/mcpWebSocketTransport.js'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'
import { clearOAuthTokenCache } from 'src/providers/auth/auth.js'
import type { Tool } from 'src/tools/Tool.js'

const store = useIsolatedStore()

const KNOBS = ['MCP_TIMEOUT', 'MCP_SERVER_CONNECTION_BATCH_SIZE', 'MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE', 'CLAUDE_CODE_OAUTH_TOKEN'] as const
let savedKnobs: Record<string, string | undefined> = {}
const stops: Array<() => unknown> = []

beforeEach(() => {
  savedKnobs = Object.fromEntries(KNOBS.map(k => [k, process.env[k]]))
  for (const key of KNOBS) delete process.env[key]
  clearMcpAuthCache()
  clearOAuthTokenCache()
})

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  for (const key of KNOBS) {
    if (savedKnobs[key] === undefined) delete process.env[key]
    else process.env[key] = savedKnobs[key]
  }
  clearMcpAuthCache()
  clearOAuthTokenCache()
})

type Seen = { method: string; headers: Record<string, string>; body: string }

/** A loopback HTTP server that records requests and answers through `reply`. */
function recorder(reply: (seen: Seen, index: number) => Response | Promise<Response> = () => new Response('ok')) {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const entry: Seen = {
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        body: await request.text(),
      }
      seen.push(entry)
      return reply(entry, seen.length - 1)
    },
  })
  stops.push(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}/mcp`, seen }
}

const scoped = (config: Record<string, unknown>) => config as unknown as ScopedMcpServerConfig

// --- small rules -------------------------------------------------------------------

describe('cache keys and config equality', () => {
  test('the cache key is the name, a dash, and the serialized config', () => {
    const config = scoped({ type: 'sse', url: 'https://a.example', scope: 'user' })
    expect(getServerCacheKey('slack', config)).toBe(`slack-${JSON.stringify(config)}`)
    const cases: Array<[string, ScopedMcpServerConfig, string, ScopedMcpServerConfig, boolean]> = [
      ['slack', config, 'slack', scoped({ type: 'sse', url: 'https://a.example', scope: 'user' }), true],
      ['slack', config, 'slack', scoped({ type: 'sse', url: 'https://b.example', scope: 'user' }), false],
      ['slack', config, 'slack', scoped({ type: 'sse', url: 'https://a.example', scope: 'project' }), false],
      ['slack', config, 'teams', config, false],
    ]
    for (const [nameA, a, nameB, b, same] of cases) {
      expect({ nameB, same: getServerCacheKey(nameA, a) === getServerCacheKey(nameB, b) }).toEqual({ nameB, same })
    }
  })

  test('two configs are equal when everything but the scope matches', () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>, boolean]> = [
      [{ type: 'sse', url: 'https://a', scope: 'user' }, { type: 'sse', url: 'https://a', scope: 'project' }, true],
      [{ type: 'sse', url: 'https://a', scope: 'user' }, { type: 'http', url: 'https://a', scope: 'user' }, false],
      [{ type: 'sse', url: 'https://a', scope: 'user' }, { type: 'sse', url: 'https://b', scope: 'user' }, false],
      [{ type: 'http', url: 'https://a', headers: { A: '1' }, scope: 'user' }, { type: 'http', url: 'https://a', headers: { A: '2' }, scope: 'user' }, false],
      [{ command: 'x', args: ['1'], scope: 'local' }, { command: 'x', args: ['1'], scope: 'user' }, true],
      [{ command: 'x', args: ['1'], scope: 'local' }, { type: 'stdio', command: 'x', args: ['1'], scope: 'local' }, false],
    ]
    for (const [a, b, equal] of cases) {
      expect({ a, b, equal: areMcpConfigsEqual(scoped(a), scoped(b)) }).toEqual({ a, b, equal })
    }
  })
})

describe('which servers are local, and which IDE tools are kept', () => {
  test('stdio (typed or not) and sdk servers are local; everything else is remote', () => {
    const cases: Array<[string | undefined, boolean]> = [
      [undefined, true],
      ['stdio', true],
      ['sdk', true],
      ['sse', false],
      ['http', false],
      ['ws', false],
      ['sse-ide', false],
      ['ws-ide', false],
      ['claudeai-proxy', false],
    ]
    for (const [type, local] of cases) {
      expect({ type, local: isLocalMcpServer(scoped(type ? { type } : { command: 'x' })) }).toEqual({ type, local })
    }
  })

  test('of the ide server only executeCode and getDiagnostics survive; other servers keep everything', () => {
    const cases: Array<[string, boolean]> = [
      ['mcp__ide__executeCode', true],
      ['mcp__ide__getDiagnostics', true],
      ['mcp__ide__openDiff', false],
      ['mcp__ide__', false],
      ['mcp__ide_tools__openDiff', true],
      ['mcp__slack__post', true],
      ['Bash', true],
    ]
    for (const [name, kept] of cases) {
      expect({ name, kept: isIncludedMcpTool({ name } as Tool) }).toEqual({ name, kept })
    }
  })
})

describe('knobs', () => {
  test('timeouts, batch sizes and caps', () => {
    expect(MCP_REQUEST_TIMEOUT_MS).toBe(60_000)
    expect(MAX_MCP_DESCRIPTION_LENGTH).toBe(2048)
    const cases: Array<[string, string | undefined, () => number, number]> = [
      ['MCP_TIMEOUT', undefined, getConnectionTimeoutMs, 30_000],
      ['MCP_TIMEOUT', '1500', getConnectionTimeoutMs, 1_500],
      ['MCP_TIMEOUT', '0', getConnectionTimeoutMs, 30_000],
      ['MCP_TIMEOUT', 'soon', getConnectionTimeoutMs, 30_000],
      ['MCP_SERVER_CONNECTION_BATCH_SIZE', undefined, getMcpServerConnectionBatchSize, 3],
      ['MCP_SERVER_CONNECTION_BATCH_SIZE', '7', getMcpServerConnectionBatchSize, 7],
      ['MCP_SERVER_CONNECTION_BATCH_SIZE', 'many', getMcpServerConnectionBatchSize, 3],
      ['MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE', undefined, getRemoteMcpServerConnectionBatchSize, 20],
      ['MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE', '50', getRemoteMcpServerConnectionBatchSize, 50],
      ['MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE', '', getRemoteMcpServerConnectionBatchSize, 20],
    ]
    for (const [key, value, read, expected] of cases) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
      expect({ key, value, got: read() }).toEqual({ key, value, got: expected })
    }
  })
})

describe('cleanupFailedConnection', () => {
  test('waits for the transport to finish closing', async () => {
    let finish: (() => void) | undefined
    let closed = false
    const transport = {
      close: () =>
        new Promise<void>(resolve => {
          finish = () => {
            closed = true
            resolve()
          }
        }),
    }
    let settled = false
    const pending = cleanupFailedConnection(transport).then(() => {
      settled = true
    })
    await Bun.sleep(5)
    expect({ closed, settled }).toEqual({ closed: false, settled: false })
    finish!()
    await pending
    expect({ closed, settled }).toEqual({ closed: true, settled: true })
  })

  test('closes the in-process server first, then the transport, and swallows errors from either', async () => {
    const order: string[] = []
    await cleanupFailedConnection(
      { close: async () => void order.push('transport') },
      { close: async () => void order.push('server') },
    )
    expect(order).toEqual(['server', 'transport'])

    const failing = async () => {
      throw new Error('already gone')
    }
    await expect(cleanupFailedConnection({ close: failing }, { close: failing })).resolves.toBeUndefined()
  })
})

// --- fetch wrappers ------------------------------------------------------------------

describe('wrapFetchWithTimeout', () => {
  test('POSTs gain the Streamable HTTP Accept value when they carry none; GETs and explicit Accepts are left alone', async () => {
    const bed = recorder()
    const wrapped = wrapFetchWithTimeout(globalThis.fetch)
    const cases: Array<[RequestInit | undefined, string]> = [
      [{ method: 'POST', body: '{}' }, 'application/json, text/event-stream'],
      [{ method: 'post', body: '{}', headers: { 'X-Extra': '1' } }, 'application/json, text/event-stream'],
      [{ method: 'POST', body: '{}', headers: { Accept: 'text/plain' } }, 'text/plain'],
      [{ method: 'POST', body: '{}', headers: [['accept', 'application/json']] }, 'application/json'],
      [{ method: 'DELETE' }, 'application/json, text/event-stream'],
    ]
    for (const [init, accept] of cases) {
      await wrapped(bed.url, init)
      expect({ init, accept: bed.seen.at(-1)!.headers.accept }).toEqual({ init, accept })
    }
    expect(bed.seen[1]!.headers['x-extra']).toBe('1')

    await wrapped(bed.url, { method: 'GET' })
    await wrapped(bed.url)
    for (const get of bed.seen.slice(-2)) {
      expect(get.method).toBe('GET')
      expect(get.headers.accept).not.toContain('text/event-stream')
    }
  })

  test("a GET keeps the caller's own signal; a POST gets a fresh one that follows the caller's", async () => {
    const signals: Array<AbortSignal | undefined> = []
    const base = async (_url: string | URL, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined)
      return new Response('ok')
    }
    const wrapped = wrapFetchWithTimeout(base)
    const mine = new AbortController()
    await wrapped('http://127.0.0.1:1/x', { method: 'GET', signal: mine.signal })
    await wrapped('http://127.0.0.1:1/x', { method: 'POST', signal: mine.signal })
    await wrapped('http://127.0.0.1:1/x', { method: 'POST' })
    expect(signals[0]).toBe(mine.signal)
    expect(signals[1]).not.toBe(mine.signal)
    expect(signals[1]!.aborted).toBe(false)
    expect(signals[2]).toBeInstanceOf(AbortSignal)
    expect(signals[2]!.aborted).toBe(false)
  })

  test('aborting the caller aborts the POST with the same reason, before or during the request', async () => {
    let release: (() => void) | undefined
    const held = new Promise<Response>(resolve => {
      release = () => resolve(new Response('late'))
    })
    const bed = recorder(() => held)
    stops.unshift(() => release!())
    const wrapped = wrapFetchWithTimeout(globalThis.fetch)

    const early = new AbortController()
    early.abort(new Error('changed my mind'))
    await expect(wrapped(bed.url, { method: 'POST', body: '{}', signal: early.signal })).rejects.toThrow('changed my mind')

    const late = new AbortController()
    const pending = wrapped(bed.url, { method: 'POST', body: '{}', signal: late.signal })
    await until(() => bed.seen.length, n => n > 0, 'the request to arrive')
    late.abort(new Error('user pressed escape'))
    await expect(pending).rejects.toThrow('user pressed escape')
  })

  test('errors from the inner fetch come through unchanged', async () => {
    const wrapped = wrapFetchWithTimeout(async () => {
      throw new TypeError('socket hang up')
    })
    await expect(wrapped('http://127.0.0.1:1/x', { method: 'POST' })).rejects.toThrow('socket hang up')
  })
})

describe('createClaudeAiProxyFetch', () => {
  function login(accessToken: string, refreshToken: string | null = null) {
    store.write({
      claudeAiOauth: {
        accessToken,
        refreshToken,
        expiresAt: Date.now() + 3_600_000,
        scopes: ['user:inference', 'user:mcp_servers'],
      },
    })
    clearOAuthTokenCache()
  }

  test('sends the login token as the bearer, over the headers the caller gave', async () => {
    login('ai-1')
    const bed = recorder(() => new Response('fine'))
    const proxied = createClaudeAiProxyFetch(globalThis.fetch)
    const response = await proxied(bed.url, { method: 'POST', body: 'x', headers: { 'X-Mine': 'kept', Authorization: 'Bearer stale' } })
    expect(await response.text()).toBe('fine')
    expect(bed.seen).toHaveLength(1)
    expect(bed.seen[0]!.headers.authorization).toBe('Bearer ai-1')
    expect(bed.seen[0]!.headers['x-mine']).toBe('kept')
  })

  test('without a login the request is never sent', async () => {
    const bed = recorder()
    const proxied = createClaudeAiProxyFetch(globalThis.fetch)
    await expect(proxied(bed.url, { method: 'POST' })).rejects.toThrow('No claude.ai OAuth token available')
    expect(bed.seen).toHaveLength(0)
  })

  test('a 401 is retried once only when the stored token changed meanwhile', async () => {
    const cases: Array<{ label: string; rotateTo?: { access: string; refresh: string | null }; requests: string[]; status: number }> = [
      { label: 'same token: the 401 is returned as is', requests: ['Bearer ai-1'], status: 401 },
      { label: 'rotated with a refresh token', rotateTo: { access: 'ai-2', refresh: 'r-2' }, requests: ['Bearer ai-1', 'Bearer ai-2'], status: 200 },
      { label: 'rotated by another process, no refresh token', rotateTo: { access: 'ai-3', refresh: null }, requests: ['Bearer ai-1', 'Bearer ai-3'], status: 200 },
    ]
    for (const { label, rotateTo, requests, status } of cases) {
      login('ai-1')
      const bed = recorder((seen, index) => {
        if (index === 0) {
          if (rotateTo) login(rotateTo.access, rotateTo.refresh)
          return new Response('expired', { status: 401 })
        }
        return new Response('again', { status: 200 })
      })
      const response = await createClaudeAiProxyFetch(globalThis.fetch)(bed.url, { method: 'POST', body: '{}' })
      expect({ label, status: response.status, requests: bed.seen.map(s => s.headers.authorization) }).toEqual({ label, status, requests })
    }
  })

  test('when the retry itself cannot be sent, the first 401 is returned', async () => {
    login('ai-1')
    let hits = 0
    const node: NodeHttpServer = createServer((req, res) => {
      hits += 1
      if (hits === 1) {
        login('ai-9')
        res.writeHead(401).end('expired')
        return
      }
      req.socket.destroy()
    })
    await new Promise<void>(resolve => node.listen(0, '127.0.0.1', () => resolve()))
    stops.push(() => new Promise<void>(resolve => node.close(() => resolve())))
    const url = `http://127.0.0.1:${(node.address() as AddressInfo).port}/mcp`
    const response = await createClaudeAiProxyFetch(globalThis.fetch)(url, { method: 'POST', body: '{}' })
    expect(response.status).toBe(401)
    expect(await response.text()).toBe('expired')
    expect(hits).toBeGreaterThanOrEqual(2)
  })
})

// --- the needs-auth cache --------------------------------------------------------------

describe('the needs-auth cache', () => {
  const cacheFile = () => join(store.configDir(), 'mcp-needs-auth-cache.json')

  test('entries are written to mcp-needs-auth-cache.json in the config dir, keyed by server name', async () => {
    const names = ['alpha', 'beta', 'gamma', 'delta']
    for (const name of names) setMcpAuthCacheEntry(name)
    const onDisk = await until(
      () => (existsSync(cacheFile()) ? JSON.parse(readFileSync(cacheFile(), 'utf8')) : {}),
      cache => names.every(n => n in cache),
      'every entry',
    )
    // On disk: the fixture holds the same file with every timestamp set to 0.
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'client/__fixtures__/rewrite/needs-auth-cache.json'), 'utf8'))
    const zeroed = Object.fromEntries(Object.entries(onDisk).map(([k, v]) => [k, { ...(v as object), timestamp: 0 }]))
    expect(zeroed).toEqual(fixture)
    for (const name of names) {
      expect(Object.keys(onDisk[name])).toEqual(['timestamp'])
      expect(Math.abs(onDisk[name].timestamp - Date.now())).toBeLessThan(10_000)
      expect(await isMcpAuthCached(name)).toBe(true)
    }
    expect(await isMcpAuthCached('epsilon')).toBe(false)
  })

  test('an entry counts for fifteen minutes', async () => {
    const minute = 60_000
    const cases: Array<[string, number, boolean]> = [
      ['just now', 0, true],
      ['14 minutes ago', 14 * minute, true],
      ['15 minutes ago and a bit', 15 * minute + 1_000, false],
      ['a day ago', 24 * 60 * minute, false],
    ]
    writeFileSync(cacheFile(), JSON.stringify(Object.fromEntries(cases.map(([label, age]) => [label, { timestamp: Date.now() - age }]))))
    clearMcpAuthCache()
    // clearing unlinks the file asynchronously; write it again after that settles
    await until(() => existsSync(cacheFile()), present => !present, 'the unlink')
    writeFileSync(cacheFile(), JSON.stringify(Object.fromEntries(cases.map(([label, age]) => [label, { timestamp: Date.now() - age }]))))
    for (const [label, , cached] of cases) {
      expect({ label, cached: await isMcpAuthCached(label) }).toEqual({ label, cached })
    }
  })

  test('a cache file in the stored format is honoured', async () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'client/__fixtures__/rewrite/needs-auth-cache.json'), 'utf8')) as Record<string, { timestamp: number }>
    const fresh = Object.fromEntries(Object.keys(fixture).map(name => [name, { timestamp: Date.now() }]))
    writeFileSync(cacheFile(), JSON.stringify(fresh))
    for (const name of Object.keys(fixture)) expect(await isMcpAuthCached(name)).toBe(true)
    expect(await isMcpAuthCached('omega')).toBe(false)
  })

  test('a missing or unreadable cache file means nothing is cached', async () => {
    expect(await isMcpAuthCached('anything')).toBe(false)
    clearMcpAuthCache()
    await Bun.sleep(10)
    writeFileSync(cacheFile(), '{not json')
    expect(await isMcpAuthCached('anything')).toBe(false)
  })

  test('clearing forgets every entry and deletes the file', async () => {
    setMcpAuthCacheEntry('alpha')
    await until(() => existsSync(cacheFile()), Boolean, 'the cache file')
    expect(await isMcpAuthCached('alpha')).toBe(true)
    clearMcpAuthCache()
    await until(() => existsSync(cacheFile()), present => !present, 'the file to go')
    expect(await isMcpAuthCached('alpha')).toBe(false)
  })

  test('a write that cannot land is dropped quietly, but the entry still counts for this process', async () => {
    writeFileSync(join(store.root(), 'not-a-dir'), '')
    process.env.CLAUDIN_CONFIG_DIR = join(store.root(), 'not-a-dir', 'config')
    clearMcpAuthCache()
    expect(() => setMcpAuthCacheEntry('alpha')).not.toThrow()
    await Bun.sleep(30)
    expect(existsSync(join(store.root(), 'not-a-dir', 'config', 'mcp-needs-auth-cache.json'))).toBe(false)
    expect(await isMcpAuthCached('alpha')).toBe(true)
  })
})

// --- the WebSocket transport ---------------------------------------------------------------

describe('WebSocketTransport', () => {
  function bed(): WsBed {
    const ws = serveWs({ tools: [] })
    stops.push(ws.stop)
    return ws
  }

  async function opened(url: string): Promise<WebSocket> {
    const socket = new WebSocket(url, ['mcp'])
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('no socket')), { once: true })
    })
    return socket
  }

  test('carries JSON-RPC both ways once started, and start works only once', async () => {
    const server = bed()
    const transport = new WebSocketTransport(new WebSocket(server.url, ['mcp']))
    const received: JSONRPCMessage[] = []
    transport.onmessage = message => void received.push(message)
    await transport.start()
    await expect(transport.start()).rejects.toThrow('Start can only be called once per transport.')
    await transport.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
    })
    const [reply] = await until(() => received, list => list.length > 0, 'the reply')
    expect(reply).toMatchObject({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'bed' } } })
    await transport.close()
  })

  test('a socket that is already open can be wrapped and started', async () => {
    const server = bed()
    const socket = await opened(server.url)
    const transport = new WebSocketTransport(socket)
    await transport.start()
    await transport.close()
    expect(socket.readyState).toBeGreaterThanOrEqual(WebSocket.CLOSING)
  })

  test('frames that are not JSON-RPC reach onerror, not onmessage', async () => {
    const server = bed()
    const transport = new WebSocketTransport(new WebSocket(server.url, ['mcp']))
    const errors: Error[] = []
    const messages: unknown[] = []
    transport.onerror = error => void errors.push(error)
    transport.onmessage = message => void messages.push(message)
    await transport.start()
    await until(() => server.seen.length, n => n > 0, 'the upgrade')
    await Bun.sleep(20)
    server.shout('not json at all')
    server.shout(JSON.stringify({ hello: 'world' }))
    await until(() => errors, list => list.length === 2, 'both errors')
    expect(errors.every(e => e instanceof Error)).toBe(true)
    expect(messages).toEqual([])
    await transport.close()
  })

  test('the server hanging up fires onclose, after which sending fails', async () => {
    const server = bed()
    const transport = new WebSocketTransport(new WebSocket(server.url, ['mcp']))
    let closes = 0
    transport.onclose = () => void (closes += 1)
    await transport.start()
    await Bun.sleep(20)
    server.hangUp()
    await until(() => closes, n => n > 0, 'onclose')
    await expect(transport.send({ jsonrpc: '2.0', method: 'ping' } as JSONRPCMessage)).rejects.toThrow(
      'WebSocket is not open. Cannot send message.',
    )
  })

  test('close() closes the socket and fires onclose', async () => {
    const server = bed()
    const socket = new WebSocket(server.url, ['mcp'])
    const transport = new WebSocketTransport(socket)
    let closes = 0
    transport.onclose = () => void (closes += 1)
    await transport.start()
    await transport.close()
    // Once under Node's ws; Bun dispatches the socket's close synchronously,
    // so it fires twice there (see the spec's findings).
    expect(closes).toBeGreaterThanOrEqual(1)
    expect(socket.readyState).toBeGreaterThanOrEqual(WebSocket.CLOSING)
  })

  test('a socket that never opens makes start reject; one that closed makes start refuse', async () => {
    const server = bed()
    const port = new URL(server.url).port
    await server.stop()
    stops.pop()
    const refused = new WebSocketTransport(new WebSocket(`ws://127.0.0.1:${port}/`, ['mcp']))
    await expect(refused.start()).rejects.toBeDefined()

    const live = bed()
    const socket = await opened(live.url)
    socket.close()
    await until(() => socket.readyState, state => state === WebSocket.CLOSED, 'the close')
    const stale = new WebSocketTransport(socket)
    const startedLate = stale.start()
    const outcome = await Promise.race([startedLate.then(() => 'started', e => String(e)), Bun.sleep(200).then(() => 'pending')])
    expect(outcome).not.toBe('started')
  })
})
