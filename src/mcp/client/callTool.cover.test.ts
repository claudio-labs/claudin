// Characterization of callMCPTool and its URL-elicitation (-32042) retry loop:
// what a tool call returns, the progress it forwards, the errors it maps, and
// what the retry loop queues for the dialog — over a real SDK Client/Server
// pair where the protocol matters, an injected call function where it doesn't.
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from '@modelcontextprotocol/client'
// The fixture server stays on the 1.x SDK: a realistic legacy server.
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'

import {
  callMCPTool,
  callMCPToolWithUrlElicitationRetry,
  extractToolUseId,
} from 'src/mcp/client/callTool.js'
import { connectToServer, getServerCacheKey } from 'src/mcp/client/connection.js'
import {
  McpAuthError,
  McpSessionExpiredError,
  McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/mcp/client/errors.js'
import type { ConnectedMCPServer, MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import type { AssistantMessage } from 'src/shared/types/message.js'
import type { MCPProgress } from 'src/tools/MCPTool/MCPTool.js'
import {
  appStateBox,
  connectedServer,
  linkedPair,
  useElicitationHooks,
  waitUntil,
} from 'src/mcp/__testutils__/elicitationHarness.js'

const hooks = useElicitationHooks()

type CallHandler = Parameters<Server['setRequestHandler']>[1]

const pairs: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
  for (const p of pairs.splice(0)) await p.close()
})

async function serverWith(handler: CallHandler, name = 'fixture'): Promise<ConnectedMCPServer> {
  const pair = await linkedPair({
    setupServer: s => s.setRequestHandler(CallToolRequestSchema, handler as never),
  })
  pairs.push(pair)
  return connectedServer(pair.client, name)
}

/** A connected server whose client.callTool is the given function. */
function fakeServer(
  callTool: () => Promise<unknown>,
  config: ScopedMcpServerConfig = { scope: 'user', type: 'stdio', command: 'x', args: [] } as ScopedMcpServerConfig,
  name = 'fake',
): ConnectedMCPServer {
  return {
    type: 'connected',
    name,
    capabilities: { tools: {} },
    config,
    cleanup: async () => {},
    client: { callTool } as never,
  }
}

const signal = () => new AbortController().signal

/** What the Streamable HTTP transport throws for a non-OK POST. */
const httpError = (status: number, body: string) =>
  new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, `Error POSTing to endpoint: ${body}`, {
    status,
    text: body,
  })

