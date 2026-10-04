/**
 * The modules the clean-base rewrite split `mcp/connection` into, at the
 * seams the characterization suites do not reach: the credential table, the
 * terminal-error rules, the process stopper's ladder, the needs-auth cache's
 * clear-versus-write ordering, and the WebSocket transport's edges.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { useIsolatedStore } from 'src/mcp/auth/__testutils__/oauthTestBed.js'
import { clearMcpAuthCache, isMcpAuthCached, setMcpAuthCacheEntry } from 'src/mcp/client/authCache.js'
import {
  closeOnTerminalErrors,
  judgeRemoteError,
  MAX_CONSECUTIVE_TERMINAL_ERRORS,
  type RemoteErrorVerdict,
  type RemoteTransportType,
  remoteTransportType,
} from 'src/mcp/client/connection/remoteErrors.js'
import {
  type ProcessStopperDeps,
  SIGKILL_AFTER_MS,
  SIGTERM_AFTER_MS,
  stopProcess,
} from 'src/mcp/client/connection/processStopper.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { clearServerCache, connectToServer, getServerCacheKey } from 'src/mcp/client.js'
import { isAlive, until, useBuildMacro, writeStdioServer } from 'src/mcp/client/__testutils__/mcpServerBed.js'
import {
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
} from 'src/mcp/client/fetchCapabilities.js'
import { getConnectionTimeoutMs, getMcpServerConnectionBatchSize, wrapFetchWithTimeout } from 'src/mcp/client/fetch.js'
import { createTransport } from 'src/mcp/client/transport.js'
import { outgoingHeaders, type CredentialInputs, type RemoteServerType } from 'src/mcp/client/transport/credentials.js'
import { WebSocketTransport } from 'src/mcp/mcpWebSocketTransport.js'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'

const store = useIsolatedStore()

describe('outgoingHeaders', () => {
  test('which credentials each remote type is given', () => {
    const base: CredentialInputs = { userAgent: 'ua/1' }
    const cases: Array<[string, RemoteServerType, Partial<CredentialInputs>, Record<string, string>]> = [
      ['http: ingress when nothing is stored', 'http', { ingressToken: 'in' }, { 'User-Agent': 'ua/1', Authorization: 'Bearer in' }],
      ['http: a stored token keeps ingress out', 'http', { ingressToken: 'in', hasStoredToken: true }, { 'User-Agent': 'ua/1' }],
      ['http: a configured header, any case, keeps ingress out', 'http', { ingressToken: 'in', configured: { authorization: 'Basic x' } }, { 'User-Agent': 'ua/1', authorization: 'Basic x' }],
      ['http: configured headers win', 'http', { configured: { 'User-Agent': 'mine', 'X-A': '1' } }, { 'User-Agent': 'mine', 'X-A': '1' }],
      ['ws: ingress whatever is stored', 'ws', { ingressToken: 'in', hasStoredToken: true }, { 'User-Agent': 'ua/1', Authorization: 'Bearer in' }],
      ['ws: a configured Authorization keeps ingress out', 'ws', { ingressToken: 'in', configured: { Authorization: 'Bearer c' } }, { 'User-Agent': 'ua/1', Authorization: 'Bearer c' }],
      ['sse: never ingress', 'sse', { ingressToken: 'in', configured: { 'X-A': '1' } }, { 'User-Agent': 'ua/1', 'X-A': '1' }],
      ['ws-ide: the lockfile token in its own header', 'ws-ide', { ingressToken: 'in', ideToken: 'lock' }, { 'User-Agent': 'ua/1', 'X-Claude-Code-Ide-Authorization': 'lock' }],
      ['ws-ide: no token, no header', 'ws-ide', { ingressToken: 'in' }, { 'User-Agent': 'ua/1' }],
      ['sse-ide: nothing at all', 'sse-ide', { ingressToken: 'in', configured: { 'X-A': '1' } }, {}],
      ['claudeai-proxy: the session id, never ingress', 'claudeai-proxy', { ingressToken: 'in', sessionId: 's-1' }, { 'User-Agent': 'ua/1', 'X-Mcp-Client-Session-Id': 's-1' }],
    ]
    for (const [label, type, inputs, expected] of cases) {
      expect({ label, headers: outgoingHeaders(type, { ...base, ...inputs }) }).toEqual({ label, headers: expected })
    }
  })
})

describe('terminal errors of remote connections', () => {
  const expired = Object.assign(new Error('Error POSTing to endpoint: {"error":{"code":-32001}}'), { code: 404 })

  test('what one error means, per transport', () => {
    const cases: Array<[string, Error, RemoteTransportType, RemoteErrorVerdict]> = [
      ['expired session on http', expired, 'http', 'close'],
      ['expired session on the proxy', expired, 'claudeai-proxy', 'close'],
      ['expired session text on sse', expired, 'sse', 'ignore'],
      ['reconnection exhausted', new Error('Maximum reconnection attempts (2) exceeded.'), 'sse', 'close'],
      ['connection reset', new Error('read ECONNRESET'), 'http', 'count'],
      ['refused', new Error('connect ECONNREFUSED 127.0.0.1:1'), 'sse', 'count'],
      ['stream gone', new Error('SSE stream disconnected: x'), 'http', 'count'],
      ['body timeout', new Error('Body Timeout Error'), 'http', 'count'],
      ['terminated', new TypeError('terminated'), 'claudeai-proxy', 'count'],
      ['a tool error', new Error('tool failed'), 'http', 'ignore'],
    ]
    for (const [label, error, type, verdict] of cases) {
      expect({ label, verdict: judgeRemoteError(error, type) }).toEqual({ label, verdict })
    }
  })

  test('only sse, http and the proxy are watched', () => {
    const cases: Array<[string | undefined, RemoteTransportType | undefined]> = [
      ['sse', 'sse'], ['http', 'http'], ['claudeai-proxy', 'claudeai-proxy'],
      ['ws', undefined], ['sse-ide', undefined], ['stdio', undefined], [undefined, undefined],
    ]
    for (const [type, expected] of cases) {
      const config = (type ? { type, scope: 'user' } : { command: 'x', scope: 'user' }) as unknown as ScopedMcpServerConfig
      expect({ type, got: remoteTransportType(config) }).toEqual({ type, got: expected })
    }
  })

  test('the client closes on the third network error in a row, not before, and a different error resets the count', async () => {
    const client = new Client({ name: 't', version: '0' })
    let closes = 0
    client.close = async () => void (closes += 1)
    closeOnTerminalErrors(client, 'srv', 'http')
    const reset = new Error('read ECONNRESET')
    expect(MAX_CONSECUTIVE_TERMINAL_ERRORS).toBe(3)
    client.onerror!(reset)
    client.onerror!(reset)
    client.onerror!(new Error('tool failed'))
    client.onerror!(reset)
    client.onerror!(reset)
    expect(closes).toBe(0)
    client.onerror!(reset)
    expect(closes).toBe(1)
    client.onerror!(expired)
    expect(closes).toBe(2)
  })
})

describe('stopProcess', () => {
  function fakeProcess(diesOn: NodeJS.Signals | 'never', alreadyGone = false) {
    const sent: NodeJS.Signals[] = []
    let alive = !alreadyGone
    const deps: ProcessStopperDeps = {
      signal: (_pid, signal) => {
        if (!alive) return false
        sent.push(signal)
        if (signal === diesOn || signal === 'SIGKILL') alive = false
        return true
      },
      isAlive: () => alive,
      sleep: ms => Bun.sleep(ms),
    }
    return { deps, sent }
  }

  test('each signal only while the process lives', async () => {
    const cases: Array<[NodeJS.Signals | 'never', boolean, NodeJS.Signals[], number]> = [
      ['SIGINT', true, [], 0],
      ['SIGINT', false, ['SIGINT'], 0],
      ['SIGTERM', false, ['SIGINT', 'SIGTERM'], SIGTERM_AFTER_MS],
      ['never', false, ['SIGINT', 'SIGTERM', 'SIGKILL'], SIGTERM_AFTER_MS + SIGKILL_AFTER_MS],
    ]
    for (const [diesOn, gone, expected, atLeastMs] of cases) {
      const { deps, sent } = fakeProcess(diesOn, gone)
      const started = Date.now()
      await stopProcess(4242, deps)
      const took = Date.now() - started
      expect({ diesOn, gone, sent }).toEqual({ diesOn, gone, sent: expected })
      expect(took).toBeGreaterThanOrEqual(atLeastMs - 5)
      expect(took).toBeLessThan(atLeastMs + 200)
    }
  })
})

describe('the needs-auth cache, clear against write', () => {
  const file = () => join(store.configDir(), 'mcp-needs-auth-cache.json')
  beforeEach(() => clearMcpAuthCache())
  afterEach(() => clearMcpAuthCache())

  test('a clear removes the file before it returns', async () => {
    setMcpAuthCacheEntry('alpha')
    await Bun.sleep(30)
    expect(existsSync(file())).toBe(true)
    clearMcpAuthCache()
    expect(existsSync(file())).toBe(false)
  })

  test('a write queued before a clear does not bring the entry back', async () => {
    setMcpAuthCacheEntry('alpha')
    clearMcpAuthCache()
    await Bun.sleep(50)
    expect(existsSync(file())).toBe(false)
    expect(await isMcpAuthCached('alpha')).toBe(false)
  })

  test('a file that parses but holds no object counts as empty, without an error', async () => {
    for (const content of ['null', '42', '"alpha"', '[{"timestamp":1}]']) {
      clearMcpAuthCache()
      await Bun.write(file(), content)
      expect({ content, cached: await isMcpAuthCached('alpha') }).toEqual({ content, cached: false })
    }
  })

  test('writes in a burst keep every entry', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `srv-${i}`)
    for (const name of names) setMcpAuthCacheEntry(name)
    await Bun.sleep(100)
    const onDisk = JSON.parse(await Bun.file(file()).text()) as Record<string, unknown>
    expect(Object.keys(onDisk).sort()).toEqual([...names].sort())
  })
})

describe('wrapFetchWithTimeout', () => {
  test('a GET in any letter case passes through with the caller\'s own init', async () => {
    const seen: Array<RequestInit | undefined> = []
    const wrapped = wrapFetchWithTimeout(async (_url, init) => {
      seen.push(init)
      return new Response('ok')
    })
    const mine = new AbortController()
    const init: RequestInit = { method: 'get', signal: mine.signal }
    await wrapped('http://127.0.0.1:1/x', init)
    expect(seen[0]).toBe(init)
  })
})

describe('the stdio transport', () => {
  test('pipes the child\'s stderr to the client instead of the terminal', async () => {
    const config = { type: 'stdio', command: process.execPath, args: ['-e', ''], scope: 'user' } as ScopedMcpServerConfig
    const { transport } = await createTransport('stderr-check', config)
    if (!(transport instanceof StdioClientTransport)) throw new Error('expected a stdio transport')
    expect(transport.stderr).not.toBeNull()
  })
})

describe('forgetting a server forgets its tool, resource and command lists', () => {
  useBuildMacro()
  const lists = [fetchToolsForClient, fetchResourcesForClient, fetchCommandsForClient] as const
  let serial = 0

  test('on clearServerCache, and when its connection closes', async () => {
    const stdio = writeStdioServer(store.root(), 'lists-stdio.log')
    try {
      for (const ending of ['cleared', 'closed'] as const) {
        const name = `lists-${ending}-${++serial}-${process.pid}`
        const config = stdio.config()
        const record = await connectToServer(name, config)
        if (record.type !== 'connected') throw new Error(`not connected: ${record.type}`)
        for (const list of lists) await list(record)
        expect(lists.map(list => list.cache.has(name))).toEqual([true, true, true])
        if (ending === 'cleared') {
          await clearServerCache(name, config)
        } else {
          process.kill(stdio.pids().at(-1)!, 'SIGKILL')
          await until(() => connectToServer.cache.has(getServerCacheKey(name, config)), cached => !cached, 'the close')
          await clearServerCache(name, config)
        }
        expect({ ending, kept: lists.map(list => list.cache.has(name)) }).toEqual({ ending, kept: [false, false, false] })
      }
    } finally {
      for (const pid of stdio.pids()) if (isAlive(pid)) process.kill(pid, 'SIGKILL')
    }
  })
})

describe('env knobs that are not positive numbers', () => {
  test('fall back to the defaults', () => {
    const saved = { MCP_TIMEOUT: process.env.MCP_TIMEOUT, BATCH: process.env.MCP_SERVER_CONNECTION_BATCH_SIZE }
    try {
      process.env.MCP_TIMEOUT = '-5'
      process.env.MCP_SERVER_CONNECTION_BATCH_SIZE = '-1'
      expect([getConnectionTimeoutMs(), getMcpServerConnectionBatchSize()]).toEqual([30_000, 3])
    } finally {
      if (saved.MCP_TIMEOUT === undefined) delete process.env.MCP_TIMEOUT
      else process.env.MCP_TIMEOUT = saved.MCP_TIMEOUT
      if (saved.BATCH === undefined) delete process.env.MCP_SERVER_CONNECTION_BATCH_SIZE
      else process.env.MCP_SERVER_CONNECTION_BATCH_SIZE = saved.BATCH
    }
  })
})

describe('WebSocketTransport edges', () => {
  /** A socket double with the EventTarget API both real socket kinds share. */
  function fakeSocket(readyState: number) {
    const target = new EventTarget()
    const sent: string[] = []
    const socket = {
      readyState,
      sent,
      close: () => {},
      send: (data: string) => void sent.push(data),
      addEventListener: (type: string, listener: (event: unknown) => void) => target.addEventListener(type, listener),
      removeEventListener: (type: string, listener: (event: unknown) => void) => target.removeEventListener(type, listener),
      emit: (event: Event) => target.dispatchEvent(event),
    }
    return socket
  }

  test('binary frames are read as UTF-8 JSON-RPC', async () => {
    const socket = fakeSocket(1)
    const transport = new WebSocketTransport(socket)
    const received: unknown[] = []
    transport.onmessage = message => void received.push(message)
    await transport.start()
    const text = JSON.stringify({ jsonrpc: '2.0', id: 7, result: {} })
    socket.emit(new MessageEvent('message', { data: Buffer.from(text) }))
    socket.emit(new MessageEvent('message', { data: new TextEncoder().encode(text).buffer }))
    expect(received).toEqual([{ jsonrpc: '2.0', id: 7, result: {} }, { jsonrpc: '2.0', id: 7, result: {} }])
  })

  test('a socket that already closed makes start reject at once', async () => {
    // Raced against a timer: a start that waits for an open which never comes must fail, not hang.
    const outcome = await Promise.race([
      new WebSocketTransport(fakeSocket(3)).start().then(() => 'started', (error: Error) => error.message),
      Bun.sleep(200).then(() => 'still waiting'),
    ])
    expect(outcome).toBe('WebSocket is closed. Cannot start.')
  })

  test('a socket error before opening rejects start and reaches onerror', async () => {
    const socket = fakeSocket(0)
    const transport = new WebSocketTransport(socket)
    const errors: Error[] = []
    transport.onerror = error => void errors.push(error)
    const starting = transport.start()
    socket.emit(Object.assign(new Event('error'), { message: 'handshake refused' }))
    await expect(starting).rejects.toThrow('handshake refused')
    expect(errors.map(e => e.message)).toEqual(['handshake refused'])
  })

  test('close() fires onclose itself, even when the socket never reports closing', async () => {
    const transport = new WebSocketTransport(fakeSocket(1))
    let closes = 0
    transport.onclose = () => void (closes += 1)
    await transport.start()
    await transport.close()
    expect(closes).toBe(1)
  })

  test('a socket without addEventListener is refused', () => {
    expect(() => new WebSocketTransport({ readyState: 1, close: () => {}, send: () => {} })).toThrow(TypeError)
  })
})
