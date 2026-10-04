/**
 * The fixes of the mcp/callTool rewrite (spec findings 3 and 4), and the
 * pure seams the characterization suites reach only through a live server:
 * error classification, the oversize decision, URL-elicitation parsing and
 * the bounded retry loop.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import {
  clearServerCache,
  connectToServer,
  processMCPResult,
  transformMCPResult,
  transformResultContent,
} from 'src/mcp/client.js'
import { serveHttp, useBuildMacro } from 'src/mcp/client/__testutils__/mcpServerBed.js'
import { type CallErrorKind, classifyCallError } from 'src/mcp/client/callErrors.js'
import { callMCPTool } from 'src/mcp/client/callTool.js'
import { McpSessionExpiredError } from 'src/mcp/client/errors.js'
import { decideOversize, type OversizeAction } from 'src/mcp/client/resultGate.js'
import { isSafeFileId, toolResultFile } from 'src/mcp/client/resultFiles.js'
import {
  callWithUrlElicitation,
  MAX_URL_ELICITATION_ROUNDS,
  resolveUrlElicitation,
  urlElicitationsOf,
} from 'src/mcp/client/urlElicitation.js'
import { persistBinaryContent } from 'src/mcp/mcpOutputStorage.js'
import { truncateMcpContent } from 'src/mcp/mcpValidation.js'
import type { ConnectedMCPServer, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { getToolResultsDir } from 'src/agent/tools/toolResultStorage.js'
import { getOriginalCwd, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import * as tokenEstimation from 'src/shared/tokenEstimation.js'

useBuildMacro()

const OWNED_ENV = ['CLAUDIN_CONFIG_DIR', 'MAX_MCP_OUTPUT_TOKENS', 'ENABLE_MCP_LARGE_OUTPUT_FILES'] as const
let savedEnv: Record<string, string | undefined> = {}
let savedOriginalCwd = ''
let root = ''

beforeEach(() => {
  savedEnv = Object.fromEntries(OWNED_ENV.map(k => [k, process.env[k]]))
  for (const key of OWNED_ENV) delete process.env[key]
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-calltool-fixes-')))
  mkdirSync(join(root, 'config'))
  mkdirSync(join(root, 'project'))
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
  savedOriginalCwd = getOriginalCwd()
  setOriginalCwd(join(root, 'project'))
})

afterEach(() => {
  for (const key of OWNED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setOriginalCwd(savedOriginalCwd)
  rmSync(root, { recursive: true, force: true })
})

describe('finding 3: saved output never collides', () => {
  test('two calls of one tool in the same millisecond write two files, each read back as its own', async () => {
    const counter = spyOn(tokenEstimation, 'countMessagesTokensWithAPI').mockResolvedValue(30_000)
    const clock = spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    try {
      const first = (await processMCPResult({ toolResult: 'a'.repeat(200_000) }, 'dump', 'srv')) as string
      const second = (await processMCPResult({ toolResult: 'b'.repeat(200_000) }, 'dump', 'srv')) as string
      const files = readdirSync(getToolResultsDir())
      expect(files).toHaveLength(2)
      for (const file of files) expect(file).toMatch(/^mcp-srv-dump-1700000000000-[a-z0-9]{6}\.txt$/)
      for (const [message, letter] of [[first, 'a'], [second, 'b']] as const) {
        const path = files.map(f => join(getToolResultsDir(), f)).find(p => message.includes(`saved to ${p}.`))
        expect(readFileSync(path!, 'utf8')).toBe(letter.repeat(200_000))
      }
    } finally {
      clock.mockRestore()
      counter.mockRestore()
    }
  })

  test('every name is normalized parts, the time, and a random part', () => {
    const cases: Array<[Parameters<typeof toolResultFile>[0], RegExp]> = [
      [{ kind: 'output', server: 'my srv', tool: 'read.all' }, /^mcp-my_srv-read_all-42-[a-z0-9]{6}$/],
      [{ kind: 'output', server: '../up', tool: '..\\x' }, /^mcp-___up-___x-42-[a-z0-9]{6}$/],
      [{ kind: 'blob', server: 'a/b' }, /^mcp-a_b-blob-42-[a-z0-9]{6}$/],
    ]
    for (const [parts, shape] of cases) {
      const a = toolResultFile(parts, 42)
      const b = toolResultFile(parts, 42)
      expect(a).toMatch(shape)
      expect(a).not.toBe(b)
      expect(isSafeFileId(a)).toBe(true)
    }
  })
})

describe('finding 4: persistBinaryContent keeps to its directory', () => {
  test('an id with a separator or a parent step is refused, and nothing is written', async () => {
    const outside = join(dirname(getToolResultsDir()), 'escaped')
    const ids = ['../escaped', '..\\escaped', 'a/b', 'a\\b', '..', 'x..y', '/abs/path', '']
    for (const id of ids) {
      const result = await persistBinaryContent(Buffer.from('payload'), 'application/pdf', id)
      expect({ id, keys: Object.keys(result) }).toEqual({ id, keys: ['error'] })
      expect((result as { error: string }).error).toContain('must not hold a path')
    }
    expect(existsSync(`${outside}.pdf`)).toBe(false)
    expect(existsSync(getToolResultsDir()) ? readdirSync(getToolResultsDir()) : []).toEqual([])
  })

  test('a safe id is still written', async () => {
    const result = await persistBinaryContent(Buffer.from('ok'), undefined, 'webfetch-1-abc')
    expect(result).toEqual({ filepath: join(getToolResultsDir(), 'webfetch-1-abc.bin'), size: 2, ext: 'bin' })
  })
})

describe('call errors', () => {
  const http = 'http' as ScopedMcpServerConfig['type']
  const closed = new McpError(ErrorCode.ConnectionClosed, 'Connection closed')
  const cases: Array<[string, unknown, ScopedMcpServerConfig['type'], CallErrorKind]> = [
    ['SDK unauthorized', new UnauthorizedError('no'), undefined, 'auth'],
    ['HTTP 401', Object.assign(new Error('401'), { code: 401 }), http, 'auth'],
    ['JSON-RPC 401 on stdio', new McpError(401, 'token'), undefined, 'auth'],
    ['404 + -32001', Object.assign(new Error('{"code":-32001}'), { code: 404 }), http, 'expired'],
    ['closed on http', closed, http, 'expired'],
    ['closed on claudeai-proxy', closed, 'claudeai-proxy', 'expired'],
    ['closed on sse', closed, 'sse', 'passthrough'],
    ['closed on stdio', closed, undefined, 'passthrough'],
    ['-32000 with another message', new McpError(ErrorCode.ConnectionClosed, 'Request was cancelled'), http, 'passthrough'],
    ['a string', 'boom', http, 'passthrough'],
  ]
  test('each failure is classified', () => {
    for (const [label, error, type, kind] of cases) {
      expect({ label, kind: classifyCallError(error, type) }).toEqual({ label, kind })
    }
  })
})

describe('an expired session', () => {
  test('drops the cached connection itself, even while the transport is still up', async () => {
    const bed = serveHttp({ tools: [{ name: 'hello' }] })
    const name = `expired-fix-${process.pid}`
    const config = { type: 'http', url: bed.url, scope: 'user' } as ScopedMcpServerConfig
    try {
      const live = (await connectToServer(name, config)) as ConnectedMCPServer
      expect(await connectToServer(name, config)).toBe(live)
      const expired = Object.assign(new Error('{"error":{"code":-32001}}'), { code: 404 })
      const forgetful = { ...live, client: { callTool: async () => Promise.reject(expired) } } as never
      const error = await callMCPTool({ client: forgetful, tool: 'hello', args: {}, signal: new AbortController().signal }).catch(e => e)
      expect(error).toBeInstanceOf(McpSessionExpiredError)
      expect(await connectToServer(name, config)).not.toBe(live)
    } finally {
      await clearServerCache(name, config)
      await bed.stop()
    }
  })
})

describe('the size gate', () => {
  test('oversize content is saved only when files are on and it holds no image', () => {
    const cases: Array<[boolean, boolean, OversizeAction]> = [
      [true, false, 'save'],
      [true, true, 'cut'],
      [false, false, 'cut'],
      [false, true, 'cut'],
    ]
    for (const [largeOutputFiles, hasImage, action] of cases) {
      expect({ largeOutputFiles, hasImage, action: decideOversize({ largeOutputFiles, hasImage }) }).toEqual({ largeOutputFiles, hasImage, action })
    }
  })

  test('an image that cannot be compressed is dropped, and the text after it keeps the budget', async () => {
    process.env.MAX_MCP_OUTPUT_TOKENS = '1700'
    const notAnImage = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('x'.repeat(500)).toString('base64') } } as const
    const blocks = (await truncateMcpContent([{ type: 'text', text: 't'.repeat(6_700) }, notAnImage, { type: 'text', text: 'tail' }])) as Array<{ type: string; text?: string }>
    expect(blocks.map(b => b.text?.slice(0, 4) ?? b.type)).toEqual(['tttt', 'tail', '[OUT'])
  })

  test('a content array with an item that has no type is refused as a format error', async () => {
    for (const item of [null, 'text', { text: 'no type' }]) {
      await expect(transformMCPResult({ content: [item] }, 'search', 'slack')).rejects.toThrow('MCP server "slack" tool "search": unexpected response format')
    }
  })

  test('resource links are sanitized like every other server text', async () => {
    const [block] = await transformResultContent({ type: 'resource_link', uri: 'file:///a\u200B', name: 'n\u202Eo', description: 'd\u{E0041}' } as never, 'srv')
    expect(block).toEqual({ type: 'text', text: '[Resource link: no] file:///a (d)' })
  })
})

describe('URL elicitation', () => {
  const url = (id: string) => ({ mode: 'url' as const, url: `https://x/${id}`, elicitationId: id, message: id })
  const demand = (elicitations: unknown) => new McpError(ErrorCode.UrlElicitationRequired, 'open', { elicitations })

  test('only a -32042 has elicitations; malformed entries are dropped', () => {
    expect(urlElicitationsOf(new Error('x'))).toBeUndefined()
    expect(urlElicitationsOf(new McpError(ErrorCode.InvalidParams, 'x', { elicitations: [url('a')] }))).toBeUndefined()
    expect(urlElicitationsOf(new McpError(ErrorCode.UrlElicitationRequired, 'x'))).toEqual([])
    expect(urlElicitationsOf(demand([url('a'), { ...url('b'), mode: 'form' }, null, url('c')]))).toEqual([url('a'), url('c')])
  })

  test('the loop retries after each accepted round, at most three times, and stops on the first ending', async () => {
    let attempts = 0
    const failing = async () => {
      attempts += 1
      throw demand([url('a'), url('b')])
    }
    const asked: string[] = []
    const accept = async (p: { elicitationId: string }) => (asked.push(p.elicitationId), undefined)
    await expect(callWithUrlElicitation(failing, accept, new AbortController().signal)).rejects.toMatchObject({ code: ErrorCode.UrlElicitationRequired })
    expect(attempts).toBe(MAX_URL_ELICITATION_ROUNDS + 1)
    expect(asked).toHaveLength(MAX_URL_ELICITATION_ROUNDS * 2)

    attempts = 0
    asked.length = 0
    const declineFirst = async (p: { elicitationId: string }) => (asked.push(p.elicitationId), { action: 'decline' as const, by: 'user' as const })
    expect(await callWithUrlElicitation(failing, declineFirst, new AbortController().signal)).toEqual({ kind: 'ended', ending: { action: 'decline', by: 'user' } })
    expect({ attempts, asked }).toEqual({ attempts: 1, asked: ['a'] })
  })

  test('a hook that accepts skips the host and the result hooks; a host answer goes through them', async () => {
    const signal = new AbortController().signal
    const calls: string[] = []
    const deps = {
      serverName: 'srv',
      signal,
      setAppState: () => {
        throw new Error('no queue expected')
      },
      handleElicitation: async () => (calls.push('host'), { action: 'accept' as const }),
      runResultHooks: async (_s: string, r: { action: 'accept' | 'decline' | 'cancel' }) => (calls.push('result'), r),
    }
    expect(await resolveUrlElicitation(url('a') as never, { ...deps, runHooks: async () => ({ action: 'accept' }) })).toBeUndefined()
    expect(calls).toEqual([])
    expect(await resolveUrlElicitation(url('a') as never, { ...deps, runHooks: async () => undefined })).toBeUndefined()
    expect(calls).toEqual(['host', 'result'])
    expect(await resolveUrlElicitation(url('a') as never, { ...deps, runHooks: async () => ({ action: 'cancel' }) })).toEqual({ action: 'cancel', by: 'hook' })
  })

  test('a signal aborted before the queue is reached cancels without queueing', async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await resolveUrlElicitation(url('a') as never, {
      serverName: 'srv',
      signal: controller.signal,
      setAppState: () => {
        throw new Error('no queue expected')
      },
      runHooks: async () => undefined,
      runResultHooks: async (_s, r) => r,
    })
    expect(outcome).toEqual({ action: 'cancel', by: 'user' })
  })
})