describe('callMCPTool — results', () => {
  test('returns the processed content, structuredContent and _meta, and sends args and meta', async () => {
    let seen: Record<string, unknown> | undefined
    const client = await serverWith(async request => {
      seen = request.params as Record<string, unknown>
      return {
        content: [{ type: 'text', text: 'hello' }],
        structuredContent: { answer: 42 },
        _meta: { trace: 't-1' },
      }
    })
    const result = await callMCPTool({
      client,
      tool: 'greet',
      args: { who: 'world' },
      meta: { 'claudecode/toolUseId': 'tu-1' },
      signal: signal(),
    })
    // With structuredContent present, the model-facing content is its JSON.
    expect(result.content).toBe('{"answer":42}')
    expect(result.structuredContent).toEqual({ answer: 42 })
    expect(result._meta).toEqual({ trace: 't-1' })
    expect(seen).toMatchObject({
      name: 'greet',
      arguments: { who: 'world' },
      _meta: { 'claudecode/toolUseId': 'tu-1' },
    })
  })

  test('forwards server progress as mcp_progress events tagged with server and tool', async () => {
    const client = await serverWith(async (request, extra) => {
      const token = (request.params as { _meta?: { progressToken?: string | number } })._meta?.progressToken
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token!, progress: 1, total: 4, message: 'a quarter' },
      })
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token!, progress: 2 },
      })
      return { content: [{ type: 'text', text: 'done' }] }
    }, 'prog')
    const events: MCPProgress[] = []
    await callMCPTool({ client, tool: 'slow', args: {}, signal: signal(), onProgress: e => events.push(e) })
    expect(events).toEqual([
      {
        type: 'mcp_progress',
        status: 'progress',
        serverName: 'prog',
        toolName: 'slow',
        progress: 1,
        total: 4,
        progressMessage: 'a quarter',
      },
      {
        type: 'mcp_progress',
        status: 'progress',
        serverName: 'prog',
        toolName: 'slow',
        progress: 2,
        total: undefined,
        progressMessage: undefined,
      },
    ])
  })

  test('without onProgress no progress token is requested', async () => {
    let meta: unknown = 'unset'
    const client = await serverWith(async request => {
      meta = (request.params as { _meta?: unknown })._meta
      return { content: [] }
    })
    await callMCPTool({ client, tool: 't', args: {}, signal: signal() })
    expect(meta).toBeUndefined()
  })

  test('arms a 30 s still-running logger and clears it when the call ends', async () => {
    const setSpy = spyOn(globalThis, 'setInterval')
    const clearSpy = spyOn(globalThis, 'clearInterval')
    try {
      const client = fakeServer(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
      await callMCPTool({ client, tool: 't', args: {}, signal: signal() })
      const call = setSpy.mock.calls.find(c => c[1] === 30000)
      expect(call).toBeDefined()
      const handle = setSpy.mock.results[setSpy.mock.calls.indexOf(call!)]!.value
      expect(clearSpy.mock.calls.some(c => c[0] === handle)).toBe(true)
      // The tick itself only logs; running it must not throw.
      const [tick, , ...tickArgs] = call! as unknown as [(...a: unknown[]) => void, number, ...unknown[]]
      expect(() => tick(...tickArgs)).not.toThrow()
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
    }
  })

  test('text-only content comes back as the content blocks, with no structuredContent', async () => {
    const client = await serverWith(async () => ({ content: [{ type: 'text', text: 'plain' }] }))
    const result = await callMCPTool({ client, tool: 't', args: {}, signal: signal() })
    expect(result).toEqual({
      content: [{ type: 'text', text: 'plain' }],
      _meta: undefined,
      structuredContent: undefined,
    })
  })

  test('aborting a real call rejects with the SDK REQUEST_TIMEOUT error (not an AbortError)', async () => {
    const controller = new AbortController()
    const client = await serverWith(
      (_request, extra) =>
        new Promise(resolve => extra.signal.addEventListener('abort', () => resolve({ content: [] }))),
    )
    const pending = callMCPTool({ client, tool: 'hang', args: {}, signal: controller.signal })
    setTimeout(() => controller.abort(), 5)
    const error = await pending.catch(e => e)
    expect(error).toBeInstanceOf(SdkError)
    expect(error.code).toBe(SdkErrorCode.RequestTimeout)
    expect(error.message).toContain('AbortError')
  })

  test('an AbortError rejection resolves with undefined content instead of throwing', async () => {
    const client = fakeServer(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError')
    })
    expect(await callMCPTool({ client, tool: 't', args: {}, signal: signal() })).toEqual({
      content: undefined,
    })
  })
})

