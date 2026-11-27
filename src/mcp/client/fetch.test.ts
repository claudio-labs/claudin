import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import {
  createClaudeAiProxyFetch,
  getMcpServerConnectionBatchSize,
  getRemoteMcpServerConnectionBatchSize,
  MCP_REQUEST_TIMEOUT_MS,
  requestTimeoutMs,
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

  test('a tools/call answered after 60 s is not cut while the tool timeout allows it', async () => {
    jest.useFakeTimers()
    try {
      const { fetchLike } = recordingFetch(
        ({ init }) =>
          new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(() => resolve(new Response('{}')), 61_000)
            init!.signal!.addEventListener('abort', () => {
              clearTimeout(timer)
              reject(init!.signal!.reason)
            })
          }),
      )
      const pending = wrapFetchWithTimeout(fetchLike)('http://srv/mcp', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'slow' } }),
      })
      let outcome = 'pending'
      pending.then(
        () => (outcome = 'answered'),
        error => (outcome = (error as Error).name),
      )
      jest.advanceTimersByTime(61_000)
      await Promise.resolve()
      await Promise.resolve()
      expect(outcome).toBe('answered')
    } finally {
      jest.useRealTimers()
    }
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
