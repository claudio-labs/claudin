/**
 * Characterization of an MCP tool call, pinned before the clean-base rewrite
 * (src/mcp/client/callTool.ts, errors.ts): what is sent, what comes back,
 * how each failure surfaces (tool error, timeout, abort, 401, expired
 * session), and the URL-elicitation loop (-32042) through the SDK host's
 * handler, the REPL dialog queue and the Elicitation hooks.
 *
 * Each server is a real SDK server, over the in-memory transport or a
 * loopback Streamable HTTP port (see mcpServerBed). Hooks are real command
 * hooks read from settings.json in a temp CLAUDIN_CONFIG_DIR.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import {
  callMCPToolWithUrlElicitationRetry,
  clearServerCache,
  connectToServer,
  isMcpSessionExpiredError,
  McpAuthError,
  McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS as McpToolCallError,
} from 'src/mcp/client.js'
import { callMCPTool, DEFAULT_MCP_TOOL_TIMEOUT_MS, extractToolUseId } from 'src/mcp/client/callTool.js'
import { McpSessionExpiredError } from 'src/mcp/client/errors.js'
import {
  type BedTool,
  type InMemoryLink,
  linkInMemory,
  serveHttp,
  until,
  useBuildMacro,
} from 'src/mcp/client/__testutils__/mcpServerBed.js'
import type { ConnectedMCPServer, ScopedMcpServerConfig } from 'src/mcp/types.js'
import {
  getCwdState,
  getIsNonInteractiveSession,
  getOriginalCwd,
  setCwdState,
  setIsInteractive,
  setOriginalCwd,
} from 'src/platform/bootstrap/state.js'
import { resetHooksConfigSnapshot } from 'src/platform/lifecycleHooks/hooksConfigSnapshot.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS as TelemetrySafeError } from 'src/shared/errors.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

useBuildMacro()

const OWNED_ENV = ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_SIMPLE', 'CLAUDIN_ENV_FILE', 'MCP_TOOL_TIMEOUT'] as const
let savedEnv: Record<string, string | undefined> = {}
let savedPlace = { cwd: '', originalCwd: '', interactive: false }
let root = ''
const links: InMemoryLink[] = []
const stops: Array<() => unknown> = []
let serial = 0
const fresh = (stem: string) => `${stem}-${++serial}-${process.pid}`

beforeEach(() => {
  savedEnv = Object.fromEntries(OWNED_ENV.map(k => [k, process.env[k]]))
  savedPlace = { cwd: getCwdState(), originalCwd: getOriginalCwd(), interactive: !getIsNonInteractiveSession() }
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-calltool-char-')))
  mkdirSync(join(root, 'config'))
  mkdirSync(join(root, 'project'))
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
  delete process.env.CLAUDIN_SIMPLE
  delete process.env.CLAUDIN_ENV_FILE
  delete process.env.MCP_TOOL_TIMEOUT
  setOriginalCwd(join(root, 'project'))
  setCwdState(join(root, 'project'))
  // Hooks run without the workspace-trust prompt in a non-interactive session.
  setIsInteractive(false)
  resetSettingsCache()
  resetHooksConfigSnapshot()
})

afterEach(async () => {
  for (const link of links.splice(0)) await link.close()
  for (const stop of stops.splice(0)) await stop()
  for (const key of OWNED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setOriginalCwd(savedPlace.originalCwd)
  setCwdState(savedPlace.cwd)
  setIsInteractive(savedPlace.interactive)
  resetSettingsCache()
  resetHooksConfigSnapshot()
  rmSync(root, { recursive: true, force: true })
})

async function link(name: string, tools: BedTool[], config?: ScopedMcpServerConfig): Promise<InMemoryLink> {
  const made = await linkInMemory(name, { tools }, config)
  links.push(made)
  return made
}

type CallOptions = Partial<Parameters<typeof callMCPToolWithUrlElicitationRetry>[0]>

function call(connection: ConnectedMCPServer, tool: string, options: CallOptions = {}) {
  return callMCPToolWithUrlElicitationRetry({
    client: connection,
    clientConnection: connection,
    tool,
    args: {},
    signal: new AbortController().signal,
    setAppState: () => {
      throw new Error('no dialog expected')
    },
    ...options,
  })
}

const text = (t: string) => ({ content: [{ type: 'text', text: t }] })

// --- plain calls ---------------------------------------------------------------------------

describe('a tool call', () => {
  test('sends the name, the arguments and _meta, and returns content, _meta and structuredContent', async () => {
    const { connection, ledger } = await link(fresh('calc'), [
      { name: 'add', run: ({ args }) => ({ ...text(`sum ${Number(args.a) + Number(args.b)}`), _meta: { cost: 1 } }) },
      { name: 'shape', run: () => ({ content: [], structuredContent: { rows: [{ id: 1 }] } }) },
    ])
    expect(await call(connection, 'add', { args: { a: 2, b: 3 }, meta: { 'claudecode/toolUseId': 'toolu_1' } })).toEqual({
      content: [{ type: 'text', text: 'sum 5' }],
      _meta: { cost: 1 },
      structuredContent: undefined,
    })
    expect(ledger.calls[0]).toEqual({ name: 'add', args: { a: 2, b: 3 }, meta: { 'claudecode/toolUseId': 'toolu_1' } })
    expect(await call(connection, 'shape')).toEqual({
      content: '{"rows":[{"id":1}]}',
      _meta: undefined,
      structuredContent: { rows: [{ id: 1 }] },
    })
  })

  test('server progress is relayed as mcp_progress events', async () => {
    const name = fresh('slow')
    const { connection } = await link(name, [
      {
        name: 'crawl',
        run: async ({ progress }) => {
          await progress(1, 3, 'page 1')
          await progress(3)
          return text('done')
        },
      },
    ])
    const events: unknown[] = []
    await call(connection, 'crawl', { onProgress: p => void events.push(p) })
    expect(events).toEqual([
      { type: 'mcp_progress', status: 'progress', serverName: name, toolName: 'crawl', progress: 1, total: 3, progressMessage: 'page 1' },
      { type: 'mcp_progress', status: 'progress', serverName: name, toolName: 'crawl', progress: 3, total: undefined, progressMessage: undefined },
    ])
  })

  test('an isError result throws McpToolCallError with the first text block as its message', async () => {
    const name = fresh('picky')
    const { connection } = await link(name, [
      { name: 'quota', run: () => ({ isError: true, content: [{ type: 'text', text: 'quota exceeded' }, { type: 'text', text: 'ignored' }], _meta: { retryAfter: 30 } }) },
      { name: 'imagey', run: () => ({ isError: true, content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }) },
      { name: 'empty', run: () => ({ isError: true, content: [] }) },
      { name: 'legacy', run: () => ({ isError: true, content: [], error: 'old style failure' }) },
    ])
    const cases: Array<[string, string, unknown]> = [
      ['quota', 'quota exceeded', { _meta: { retryAfter: 30 } }],
      ['imagey', 'Unknown error', undefined],
      ['empty', 'Unknown error', undefined],
      ['legacy', 'old style failure', undefined],
    ]
    for (const [tool, message, mcpMeta] of cases) {
      const error = (await call(connection, tool).catch(e => e)) as McpToolCallError
      expect(error).toBeInstanceOf(McpToolCallError)
      expect(error).toBeInstanceOf(TelemetrySafeError)
      expect({ tool, name: error.name, message: error.message, mcpMeta: error.mcpMeta as unknown }).toEqual({ tool, name: 'McpToolCallError', message, mcpMeta })
      expect(error.telemetryMessage).toBe(`MCP tool [${name}] ${tool}: ${message}`)
    }
  })

  test('a call that outlives MCP_TOOL_TIMEOUT fails with the server, tool and whole seconds', async () => {
    expect(DEFAULT_MCP_TOOL_TIMEOUT_MS).toBe(300_000)
    process.env.MCP_TOOL_TIMEOUT = '1200'
    const name = fresh('stuck')
    const { connection } = await link(name, [{ name: 'hang', run: () => new Promise(() => {}) }])
    const started = Date.now()
    const error = (await call(connection, 'hang').catch(e => e)) as Error
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_100)
    expect(error.message).toBe(`MCP server "${name}" tool "hang" timed out after 1s`)
  })

  test('aborting the call rejects with the SDK\'s -32001 error (the no-content path for AbortError is never reached)', async () => {
    const { connection, ledger } = await link(fresh('cancel'), [{ name: 'hang', run: () => new Promise(() => {}) }])
    const controller = new AbortController()
    const pending = call(connection, 'hang', { signal: controller.signal })
    await until(() => ledger.calls.length, n => n > 0, 'the call to arrive')
    controller.abort()
    const error = (await pending.catch(e => e)) as McpError
    expect(error).toBeInstanceOf(McpError)
    expect(error.code).toBe(ErrorCode.RequestTimeout)
    expect(error.message).toContain('AbortError')
  })

  test('other server errors pass through unchanged', async () => {
    const { connection } = await link(fresh('errs'), [
      { name: 'boom', run: () => { throw new McpError(ErrorCode.InvalidParams, 'bad params', { field: 'q' }) } },
    ])
    const error = (await call(connection, 'boom').catch(e => e)) as McpError
    expect(error).toBeInstanceOf(McpError)
    expect({ code: error.code, data: error.data }).toEqual({ code: ErrorCode.InvalidParams, data: { field: 'q' } })
  })

  test('a 401 code on the error becomes McpAuthError', async () => {
    const name = fresh('reauth')
    const { connection } = await link(name, [{ name: 'locked', run: () => { throw new McpError(401, 'token expired') } }])
    const error = (await call(connection, 'locked').catch(e => e)) as McpAuthError
    expect(error).toBeInstanceOf(McpAuthError)
    expect({ name: error.name, serverName: error.serverName, message: error.message }).toEqual({
      name: 'McpAuthError',
      serverName: name,
      message: `MCP server "${name}" requires re-authorization (token expired)`,
    })
  })

  test('an HTTP session that expired becomes McpSessionExpiredError and drops the cached connection', async () => {
    const bed = serveHttp({ tools: [{ name: 'hello' }] })
    stops.push(bed.stop)
    const name = fresh('expired')
    const config = { type: 'http', url: bed.url, scope: 'user' } as ScopedMcpServerConfig
    stops.push(() => clearServerCache(name, config))
    const conn = (await connectToServer(name, config)) as ConnectedMCPServer
    bed.expireSessions()
    const error = (await call(conn, 'hello').catch(e => e)) as Error
    expect(error).toBeInstanceOf(McpSessionExpiredError)
    expect({ name: error.name, message: error.message }).toEqual({
      name: 'McpSessionExpiredError',
      message: `MCP server "${name}" session expired`,
    })
    expect(await connectToServer(name, config)).not.toBe(conn)
  })

  test('"Connection closed" counts as an expired session for HTTP servers only', async () => {
    const cases: Array<[ScopedMcpServerConfig | undefined, 'expired' | 'raw']> = [
      [{ type: 'http', url: 'http://127.0.0.1:9/mcp', scope: 'user' } as ScopedMcpServerConfig, 'expired'],
      [{ type: 'claudeai-proxy', url: 'x', id: 'gone', scope: 'claudeai' } as ScopedMcpServerConfig, 'expired'],
      [undefined, 'raw'],
    ]
    for (const [config, outcome] of cases) {
      let hangUp: (() => void) | undefined
      const name = fresh('closing')
      const made = await link(name, [{ name: 'wait', run: () => new Promise(() => hangUp!()) }], config)
      hangUp = () => void made.close()
      const error = (await call(made.connection, 'wait').catch(e => e)) as Error
      if (outcome === 'expired') {
        expect(error).toBeInstanceOf(McpSessionExpiredError)
        if (config) await clearServerCache(name, config)
      } else {
        expect(error).toBeInstanceOf(McpError)
        expect((error as McpError).code).toBe(ErrorCode.ConnectionClosed)
      }
    }
  })
})

// --- URL elicitation -----------------------------------------------------------------------

function urlElicitation(id: string) {
  return { mode: 'url', url: `https://auth.example/${id}`, elicitationId: id, message: `sign in (${id})` }
}

/** A tool that demands the given elicitations `times` times, then answers. */
function demanding(times: number, elicitations: unknown[] = [urlElicitation('e1')]): BedTool & { attempts: () => number } {
  let attempts = 0
  return {
    name: 'needs_url',
    attempts: () => attempts,
    run: () => {
      attempts += 1
      if (attempts <= times) throw new McpError(ErrorCode.UrlElicitationRequired, 'open a URL first', { elicitations })
      return text(`ok after ${attempts}`)
    },
  }
}

