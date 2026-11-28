import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  createClaudeAiProxyFetch,
  eventNameOfBody,
  getMcpServerConnectionBatchSize,
  getRemoteMcpServerConnectionBatchSize,
  MCP_REQUEST_TIMEOUT_MS,
  requestTimeoutMs,
  wrapFetchWithEventName,
  wrapFetchWithTimeout,
} from 'src/mcp/client/fetch.js'
import { clearOAuthTokenCache } from 'src/providers/auth/auth.js'
import { _setSecureStorageForTesting } from 'src/platform/secureStorage/index.js'

type Seen = { url: string; init?: RequestInit }

// Every env var fetch.ts (or the claude.ai token lookup behind it) reads,
// cleared per test so the developer's shell cannot leak a value in.
const ENV_KEYS = [
  'MCP_TOOL_TIMEOUT',
  'MCP_SERVER_CONNECTION_BATCH_SIZE',
  'MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDIN_SIMPLE',
] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  // No claude.ai login of the developer's own may answer the token lookup.
  _setSecureStorageForTesting({
    name: 'memory',
    read: () => ({}),
    readAsync: async () => ({}),
    update: () => ({ success: true }),
    delete: () => true,
  })
  clearOAuthTokenCache()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  _setSecureStorageForTesting(null)
  clearOAuthTokenCache()
})

function recordingFetch(respond: (seen: Seen) => Response | Promise<Response> = () => new Response('ok')) {
  const seen: Seen[] = []
  const fetchLike = async (url: string | URL, init?: RequestInit) => {
    const entry = { url: String(url), init }
    seen.push(entry)
    return respond(entry)
  }
  return { seen, fetchLike }
}

describe('requestTimeoutMs', () => {
  const toolsCall = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't' } })

  test('a POST that is not a tool call gets 60 s', () => {
    expect(MCP_REQUEST_TIMEOUT_MS).toBe(60_000)
    expect(requestTimeoutMs({ body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).toBe(60_000)
    expect(requestTimeoutMs(undefined)).toBe(60_000)
    expect(requestTimeoutMs({ body: new URLSearchParams('method=tools/call') })).toBe(60_000)
  })

  test('a tools/call gets the tool timeout it is handed', () => {
    expect(requestTimeoutMs({ body: toolsCall }, 900_000)).toBe(900_000)
    expect(requestTimeoutMs({ body: '{ "method" : "tools/call" }' }, 1234)).toBe(1234)
  })

  test('without one it uses MCP_TOOL_TIMEOUT, then the 5 min default', () => {
    expect(requestTimeoutMs({ body: toolsCall })).toBe(300_000)
    process.env.MCP_TOOL_TIMEOUT = '120000'
    expect(requestTimeoutMs({ body: toolsCall })).toBe(120_000)
  })
})

describe('connection batch sizes', () => {
  test('default to 3 local and 20 remote servers at a time', () => {
    expect(getMcpServerConnectionBatchSize()).toBe(3)
    expect(getRemoteMcpServerConnectionBatchSize()).toBe(20)
  })

  test('each env var overrides its own size', () => {
    process.env.MCP_SERVER_CONNECTION_BATCH_SIZE = '7'
    process.env.MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE = '40'
    expect(getMcpServerConnectionBatchSize()).toBe(7)
    expect(getRemoteMcpServerConnectionBatchSize()).toBe(40)
  })
})