describe('callMCPTool — isError results', () => {
  test('throws McpToolCallError with the first text block and carries _meta', async () => {
    const client = await serverWith(async () => ({
      isError: true,
      content: [{ type: 'text', text: 'boom: bad input' }, { type: 'text', text: 'second' }],
      _meta: { requestId: 'r-9' },
    }))
    const error = await callMCPTool({ client, tool: 'fail', args: {}, signal: signal() }).catch(e => e)
    expect(error).toBeInstanceOf(McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    expect(error.name).toBe('McpToolCallError')
    expect(error.message).toBe('boom: bad input')
    expect(error.telemetryMessage).toBe('MCP tool [fixture] fail: boom: bad input')
    expect(error.mcpMeta).toEqual({ _meta: { requestId: 'r-9' } })
  })

  test('an isError result with no content and no _meta is "Unknown error" without meta', async () => {
    const client = await serverWith(async () => ({ isError: true, content: [] }))
    const error = await callMCPTool({ client, tool: 'fail', args: {}, signal: signal() }).catch(e => e)
    expect(error.message).toBe('Unknown error')
    expect(error.mcpMeta).toBeUndefined()
  })

  test('a first block without text is still "Unknown error"', async () => {
    const client = await serverWith(async () => ({
      isError: true,
      content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
    }))
    const error = await callMCPTool({ client, tool: 'fail', args: {}, signal: signal() }).catch(e => e)
    expect(error.message).toBe('Unknown error')
  })

  test('the legacy `error` field is used when content is empty', async () => {
    const client = fakeServer(async () => ({ isError: true, content: [], error: 'legacy failure' }))
    const error = await callMCPTool({ client, tool: 'fail', args: {}, signal: signal() }).catch(e => e)
    expect(error.message).toBe('legacy failure')
  })
})

describe('callMCPTool — protocol and transport errors', () => {
  test('a JSON-RPC error from the server is rethrown as the SDK ProtocolError', async () => {
    const client = await serverWith(async () => {
      throw new McpError(ProtocolErrorCode.InvalidParams, 'nope')
    })
    const error = await callMCPTool({ client, tool: 't', args: {}, signal: signal() }).catch(e => e)
    expect(error).toBeInstanceOf(ProtocolError)
    expect(error.code).toBe(ProtocolErrorCode.InvalidParams)
    expect(error.message).toContain('nope')
  })

  test('an HTTP 401 becomes McpAuthError for the server', async () => {
    const client = fakeServer(async () => {
      throw httpError(401, 'Unauthorized')
    }, undefined, 'authy')
    const error = await callMCPTool({ client, tool: 't', args: {}, signal: signal() }).catch(e => e)
    expect(error).toBeInstanceOf(McpAuthError)
    expect(error.serverName).toBe('authy')
    expect(error.message).toBe('MCP server "authy" requires re-authorization (token expired)')
  })

  test('the SDK UnauthorizedError also becomes McpAuthError', async () => {
    const client = fakeServer(async () => {
      throw new UnauthorizedError('expired')
    })
    await expect(callMCPTool({ client, tool: 't', args: {}, signal: signal() })).rejects.toBeInstanceOf(
      McpAuthError,
    )
  })

  const HTTP: ScopedMcpServerConfig = { scope: 'user', type: 'http', url: 'http://127.0.0.1:9/mcp' } as ScopedMcpServerConfig

  /** Seeds the connection cache so clearServerCache closes a fake instead of connecting. */
  function seedConnection(name: string, config: ScopedMcpServerConfig) {
    let cleaned = 0
    const key = getServerCacheKey(name, config)
    connectToServer.cache.set(
      key,
      Promise.resolve({
        type: 'connected',
        cleanup: async () => {
          cleaned++
        },
      }) as never,
    )
    return { cleaned: () => cleaned, cached: () => connectToServer.cache.has(key) }
  }

  test('a 404 carrying JSON-RPC -32001 clears the cached connection and throws McpSessionExpiredError', async () => {
    const seeded = seedConnection('sess', HTTP)
    const client = fakeServer(async () => {
      throw httpError(404, '{"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"}}')
    }, HTTP, 'sess')
    const error = await callMCPTool({ client, tool: 't', args: {}, signal: signal() }).catch(e => e)
    expect(error).toBeInstanceOf(McpSessionExpiredError)
    expect(error.message).toBe('MCP server "sess" session expired')
    expect(seeded.cleaned()).toBe(1)
    expect(seeded.cached()).toBe(false)
  })

  test('a plain 404 is not a session expiry', async () => {
    const original = httpError(404, 'Not Found')
    const client = fakeServer(async () => {
      throw original
    }, HTTP)
    await expect(callMCPTool({ client, tool: 't', args: {}, signal: signal() })).rejects.toBe(original)
  })

  test('"Connection closed" on HTTP is treated as an expired session', async () => {
    const seeded = seedConnection('closed', HTTP)
    const client = fakeServer(async () => {
      throw new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed')
    }, HTTP, 'closed')
    await expect(callMCPTool({ client, tool: 't', args: {}, signal: signal() })).rejects.toBeInstanceOf(
      McpSessionExpiredError,
    )
    expect(seeded.cleaned()).toBe(1)
  })

  test('"Connection closed" on stdio is rethrown as is', async () => {
    const original = new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed')
    const client = fakeServer(async () => {
      throw original
    })
    await expect(callMCPTool({ client, tool: 't', args: {}, signal: signal() })).rejects.toBe(original)
  })

  test('a non-Error rejection is rethrown untouched', async () => {
    const client = fakeServer(async () => {
      throw 'just a string'
    })
    await expect(callMCPTool({ client, tool: 't', args: {}, signal: signal() })).rejects.toBe('just a string')
  })
})

describe('extractToolUseId', () => {
  test('returns the id of a leading tool_use block, else undefined', () => {
    const msg = (content: unknown[]) => ({ message: { content } }) as unknown as AssistantMessage
    expect(extractToolUseId(msg([{ type: 'tool_use', id: 'toolu_1', name: 'x', input: {} }]))).toBe('toolu_1')
    expect(extractToolUseId(msg([{ type: 'text', text: 'hi' }]))).toBeUndefined()
    expect(extractToolUseId(msg([]))).toBeUndefined()
  })
})

// ── URL elicitation retry ─────────────────────────────────────────────────

const ELICIT = { mode: 'url', message: 'Sign in', url: 'https://auth.example/a', elicitationId: 'e-1' }
const urlRequired = (elicitations: unknown[] = [ELICIT]) =>
  new ProtocolError(ProtocolErrorCode.UrlElicitationRequired, 'URL elicitation required', { elicitations })

const conn = (name = 'retry'): MCPServerConnection =>
  ({ type: 'connected', name }) as unknown as MCPServerConnection

/** A call function that throws the given errors in order, then succeeds. */
function scripted(...errors: unknown[]) {
  const calls: Array<{ tool: string; args: Record<string, unknown>; meta?: Record<string, unknown> }> = []
  const fn = async (opts: { tool: string; args: Record<string, unknown>; meta?: Record<string, unknown> }) => {
    calls.push({ tool: opts.tool, args: opts.args, meta: opts.meta })
    const next = errors[calls.length - 1]
    if (next) throw next
    return { content: 'ok' as const }
  }
  return { fn, calls }
}

function retry(
  overrides: Partial<Parameters<typeof callMCPToolWithUrlElicitationRetry>[0]> = {},
) {
  const box = appStateBox()
  const promise = callMCPToolWithUrlElicitationRetry({
    client: fakeServer(async () => ({ content: [] })),
    clientConnection: conn(),
    tool: 'needs_url',
    args: { a: 1 },
    signal: signal(),
    setAppState: box.set,
    ...overrides,
  })
  return { box, promise }
}

describe('callMCPToolWithUrlElicitationRetry — print/SDK handler', () => {
  test('a -32042 is shown through handleElicitation and the call is retried on accept', async () => {
    const { fn, calls } = scripted(urlRequired())
    const seen: unknown[] = []
    const { box, promise } = retry({
      callToolFn: fn as never,
      meta: { m: 1 },
      handleElicitation: async (serverName, params) => {
        seen.push({ serverName, params })
        return { action: 'accept' }
      },
    })
    expect(await promise).toEqual({ content: 'ok' })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual({ tool: 'needs_url', args: { a: 1 }, meta: { m: 1 } })
    expect(seen).toEqual([{ serverName: 'retry', params: ELICIT }])
    expect(box.queue()).toHaveLength(0)
    const post = hooks.inputs.find(i => i.hook_event_name === 'ElicitationResult') as Record<string, unknown>
    expect(post).toMatchObject({ mode: 'url', elicitation_id: 'e-1', action: 'accept', mcp_server_name: 'retry' })
  })

  test('a decline returns an explanation as the tool content instead of retrying', async () => {
    const { fn, calls } = scripted(urlRequired())
    const { promise } = retry({ callToolFn: fn as never, handleElicitation: async () => ({ action: 'decline' }) })
    expect(await promise).toEqual({
      content:
        'URL elicitation was declined by the user. The tool "needs_url" could not complete because it requires the user to open a URL.',
    })
    expect(calls).toHaveLength(1)
  })

  test('a cancel is reported as "canceled"', async () => {
    const { fn } = scripted(urlRequired())
    const { promise } = retry({ callToolFn: fn as never, handleElicitation: async () => ({ action: 'cancel' }) })
    expect((await promise).content).toStartWith('URL elicitation was canceled by the user.')
  })

  test('every valid elicitation in the error is handled, in order; malformed ones are skipped', async () => {
    const second = { ...ELICIT, elicitationId: 'e-2', url: 'https://auth.example/b' }
    const { fn } = scripted(
      urlRequired([ELICIT, null, 'str', { ...ELICIT, mode: 'form' }, { ...ELICIT, url: 7 }, { mode: 'url' }, second]),
    )
    const ids: string[] = []
    const { promise } = retry({
      callToolFn: fn as never,
      handleElicitation: async (_s, params) => {
        ids.push(params.elicitationId)
        return { action: 'accept' }
      },
    })
    await promise
    expect(ids).toEqual(['e-1', 'e-2'])
  })

  test('gives up after three retries and rethrows the -32042', async () => {
    const last = urlRequired()
    const { fn, calls } = scripted(urlRequired(), urlRequired(), urlRequired(), last)
    const { promise } = retry({ callToolFn: fn as never, handleElicitation: async () => ({ action: 'accept' }) })
    await expect(promise).rejects.toBe(last)
    expect(calls).toHaveLength(4)
  })

  test('a -32042 with no valid elicitation data is rethrown', async () => {
    for (const data of [undefined, { elicitations: 'nope' }, { elicitations: [{ mode: 'url' }] }]) {
      const error = new ProtocolError(ProtocolErrorCode.UrlElicitationRequired, 'x', data)
      const { fn } = scripted(error)
      const handle = async () => ({ action: 'accept' as const })
      const { promise } = retry({ callToolFn: fn as never, handleElicitation: handle })
      await expect(promise).rejects.toBe(error)
    }
  })

  test('other errors pass straight through', async () => {
    const other = new ProtocolError(ProtocolErrorCode.InternalError, 'down')
    const plain = new Error('plain')
    for (const error of [other, plain]) {
      const { fn, calls } = scripted(error)
      const { promise } = retry({ callToolFn: fn as never })
      await expect(promise).rejects.toBe(error)
      expect(calls).toHaveLength(1)
    }
  })

  test('an already-aborted signal throws before calling the tool', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fn, calls } = scripted()
    const { promise } = retry({ callToolFn: fn as never, signal: controller.signal })
    await expect(promise).rejects.toThrow('Tool call aborted during URL elicitation')
    expect(calls).toHaveLength(0)
  })

  test('a disconnected connection reports the server as "unknown"', async () => {
    const { fn } = scripted(urlRequired())
    const names: string[] = []
    const { promise } = retry({
      callToolFn: fn as never,
      clientConnection: { type: 'failed', name: 'gone' } as unknown as MCPServerConnection,
      handleElicitation: async serverName => {
        names.push(serverName)
        return { action: 'accept' }
      },
    })
    await promise
    expect(names).toEqual(['unknown'])
  })
})