describe('URL elicitation (-32042)', () => {
  test('the host handler is asked for each elicitation, and an accept retries the call', async () => {
    const name = fresh('elicit')
    const formShaped = { ...urlElicitation('f1'), mode: 'form' }
    const tool = demanding(1, [urlElicitation('e1'), { mode: 'form', message: 'skip me' }, formShaped, urlElicitation('e2')])
    const { connection } = await link(name, [tool])
    const asked: Array<[string, unknown]> = []
    const result = await call(connection, 'needs_url', {
      handleElicitation: async (server, params) => {
        asked.push([server, params])
        return { action: 'accept' }
      },
    })
    expect(result.content).toEqual([{ type: 'text', text: 'ok after 2' }])
    expect(asked).toEqual([
      [name, urlElicitation('e1')],
      [name, urlElicitation('e2')],
    ])
  })

  test('a decline or cancel ends the call with a message for the model', async () => {
    const cases: Array<['decline' | 'cancel', string]> = [
      ['decline', 'declined'],
      ['cancel', 'canceled'],
    ]
    for (const [action, word] of cases) {
      const tool = demanding(5)
      const { connection } = await link(fresh('refuser'), [tool])
      const result = await call(connection, 'needs_url', { handleElicitation: async () => ({ action }) })
      expect(result).toEqual({
        content: `URL elicitation was ${word} by the user. The tool "needs_url" could not complete because it requires the user to open a URL.`,
      })
      expect(tool.attempts()).toBe(1)
    }
  })

  test('after three accepted rounds the fourth -32042 is thrown', async () => {
    const tool = demanding(10)
    const { connection } = await link(fresh('insistent'), [tool])
    const error = (await call(connection, 'needs_url', { handleElicitation: async () => ({ action: 'accept' }) }).catch(e => e)) as McpError
    expect(error).toBeInstanceOf(McpError)
    expect(error.code).toBe(ErrorCode.UrlElicitationRequired)
    expect(tool.attempts()).toBe(4)
  })

  test('a -32042 without a usable URL elicitation is thrown at once', async () => {
    const shapes: unknown[] = [
      [],
      [{ mode: 'form', message: 'x' }],
      [{ mode: 'form', url: 'https://a', elicitationId: 'e', message: 'complete but a form' }],
      [{ mode: 'url', url: 'https://a', message: 'no id' }],
      [{ mode: 'url', elicitationId: 'e', message: 'no url' }],
      [{ mode: 'url', url: 'https://a', elicitationId: 'e' }],
      [null, 'text'],
    ]
    for (const elicitations of shapes) {
      const tool = demanding(1, elicitations as unknown[])
      const { connection } = await link(fresh('malformed'), [tool])
      let asked = 0
      const error = (await call(connection, 'needs_url', { handleElicitation: async () => ((asked += 1), { action: 'accept' }) }).catch(e => e)) as McpError
      expect({ elicitations, code: error.code, asked, attempts: tool.attempts() }).toEqual({
        elicitations,
        code: ErrorCode.UrlElicitationRequired,
        asked: 0,
        attempts: 1,
      })
    }
  })

  test('the server name is "unknown" when the record handed over is not connected', async () => {
    const { connection } = await link(fresh('anon'), [demanding(1)])
    const names: string[] = []
    await call(connection, 'needs_url', {
      clientConnection: { name: 'x', type: 'pending', config: connection.config } as never,
      handleElicitation: async server => (names.push(server), { action: 'accept' }),
    })
    expect(names).toEqual(['unknown'])
  })

  test('an aborted signal stops the loop before the next attempt', async () => {
    const tool = demanding(5)
    const { connection } = await link(fresh('aborting'), [tool])
    const controller = new AbortController()
    const error = (await call(connection, 'needs_url', {
      signal: controller.signal,
      handleElicitation: async () => {
        controller.abort()
        return { action: 'accept' }
      },
    }).catch(e => e)) as Error
    expect(error.message).toBe('Tool call aborted during URL elicitation')
    expect(tool.attempts()).toBe(1)

    const before = new AbortController()
    before.abort()
    await expect(call(connection, 'needs_url', { signal: before.signal })).rejects.toThrow('Tool call aborted during URL elicitation')
  })

  describe('in the REPL, through the dialog queue', () => {
    type Queued = {
      serverName: string
      requestId: string
      params: unknown
      signal: AbortSignal
      waitingState: unknown
      respond: (r: { action: string }) => void
      onWaitingDismiss: (a: string) => void
    }

    function stateHolder() {
      let state = getDefaultAppState()
      return {
        setAppState: (update: (prev: typeof state) => typeof state) => {
          state = update(state)
        },
        queue: () => state.elicitation.queue as unknown as Queued[],
      }
    }

    test('the elicitation is queued with a retry-now waiting state; consenting alone does not retry', async () => {
      const name = fresh('repl')
      const tool = demanding(1)
      const { connection } = await link(name, [tool])
      const holder = stateHolder()
      const signal = new AbortController().signal
      const pending = call(connection, 'needs_url', { setAppState: holder.setAppState as never, signal })
      const [queued] = await until(holder.queue, q => q.length === 1, 'the queued elicitation')
      expect({
        serverName: queued!.serverName,
        requestId: queued!.requestId,
        params: queued!.params,
        signal: queued!.signal === signal,
        waitingState: queued!.waitingState,
      }).toEqual({
        serverName: name,
        requestId: 'error-elicit-e1',
        params: urlElicitation('e1'),
        signal: true,
        waitingState: { actionLabel: 'Retry now', showCancel: true },
      })
      queued!.respond({ action: 'accept' })
      await Bun.sleep(30)
      expect(tool.attempts()).toBe(1)
      queued!.onWaitingDismiss('retry')
      expect((await pending).content).toEqual([{ type: 'text', text: 'ok after 2' }])
    })

    test('declining, dismissing the wait, or aborting ends the call', async () => {
      const cases: Array<[string, (q: Queued, abort: () => void) => void, string]> = [
        ['decline in the dialog', q => q.respond({ action: 'decline' }), 'declined'],
        ['cancel in the dialog', q => q.respond({ action: 'cancel' }), 'canceled'],
        ['dismiss the wait', q => q.onWaitingDismiss('dismiss'), 'canceled'],
        ['abort the turn', (_q, abort) => abort(), 'canceled'],
      ]
      for (const [label, act, word] of cases) {
        const { connection } = await link(fresh('repl-no'), [demanding(5)])
        const holder = stateHolder()
        const controller = new AbortController()
        const pending = call(connection, 'needs_url', { setAppState: holder.setAppState as never, signal: controller.signal })
        const [queued] = await until(holder.queue, q => q.length === 1, label)
        act(queued!, () => controller.abort())
        const result = await pending
        expect({ label, content: result.content }).toEqual({
          label,
          content: `URL elicitation was ${word} by the user. The tool "needs_url" could not complete because it requires the user to open a URL.`,
        })
      }
    })
  })

  describe('with Elicitation hooks', () => {
    function useHook(event: 'Elicitation' | 'ElicitationResult', matcher: string, reply: unknown) {
      const command = `cat > /dev/null; printf '%s\\n' '${JSON.stringify(reply)}'`
      writeFileSync(
        join(root, 'config', 'settings.json'),
        JSON.stringify({ hooks: { [event]: [{ matcher, hooks: [{ type: 'command', command }] }] } }),
      )
      resetSettingsCache()
      resetHooksConfigSnapshot()
    }
    const hookAnswer = (event: string, action: string) => ({ hookSpecificOutput: { hookEventName: event, action } })

    test('a hook that accepts retries without asking anyone', async () => {
      const name = fresh('hooked')
      const tool = demanding(1)
      const { connection } = await link(name, [tool])
      useHook('Elicitation', name, hookAnswer('Elicitation', 'accept'))
      const result = await call(connection, 'needs_url', {
        handleElicitation: async () => {
          throw new Error('the hook should have answered')
        },
      })
      expect(result.content).toEqual([{ type: 'text', text: 'ok after 2' }])
    })

    test('a hook that declines or cancels ends the call with a message naming the hook', async () => {
      for (const [action, word] of [['decline', 'declined'], ['cancel', 'canceled']] as const) {
        const name = fresh('hook-no')
        const { connection } = await link(name, [demanding(5)])
        useHook('Elicitation', name, hookAnswer('Elicitation', action))
        expect(await call(connection, 'needs_url')).toEqual({
          content: `URL elicitation was ${word} by a hook. The tool "needs_url" could not complete because it requires the user to open a URL.`,
        })
      }
    })

    test('an ElicitationResult hook can turn the user\'s accept into a decline', async () => {
      const name = fresh('hook-result')
      const tool = demanding(5)
      const { connection } = await link(name, [tool])
      useHook('ElicitationResult', name, hookAnswer('ElicitationResult', 'decline'))
      const result = await call(connection, 'needs_url', { handleElicitation: async () => ({ action: 'accept' }) })
      expect(result.content).toBe(
        'URL elicitation was declined by the user. The tool "needs_url" could not complete because it requires the user to open a URL.',
      )
      expect(tool.attempts()).toBe(1)
    })
  })
})