describe('wrapFetchWithTimeout', () => {
  test('a GET (the long-lived event stream) passes through untouched', async () => {
    const { seen, fetchLike } = recordingFetch()
    const init = { method: 'GET', headers: { 'X-A': '1' } }
    await wrapFetchWithTimeout(fetchLike)('http://srv/mcp', init)
    expect(seen[0]!.init).toBe(init)
  })

  test('a request with no method counts as a GET', async () => {
    const { seen, fetchLike } = recordingFetch()
    await wrapFetchWithTimeout(fetchLike)('http://srv/mcp')
    expect(seen[0]!.init).toBeUndefined()
  })

  test('a POST gets the Streamable HTTP Accept value and its own signal', async () => {
    const { seen, fetchLike } = recordingFetch()
    await wrapFetchWithTimeout(fetchLike)('http://srv/mcp', {
      method: 'post',
      headers: { 'X-A': '1' },
      body: '{}',
    })
    const sent = seen[0]!.init!
    const headers = sent.headers as Headers
    expect(headers.get('accept')).toBe('application/json, text/event-stream')
    expect(headers.get('x-a')).toBe('1')
    expect(sent.body).toBe('{}')
    expect(sent.signal).toBeInstanceOf(AbortSignal)
    expect(sent.signal!.aborted).toBe(false)
  })

  test('a POST keeps an Accept it already has', async () => {
    const { seen, fetchLike } = recordingFetch()
    await wrapFetchWithTimeout(fetchLike)('http://srv/mcp', {
      method: 'POST',
      headers: new Headers({ Accept: 'application/json' }),
    })
    expect((seen[0]!.init!.headers as Headers).get('accept')).toBe('application/json')
  })

  test('aborting the caller signal aborts the request with its reason', async () => {
    const parent = new AbortController()
    const { seen, fetchLike } = recordingFetch(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))
        }),
    )
    const pending = wrapFetchWithTimeout(fetchLike)('http://srv/mcp', {
      method: 'POST',
      signal: parent.signal,
    })
    await Promise.resolve()
    parent.abort('user stopped')
    await expect(pending).rejects.toBe('user stopped')
    expect(seen[0]!.init!.signal!.aborted).toBe(true)
  })

  test('a caller signal that is already aborted aborts the request before it is sent', async () => {
    const parent = new AbortController()
    parent.abort('gone')
    const { seen, fetchLike } = recordingFetch()
    await wrapFetchWithTimeout(fetchLike)('http://srv/mcp', {
      method: 'POST',
      signal: parent.signal,
    })
    expect(seen[0]!.init!.signal!.aborted).toBe(true)
    expect(seen[0]!.init!.signal!.reason).toBe('gone')
  })

  // The cap each POST is armed with, read off setTimeout rather than waited
  // for: Bun's fake timers stall once fake time passes the machine's uptime.
  async function capFor(body: string, options?: { toolCallTimeoutMs?: number }): Promise<number | undefined> {
    const timers = spyOn(globalThis, 'setTimeout')
    try {
      const { fetchLike } = recordingFetch()
      await wrapFetchWithTimeout(fetchLike, options)('http://srv/mcp', { method: 'POST', body })
      return timers.mock.calls.map(call => call[1]).find(ms => typeof ms === 'number' && ms >= 60_000)
    } finally {
      timers.mockRestore()
    }
  }

  test('a tools/call POST is armed with the tool timeout, other POSTs with 60 s', async () => {
    const toolsCall = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'slow' } })
    expect(await capFor(toolsCall)).toBe(300_000)
    expect(await capFor(toolsCall, { toolCallTimeoutMs: 900_000 })).toBe(900_000)
    expect(await capFor(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }))).toBe(60_000)
  })

  test('a failing fetch rejects with its own error', async () => {
    const boom = new Error('connection reset')
    const fetchLike = async () => {
      throw boom
    }
    await expect(
      wrapFetchWithTimeout(fetchLike)('http://srv/mcp', { method: 'POST' }),
    ).rejects.toBe(boom)
  })

  // On 2026-07-28 the abort of a request's stream is its cancellation; it
  // used to be dropped once the headers were in.
  function sseFetch() {
    let sent: RequestInit | undefined
    let cancelled = false
    const fetchLike = async (_url: string | URL, init?: RequestInit) => {
      sent = init
      let push!: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          push = c
        },
        cancel() {
          cancelled = true
        },
      })
      init!.signal!.addEventListener('abort', () => push.error(init!.signal!.reason))
      queueMicrotask(() => push.enqueue(new TextEncoder().encode('data: 1\n\n')))
      return new Response(body, { status: 200, statusText: 'OK', headers: { 'content-type': 'text/event-stream' } })
    }
    return { fetchLike, signal: () => sent!.signal!, cancelled: () => cancelled }
  }

  test('an SSE answer stays tied to the caller signal until its body ends', async () => {
    const parent = new AbortController()
    const sse = sseFetch()
    const response = await wrapFetchWithTimeout(sse.fetchLike)('http://srv/mcp', { method: 'POST', body: '{}', signal: parent.signal })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 1\n\n')
    parent.abort('stream closed')
    expect(sse.signal().aborted).toBe(true)
    await expect(reader.read()).rejects.toBe('stream closed')
  })

  test('an SSE body that ends or is cancelled lets the caller signal go', async () => {
    const parent = new AbortController()
    const done = await wrapFetchWithTimeout(async () => new Response('data: 1\n\n', { headers: { 'content-type': 'text/event-stream' } }))(
      'http://srv/mcp',
      { method: 'POST', signal: parent.signal },
    )
    expect(await done.text()).toBe('data: 1\n\n')

    const sse = sseFetch()
    const cancelled = await wrapFetchWithTimeout(sse.fetchLike)('http://srv/mcp', { method: 'POST', signal: parent.signal })
    await cancelled.body!.cancel('not needed')
    expect(sse.cancelled()).toBe(true)
    parent.abort()
    expect(sse.signal().aborted).toBe(false)
  })

  test('a JSON answer, or one without a caller signal, is released at the headers', async () => {
    const parent = new AbortController()
    const { seen, fetchLike } = recordingFetch(() => new Response('{}', { headers: { 'content-type': 'application/json' } }))
    await wrapFetchWithTimeout(fetchLike)('http://srv/mcp', { method: 'POST', signal: parent.signal })
    parent.abort()
    expect(seen[0]!.init!.signal!.aborted).toBe(false)
    const sse = sseFetch()
    const unsignalled = await wrapFetchWithTimeout(sse.fetchLike)('http://srv/mcp', { method: 'POST' })
    expect(unsignalled.body).toBeInstanceOf(ReadableStream)
  })
})