describe('callMCPToolWithUrlElicitationRetry — hooks', () => {
  test('an Elicitation hook that accepts skips the UI and retries', async () => {
    hooks.answer('Elicitation', { hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept' } })
    const { fn, calls } = scripted(urlRequired())
    let asked = false
    const { box, promise } = retry({
      callToolFn: fn as never,
      handleElicitation: async () => {
        asked = true
        return { action: 'decline' }
      },
    })
    expect(await promise).toEqual({ content: 'ok' })
    expect(asked).toBe(false)
    expect(calls).toHaveLength(2)
    expect(box.queue()).toHaveLength(0)
  })

  test('an Elicitation hook that declines ends the call with a hook explanation', async () => {
    hooks.answer('Elicitation', { hookSpecificOutput: { hookEventName: 'Elicitation', action: 'decline' } })
    const { fn, calls } = scripted(urlRequired())
    const { promise } = retry({ callToolFn: fn as never })
    expect(await promise).toEqual({
      content:
        'URL elicitation was declined by a hook. The tool "needs_url" could not complete because it requires the user to open a URL.',
    })
    expect(calls).toHaveLength(1)
  })

  test('an Elicitation hook that cancels is reported as "canceled by a hook"', async () => {
    hooks.answer('Elicitation', { hookSpecificOutput: { hookEventName: 'Elicitation', action: 'cancel' } })
    const { fn } = scripted(urlRequired())
    const { promise } = retry({ callToolFn: fn as never })
    expect((await promise).content).toStartWith('URL elicitation was canceled by a hook.')
  })

  test('an ElicitationResult hook can turn the user accept into a decline', async () => {
    hooks.answer('ElicitationResult', { decision: 'block', reason: 'policy' })
    const { fn, calls } = scripted(urlRequired())
    const { promise } = retry({ callToolFn: fn as never, handleElicitation: async () => ({ action: 'accept' }) })
    expect((await promise).content).toStartWith('URL elicitation was declined by the user.')
    expect(calls).toHaveLength(1)
  })
})

describe('callMCPToolWithUrlElicitationRetry — REPL queue', () => {
  test('queues a two-phase event; accept is a no-op and "retry" in the waiting phase retries', async () => {
    const { fn, calls } = scripted(urlRequired())
    const controller = new AbortController()
    const { box, promise } = retry({ callToolFn: fn as never, signal: controller.signal })
    await waitUntil(() => box.queue().length === 1, 'queued URL elicitation')

    const event = box.queue()[0]!
    expect(event.serverName).toBe('retry')
    expect(event.requestId).toBe('error-elicit-e-1')
    expect(event.params).toEqual(ELICIT as never)
    expect(event.signal).toBe(controller.signal)
    expect(event.waitingState).toEqual({ actionLabel: 'Retry now', showCancel: true })

    event.respond({ action: 'accept' })
    await new Promise(r => setTimeout(r, 10))
    expect(calls).toHaveLength(1)

    event.onWaitingDismiss!('retry')
    expect(await promise).toEqual({ content: 'ok' })
    expect(calls).toHaveLength(2)
  })

  test('dismissing the waiting phase without retry cancels', async () => {
    const { fn } = scripted(urlRequired())
    const { box, promise } = retry({ callToolFn: fn as never })
    await waitUntil(() => box.queue().length === 1)
    box.queue()[0]!.onWaitingDismiss!('dismiss')
    expect((await promise).content).toStartWith('URL elicitation was canceled by the user.')
  })

  test('declining in the consent phase resolves with the decline', async () => {
    const { fn } = scripted(urlRequired())
    const { box, promise } = retry({ callToolFn: fn as never })
    await waitUntil(() => box.queue().length === 1)
    box.queue()[0]!.respond({ action: 'decline' })
    expect((await promise).content).toStartWith('URL elicitation was declined by the user.')
  })

  test('aborting while the dialog is open cancels instead of hanging', async () => {
    const { fn, calls } = scripted(urlRequired())
    const controller = new AbortController()
    const { box, promise } = retry({ callToolFn: fn as never, signal: controller.signal })
    await waitUntil(() => box.queue().length === 1)
    controller.abort()
    expect((await promise).content).toStartWith('URL elicitation was canceled by the user.')
    expect(calls).toHaveLength(1)
  })

  test('a signal aborted during the hooks resolves cancel without queueing', async () => {
    const { fn } = scripted(urlRequired())
    const controller = new AbortController()
    const { box, promise } = retry({
      callToolFn: (async (opts: Parameters<typeof fn>[0]) => {
        try {
          return await fn(opts)
        } finally {
          controller.abort()
        }
      }) as never,
      signal: controller.signal,
    })
    expect((await promise).content).toStartWith('URL elicitation was canceled by the user.')
    expect(box.queue()).toHaveLength(0)
  })
})

describe('callMCPToolWithUrlElicitationRetry — real round trip', () => {
  test('a server -32042 then success, through the default callMCPTool', async () => {
    let attempts = 0
    const client = await serverWith(async () => {
      attempts++
      if (attempts === 1) throw urlRequired()
      return { content: [{ type: 'text', text: 'after sign-in' }] }
    }, 'rt')
    const box = appStateBox()
    const result = await callMCPToolWithUrlElicitationRetry({
      client,
      clientConnection: client,
      tool: 'needs_url',
      args: {},
      signal: signal(),
      setAppState: box.set,
      handleElicitation: async (serverName, params) => {
        expect(serverName).toBe('rt')
        expect(params).toEqual(ELICIT as never)
        return { action: 'accept' }
      },
    })
    expect(attempts).toBe(2)
    expect(result.content).toEqual([{ type: 'text', text: 'after sign-in' }])
  })
})