// --- errors and helpers -----------------------------------------------------------------------

describe('errors and helpers', () => {
  test('isMcpSessionExpiredError needs both HTTP 404 and the JSON-RPC -32001 code', () => {
    const cases: Array<[unknown, string, boolean]> = [
      [404, '{"error":{"code":-32001,"message":"Session not found"}}', true],
      [404, '{"error":{"code": -32001,"message":"Session not found"}}', true],
      [404, 'Not Found', false],
      [404, '{"error":{"code":-32000}}', false],
      [500, '{"error":{"code":-32001}}', false],
      [undefined, '{"code":-32001}', false],
      ['404', '{"code":-32001}', false],
    ]
    for (const [code, message, expired] of cases) {
      const error = code === undefined ? new Error(message) : Object.assign(new Error(message), { code })
      expect({ code, message, expired: isMcpSessionExpiredError(error) }).toEqual({ code, message, expired })
    }
  })

  test('the error classes carry their names and data', () => {
    const auth = new McpAuthError('srv', 'please log in')
    expect({ name: auth.name, message: auth.message, serverName: auth.serverName, isError: auth instanceof Error }).toEqual({
      name: 'McpAuthError',
      message: 'please log in',
      serverName: 'srv',
      isError: true,
    })
    const expired = new McpSessionExpiredError('srv')
    expect({ name: expired.name, message: expired.message }).toEqual({ name: 'McpSessionExpiredError', message: 'MCP server "srv" session expired' })
    const failed = new McpToolCallError('shown', 'for telemetry', { _meta: { a: 1 } })
    expect({ name: failed.name, message: failed.message, telemetry: failed.telemetryMessage, meta: failed.mcpMeta }).toEqual({
      name: 'McpToolCallError',
      message: 'shown',
      telemetry: 'for telemetry',
      meta: { _meta: { a: 1 } },
    })
    expect(new McpToolCallError('x', 'y').mcpMeta).toBeUndefined()
  })

  test('extractToolUseId reads the id of a leading tool_use block only', () => {
    const cases: Array<[unknown[], string | undefined]> = [
      [[{ type: 'tool_use', id: 'toolu_9', name: 'x', input: {} }], 'toolu_9'],
      [[{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'toolu_8', name: 'x', input: {} }], undefined],
      [[{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }, { type: 'tool_use', id: 'toolu_7', name: 'x', input: {} }], undefined],
      [[], undefined],
    ]
    for (const [content, id] of cases) {
      expect(extractToolUseId({ message: { content } } as never)).toBe(id)
    }
  })

  test('callMCPTool answers the IDE path with just the call result', async () => {
    const { connection } = await link(fresh('direct'), [{ name: 'hi', run: () => text('hello') }])
    expect(await callMCPTool({ client: connection, tool: 'hi', args: {}, signal: new AbortController().signal })).toEqual({
      content: [{ type: 'text', text: 'hello' }],
      _meta: undefined,
      structuredContent: undefined,
    })
  })
})