describe('wrapFetchWithEventName', () => {
  const body = (message: unknown) => JSON.stringify(message)

  test('names the event of an events/* POST, and nothing else', () => {
    expect(eventNameOfBody(body({ jsonrpc: '2.0', id: 1, method: 'events/stream', params: { name: 'build' } }))).toBe('build')
    expect(eventNameOfBody(body({ method: 'events/poll', params: { name: 'deploy', cursor: null } }))).toBe('deploy')
    expect(eventNameOfBody(body({ method: 'events/list', params: {} }))).toBeUndefined()
    expect(eventNameOfBody(body({ method: 'tools/call', params: { name: 'events/x' } }))).toBeUndefined()
    expect(eventNameOfBody(body({ result: { method: 'events/x' }, method: 'x' }))).toBeUndefined()
    expect(eventNameOfBody(body([{ method: 'events/stream', params: { name: 'build' } }]))).toBeUndefined()
    expect(eventNameOfBody('"method": "events/stream" {not json')).toBeUndefined()
    expect(eventNameOfBody(undefined)).toBeUndefined()
  })

  test('sets Mcp-Name on an events POST and keeps the other headers', async () => {
    const { seen, fetchLike } = recordingFetch()
    const wrapped = wrapFetchWithEventName(fetchLike)
    const init = { method: 'POST', headers: { 'X-A': '1' }, body: body({ method: 'events/stream', params: { name: 'build' } }) }
    await wrapped('http://srv/mcp', init)
    const headers = seen[0]!.init!.headers as Headers
    expect(headers.get('mcp-name')).toBe('build')
    expect(headers.get('x-a')).toBe('1')
    const other = { method: 'POST', body: body({ method: 'tools/list' }) }
    await wrapped('http://srv/mcp', other)
    expect(seen[1]!.init).toBe(other)
  })
})

describe('createClaudeAiProxyFetch', () => {
  test('without a claude.ai token it refuses to send', async () => {
    const { seen, fetchLike } = recordingFetch()
    await expect(createClaudeAiProxyFetch(fetchLike)('http://proxy/mcp', {})).rejects.toThrow(
      'No claude.ai OAuth token available',
    )
    expect(seen).toHaveLength(0)
  })

  test('sends the claude.ai token as the bearer and keeps the other headers', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-1'
    const { seen, fetchLike } = recordingFetch()
    const response = await createClaudeAiProxyFetch(fetchLike)('http://proxy/mcp', {
      method: 'POST',
      headers: { 'X-A': '1' },
    })
    expect(response.status).toBe(200)
    const headers = seen[0]!.init!.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer tok-1')
    expect(headers.get('x-a')).toBe('1')
  })

  test('a 401 with no newer token is returned as is, without a second request', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-1'
    const { seen, fetchLike } = recordingFetch(() => new Response('no', { status: 401 }))
    const response = await createClaudeAiProxyFetch(fetchLike)('http://proxy/mcp', {})
    expect(response.status).toBe(401)
    expect(seen).toHaveLength(1)
  })

  test('a 401 after another connector stored a newer token retries once with it', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-1'
    const { seen, fetchLike } = recordingFetch(() => {
      if (seen.length === 1) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-2'
        return new Response('no', { status: 401 })
      }
      return new Response('ok')
    })
    const response = await createClaudeAiProxyFetch(fetchLike)('http://proxy/mcp', {})
    expect(response.status).toBe(200)
    expect(seen.map(s => (s.init!.headers as Headers).get('authorization'))).toEqual([
      'Bearer tok-1',
      'Bearer tok-2',
    ])
  })

  test('when the retry itself fails the original 401 comes back', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-1'
    const { seen, fetchLike } = recordingFetch(() => {
      if (seen.length === 1) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-2'
        return new Response('no', { status: 401 })
      }
      throw new Error('network down')
    })
    const response = await createClaudeAiProxyFetch(fetchLike)('http://proxy/mcp', {})
    expect(response.status).toBe(401)
    expect(seen).toHaveLength(2)
  })
})
