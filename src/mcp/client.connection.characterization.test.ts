/**
 * Characterization of `connectToServer` and the connection cache around it
 * (src/mcp/client/connection.ts, transport.ts), pinned before the clean-base
 * rewrite: which transport each config type gets, which credentials and
 * headers go out on it, what the record looks like for each outcome, and what
 * happens to a connection when its server goes away.
 *
 * Every server is real: a stdio script the client spawns, and Streamable HTTP,
 * SSE and WebSocket servers on loopback ports (see mcpServerBed). Credentials
 * live in a temp CLAUDIN_CONFIG_DIR with a refusing `secret-tool` ahead on
 * PATH (see oauthTestBed). The claude.ai proxy host is fixed in the product,
 * so for that one case `fetch` is pointed at a loopback server by rewriting
 * the origin only; the request itself still goes out over a socket.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  clearMcpAuthCache,
  clearServerCache,
  connectToServer,
  ensureConnectedClient,
} from 'src/mcp/client.js'
import { getServerKey } from 'src/mcp/auth.js'
import { type AuthBed, startAuthBed, useIsolatedStore } from 'src/mcp/auth/__testutils__/oauthTestBed.js'
import { isMcpAuthCached } from 'src/mcp/client/authCache.js'
import {
  BED_VERSION,
  type HttpBed,
  isAlive,
  type LoopbackBed,
  serveHttp,
  serveSse,
  serveWs,
  type StdioBed,
  until,
  useBuildMacro,
  writeStdioServer,
} from 'src/mcp/client/__testutils__/mcpServerBed.js'
import type { ConnectedMCPServer, MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { getOriginalCwd, getSessionId, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import { clearOAuthTokenCache } from 'src/providers/auth/auth.js'
import { PRODUCT_URL } from 'src/shared/constants/product.js'
import { getMCPUserAgent } from 'src/shared/http.js'

useBuildMacro()
const store = useIsolatedStore()

const OWNED_ENV = [
  'MCP_TIMEOUT',
  'CLAUDIN_SHELL_PREFIX',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const
let savedEnv: Record<string, string | undefined> = {}
let savedOriginalCwd = ''
let project = ''
let stdio: StdioBed
const beds: Array<{ stop: () => unknown }> = []
const live: MCPServerConnection[] = []
let serial = 0

beforeEach(() => {
  savedEnv = Object.fromEntries(OWNED_ENV.map(k => [k, process.env[k]]))
  for (const key of OWNED_ENV) delete process.env[key]
  savedOriginalCwd = getOriginalCwd()
  project = realpathSync(join(store.root(), '.'))
  mkdirSync(join(project, 'work'), { recursive: true })
  project = join(project, 'work')
  setOriginalCwd(project)
  clearMcpAuthCache()
  clearOAuthTokenCache()
  stdio = writeStdioServer(store.root())
})

afterEach(async () => {
  for (const conn of live.splice(0)) {
    if (conn.type === 'connected') await conn.cleanup().catch(() => {})
    await clearServerCache(conn.name, conn.config).catch(() => {})
  }
  for (const bed of beds.splice(0)) await bed.stop()
  for (const pid of stdio.pids()) if (isAlive(pid)) process.kill(pid, 'SIGKILL')
  for (const key of OWNED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setOriginalCwd(savedOriginalCwd)
  clearMcpAuthCache()
  clearOAuthTokenCache()
})

/** A server name no other test has used, so the connection cache starts cold. */
const fresh = (stem: string) => `${stem}-${++serial}-${process.pid}`

async function connect(name: string, config: ScopedMcpServerConfig): Promise<MCPServerConnection> {
  const conn = await connectToServer(name, config)
  live.push(conn)
  return conn
}

/** Looks the server up until the cache hands back something other than `previous`. */
async function reconnectAfter(
  name: string,
  config: ScopedMcpServerConfig,
  previous: MCPServerConnection,
): Promise<MCPServerConnection> {
  const deadline = Date.now() + 3_000
  for (;;) {
    const current = await connectToServer(name, config)
    if (current !== previous || Date.now() > deadline) {
      live.push(current)
      return current
    }
    await Bun.sleep(20)
  }
}

async function eventually(check: () => Promise<boolean>, what: string): Promise<true> {
  const deadline = Date.now() + 5_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`)
    await Bun.sleep(20)
  }
  return true
}

function connected(conn: MCPServerConnection): ConnectedMCPServer {
  if (conn.type !== 'connected') {
    throw new Error(`expected a connection, got ${conn.type}: ${'error' in conn ? conn.error : ''}`)
  }
  return conn
}

const remote = (type: 'http' | 'sse' | 'ws', url: string, extra: Record<string, unknown> = {}) =>
  ({ type, url, scope: 'user', ...extra }) as ScopedMcpServerConfig

function seedStoredToken(name: string, config: ScopedMcpServerConfig, accessToken: string) {
  const current = store.read() ?? {}
  store.write({
    ...current,
    mcpOAuth: {
      ...current.mcpOAuth,
      [getServerKey(name, config as never)]: {
        serverName: name,
        serverUrl: (config as { url: string }).url,
        accessToken,
        expiresAt: Date.now() + 3_600_000,
        scope: '',
      },
    },
  })
}

// --- stdio -----------------------------------------------------------------------

describe('stdio servers', () => {
  test('the client introduces itself and answers the server with the original cwd and a cancel', async () => {
    const name = fresh('intro')
    const conn = connected(await connect(name, stdio.config({ BED_ASK: '1' })))

    // On the wire: the fixture holds the introduction minus the build version.
    const hello = stdio.events().find(e => e.event === 'initialize')!.params
    const { version, ...clientInfo } = hello.clientInfo
    expect(version).toBe(BED_VERSION)
    expect({ clientInfo, capabilities: hello.capabilities }).toEqual(
      JSON.parse(readFileSync(join(import.meta.dir, 'client/__fixtures__/rewrite/initialize-hello.json'), 'utf8')),
    )
    expect(clientInfo.websiteUrl).toBe(PRODUCT_URL)

    const answers = await until(
      () => stdio.events().filter(e => e.event === 'answer'),
      list => list.length === 2,
      'both answers',
    )
    const byId = Object.fromEntries(answers.map(a => [a.id, a.result]))
    expect(byId['ask-roots']).toEqual({ roots: [{ uri: `file://${project}` }] })
    expect(byId['ask-elicit']).toEqual({ action: 'cancel' })

    expect(conn).toMatchObject({
      name,
      type: 'connected',
      capabilities: { tools: {} },
      serverInfo: { name: 'stdio-bed', version: '2.0.0' },
    })
    expect(conn.instructions).toBeUndefined()
  })

  test('server instructions are capped at 2048 characters with a marker', async () => {
    const cases: Array<[string, string]> = [
      ['short and sweet', 'short and sweet'],
      ['a'.repeat(2048), 'a'.repeat(2048)],
      ['b'.repeat(2049), `${'b'.repeat(2048)}… [truncated]`],
      ['c'.repeat(5000), `${'c'.repeat(2048)}… [truncated]`],
    ]
    for (const [given, expected] of cases) {
      const conn = connected(await connect(fresh('instr'), stdio.config({ BED_INSTRUCTIONS: given })))
      expect(conn.instructions).toBe(expected)
    }
  })

  test("the config's env is laid over the parent's environment", async () => {
    process.env.CHAR_PARENT_ONLY = 'from-parent'
    try {
      const config = stdio.config({ CHAR_FLAG: 'from-config', BED_ECHO_ENV: 'CHAR_FLAG,CHAR_PARENT_ONLY' })
      connected(await connect(fresh('env'), config))
      const start = stdio.events().find(e => e.event === 'start')!
      expect(start.env).toEqual({ CHAR_FLAG: 'from-config', CHAR_PARENT_ONLY: 'from-parent' })
    } finally {
      delete process.env.CHAR_PARENT_ONLY
    }
  })

  test('an entry with no type is started as stdio', async () => {
    const { type: _type, ...untyped } = stdio.config() as Record<string, unknown>
    const conn = connected(await connect(fresh('untyped'), untyped as ScopedMcpServerConfig))
    expect(conn.serverInfo?.name).toBe('stdio-bed')
  })

  test('CLAUDIN_SHELL_PREFIX runs instead, with the command and args joined into one argument', async () => {
    const argvFile = join(store.root(), 'prefix-argv.txt')
    const prefix = join(store.root(), 'prefix.sh')
    writeFileSync(prefix, `#!/bin/sh\nprintf '%s\\n' "$#" "$1" > '${argvFile}'\nexec sh -c "$1"\n`)
    chmodSync(prefix, 0o755)
    process.env.CLAUDIN_SHELL_PREFIX = prefix
    const config = stdio.config()
    connected(await connect(fresh('prefixed'), config))
    const [count, joined] = readFileSync(argvFile, 'utf8').split('\n')
    expect(count).toBe('1')
    expect(joined).toBe(`${process.execPath} ${stdio.script}`)
  })

  test('what a stdio server that never becomes usable yields', async () => {
    const dying = join(store.root(), 'dying.cjs')
    writeFileSync(dying, "process.stderr.write('cannot start'); process.exit(3)")
    const cases: Array<[string, ScopedMcpServerConfig]> = [
      ['missing binary', { type: 'stdio', command: join(store.root(), 'no-such-binary'), args: [], scope: 'user' } as ScopedMcpServerConfig],
      ['exits at once', { type: 'stdio', command: process.execPath, args: [dying], scope: 'user' } as ScopedMcpServerConfig],
    ]
    for (const [label, config] of cases) {
      const name = fresh('broken')
      const conn = await connect(name, config)
      expect({ label, type: conn.type, name: conn.name, config: conn.config }).toEqual({ label, type: 'failed', name, config })
      expect(conn.type === 'failed' && (conn.error?.length ?? 0) > 0).toBe(true)
    }
  })

  test('a server that never answers fails after MCP_TIMEOUT and its process is stopped', async () => {
    process.env.MCP_TIMEOUT = '400'
    const name = fresh('silent')
    const started = Date.now()
    const conn = await connect(name, stdio.config({ BED_SILENT: '1' }))
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(conn).toMatchObject({
      type: 'failed',
      error: `MCP server "${name}" connection timed out after 400ms`,
    })
    const [pid] = stdio.pids()
    await until(() => isAlive(pid!), alive => !alive, 'the silent server to stop')
  })

  test('one connection per name and config, failures included, until the cache is cleared', async () => {
    const config = stdio.config()
    const name = fresh('memo')
    const first = await connect(name, config)
    expect(await connectToServer(name, { ...config } as ScopedMcpServerConfig)).toBe(first)
    expect(stdio.pids()).toHaveLength(1)

    const otherConfig = stdio.config({ CHAR_VARIANT: '2' })
    const second = await connect(name, otherConfig)
    expect(second).not.toBe(first)
    expect(stdio.pids()).toHaveLength(2)

    const broken = { type: 'stdio', command: join(store.root(), 'nope'), args: [], scope: 'user' } as ScopedMcpServerConfig
    const failedName = fresh('memo-failed')
    const failed = await connect(failedName, broken)
    expect(await connectToServer(failedName, broken)).toBe(failed)
    await clearServerCache(failedName, broken)
    const again = await connect(failedName, broken)
    expect(again).not.toBe(failed)
    expect(again.type).toBe('failed')

    await clearServerCache(name, config)
    const [firstPid] = stdio.pids()
    await until(() => isAlive(firstPid!), alive => !alive, 'the cleared server to stop')
    const reopened = await connect(name, config)
    expect(reopened).not.toBe(first)
    expect(stdio.pids()).toHaveLength(3)
  })

  test('when the server process dies, the next lookup reconnects', async () => {
    const name = fresh('dies')
    const config = stdio.config()
    const first = connected(await connect(name, config))
    const [pid] = stdio.pids()
    let closed = false
    const previous = first.client.onclose
    first.client.onclose = () => {
      closed = true
      previous?.()
    }
    process.kill(pid!, 'SIGKILL')
    await until(() => closed, Boolean, 'the close to be noticed')
    const second = connected(await connect(name, config))
    expect(second).not.toBe(first)
    expect(stdio.pids()).toHaveLength(2)
  })

  test('cleanup escalates SIGINT, SIGTERM, SIGKILL until the process is gone', async () => {
    const cases: Array<{ trap: string; logged: string[]; atLeastMs: number }> = [
      { trap: '', logged: [], atLeastMs: 0 },
      { trap: 'SIGINT', logged: ['SIGINT'], atLeastMs: 90 },
      { trap: 'SIGINT,SIGTERM', logged: ['SIGINT', 'SIGTERM'], atLeastMs: 450 },
    ]
    for (const { trap, logged, atLeastMs } of cases) {
      const before = stdio.pids().length
      const conn = connected(await connect(fresh('stubborn'), stdio.config({ BED_TRAP: trap })))
      const pid = stdio.pids()[before]!
      const started = Date.now()
      await conn.cleanup()
      const took = Date.now() - started
      expect({ trap, alive: isAlive(pid) }).toEqual({ trap, alive: false })
      expect(took).toBeGreaterThanOrEqual(atLeastMs)
      expect(took).toBeLessThan(2_000)
      const signals = stdio.events().filter(e => e.event === 'signal' && e.pid === pid).map(e => e.name)
      expect({ trap, signals }).toEqual({ trap, signals: logged })
    }
  })

  test('ensureConnectedClient hands back the live connection, passes SDK servers through, and throws otherwise', async () => {
    const name = fresh('ensure')
    const config = stdio.config()
    const conn = connected(await connect(name, config))
    expect(await ensureConnectedClient(conn)).toBe(conn)

    const sdk = { ...conn, config: { type: 'sdk', name, scope: 'dynamic' } as ScopedMcpServerConfig }
    expect(await ensureConnectedClient(sdk)).toBe(sdk)

    const deadName = fresh('ensure-dead')
    const dead = { ...conn, name: deadName, config: { type: 'stdio', command: join(store.root(), 'gone'), args: [], scope: 'user' } as ScopedMcpServerConfig }
    live.push(dead)
    await expect(ensureConnectedClient(dead)).rejects.toThrow(`MCP server "${deadName}" is not connected`)
  })
})

// --- Streamable HTTP ----------------------------------------------------------------

describe('Streamable HTTP servers', () => {
  function httpBed(): HttpBed {
    const bed = serveHttp({ tools: [{ name: 'ping' }], instructions: 'over http' })
    beds.push(bed)
    return bed
  }

  test('every request carries the user agent and the configured headers; every POST accepts JSON and SSE', async () => {
    const bed = httpBed()
    const conn = connected(await connect(fresh('http'), remote('http', bed.url, { headers: { 'X-Team': 'blue' } })))
    expect(conn).toMatchObject({ type: 'connected', instructions: 'over http', capabilities: { tools: {} } })
    await conn.client.listTools()
    expect(bed.seen.length).toBeGreaterThan(1)
    for (const request of bed.seen) {
      expect(request.headers['user-agent']).toBe(getMCPUserAgent())
      expect(request.headers['x-team']).toBe('blue')
      expect(request.headers.authorization).toBeUndefined()
    }
    const posts = bed.seen.filter(r => r.method === 'POST')
    expect(posts.length).toBeGreaterThan(1)
    for (const post of posts) {
      expect(post.headers.accept).toContain('application/json')
      expect(post.headers.accept).toContain('text/event-stream')
    }
  })

  test('which Authorization goes out', async () => {
    const cases: Array<{ label: string; ingress?: string; stored?: string; fromConfig?: string; expected: string | undefined }> = [
      { label: 'nothing', expected: undefined },
      { label: 'session ingress token', ingress: 'ingress-1', expected: 'Bearer ingress-1' },
      { label: 'stored OAuth token wins over ingress', ingress: 'ingress-1', stored: 'stored-1', expected: 'Bearer stored-1' },
      { label: 'stored OAuth token alone', stored: 'stored-2', expected: 'Bearer stored-2' },
      { label: 'configured header wins over ingress', ingress: 'ingress-1', fromConfig: 'Bearer from-config', expected: 'Bearer from-config' },
      { label: 'configured header wins over a stored token', stored: 'stored-3', fromConfig: 'Bearer from-config', expected: 'Bearer from-config' },
    ]
    for (const { label, ingress, stored, fromConfig, expected } of cases) {
      const bed = httpBed()
      const name = fresh('auth')
      const config = remote('http', bed.url, fromConfig ? { headers: { Authorization: fromConfig } } : {})
      if (ingress) process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = ingress
      else delete process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
      if (stored) seedStoredToken(name, config, stored)
      connected(await connect(name, config))
      const posts = bed.seen.filter(r => r.method === 'POST')
      expect(posts.length).toBeGreaterThan(0)
      for (const post of posts) expect({ label, auth: post.headers.authorization as unknown }).toEqual({ label, auth: expected })
    }
  })

  /** An OAuth-protected server with nothing stored for it: every MCP request gets 401. */
  function lockedBed(): AuthBed {
    const bed = startAuthBed({ onResource: () => new Response('{"error":"unauthorized"}', { status: 401 }) })
    beds.push(bed)
    return bed
  }

  test('a 401 from an OAuth-protected server yields needs-auth and remembers it on disk', async () => {
    const bed = lockedBed()
    const name = fresh('locked')
    const config = remote('http', bed.mcpUrl)
    const conn = await connect(name, config)
    expect(conn).toEqual({ name, type: 'needs-auth', config })
    const file = join(store.configDir(), 'mcp-needs-auth-cache.json')
    const onDisk = await until(
      () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}),
      cache => name in cache,
      'the needs-auth entry',
    )
    expect(Object.keys(onDisk[name])).toEqual(['timestamp'])
    expect(Math.abs(onDisk[name].timestamp - Date.now())).toBeLessThan(10_000)
    expect(await eventually(() => isMcpAuthCached(name), 'the cache read')).toBe(true)
  })

  test('a 401 from a server with no OAuth discovery yields failed, and nothing is remembered', async () => {
    const bed = httpBed()
    bed.refuse = new Response('{"error":"unauthorized"}', { status: 401, headers: { 'Content-Type': 'application/json' } })
    const name = fresh('locked-bare')
    const conn = await connect(name, remote('http', bed.url))
    expect(conn.type).toBe('failed')
    await Bun.sleep(50)
    expect(await isMcpAuthCached(name)).toBe(false)
  })

  test('any other refusal yields failed, and nothing is remembered', async () => {
    const bed = httpBed()
    bed.refuse = new Response('boom', { status: 500 })
    const name = fresh('broken-http')
    const conn = await connect(name, remote('http', bed.url))
    expect(conn.type).toBe('failed')
    expect(await isMcpAuthCached(name)).toBe(false)
  })

  test('a 404 with -32001 (session gone) closes the connection, so the next lookup opens a new session', async () => {
    const bed = httpBed()
    const name = fresh('expiring')
    const config = remote('http', bed.url)
    const first = connected(await connect(name, config))
    bed.expireSessions()
    await expect(first.client.listTools()).rejects.toThrow()
    const second = connected(await reconnectAfter(name, config, first))
    expect(second).not.toBe(first)
    await second.client.listTools()
  })

  test('a plain 404 without -32001 keeps the connection', async () => {
    const bed = httpBed()
    const name = fresh('not-expiring')
    const config = remote('http', bed.url)
    const first = connected(await connect(name, config))
    bed.refuse = new Response('no such page', { status: 404 })
    await expect(first.client.listTools()).rejects.toThrow()
    bed.refuse = undefined
    await Bun.sleep(150)
    expect(await connectToServer(name, config)).toBe(first)
  })
})

// --- legacy SSE --------------------------------------------------------------------

describe('SSE servers', () => {
  async function sseBed(): Promise<LoopbackBed> {
    const bed = await serveSse({ tools: [{ name: 'ping' }] })
    beds.push(bed)
    return bed
  }

  test('the event stream asks for text/event-stream with the stored token and the configured headers', async () => {
    const bed = await sseBed()
    const name = fresh('sse')
    const config = remote('sse', bed.url, { headers: { 'X-Team': 'green' } })
    seedStoredToken(name, config, 'sse-token')
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'never-on-sse'
    const conn = connected(await connect(name, config))
    await conn.client.listTools()

    const stream = bed.seen.find(r => r.method === 'GET' && r.path === '/sse')!
    expect(stream.headers.accept).toBe('text/event-stream')
    expect(stream.headers.authorization).toBe('Bearer sse-token')
    expect(stream.headers['user-agent']).toBe(getMCPUserAgent())
    expect(stream.headers['x-team']).toBe('green')

    const posts = bed.seen.filter(r => r.method === 'POST')
    expect(posts.length).toBeGreaterThan(0)
    for (const post of posts) {
      expect(post.headers['x-team']).toBe('green')
      expect(post.headers['user-agent']).toBe(getMCPUserAgent())
      expect(post.headers.authorization).toBe('Bearer sse-token')
    }
  })

  test('without a stored token no Authorization is sent, even with a session ingress token', async () => {
    const bed = await sseBed()
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'never-on-sse'
    connected(await connect(fresh('sse-bare'), remote('sse', bed.url)))
    for (const request of bed.seen) expect(request.headers.authorization).toBeUndefined()
  })

  test('a 401 on the stream from an OAuth-protected server yields needs-auth', async () => {
    const bed = startAuthBed({ onResource: () => new Response('nope', { status: 401 }) })
    beds.push(bed)
    const name = fresh('sse-locked')
    const config = remote('sse', bed.mcpUrl)
    expect(await connect(name, config)).toEqual({ name, type: 'needs-auth', config })
    expect(await eventually(() => isMcpAuthCached(name), 'the needs-auth entry')).toBe(true)
  })

  test('an IDE SSE server gets no credentials and is told the CLI pid', async () => {
    // Not registered with `beds`: this connection is left open (see the end of
    // the test), and a stopped server would leave its client redialling into
    // whatever port a later file binds. The server lives until the process ends.
    const bed = await serveSse({ tools: [{ name: 'ping' }] })
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'never-on-ide'
    const config = { type: 'sse-ide', url: bed.url, ideName: 'Editor', scope: 'dynamic' } as ScopedMcpServerConfig
    connected(await connect(fresh('sse-ide'), config))
    const note = await until(
      () => bed.ledger.notes.find(n => n.method === 'ide_connected'),
      Boolean,
      'ide_connected',
    )
    expect(note!.params).toEqual({ pid: process.pid })
    for (const request of bed.seen) expect(request.headers.authorization).toBeUndefined()
    // Closing this connection makes the SDK's default EventSource throw an
    // AbortError from an abort listener under Bun, which the runner reports
    // as a failure. The product runs on Node; leave this one open instead.
    live.pop()
  })
})

// --- WebSocket ---------------------------------------------------------------------

describe('WebSocket servers', () => {
  test('ws: offers the mcp subprotocol with the user agent, the ingress token and the configured headers', async () => {
    const bed = serveWs({ tools: [{ name: 'ping' }] })
    beds.push(bed)
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'ingress-ws'
    const conn = connected(await connect(fresh('ws'), remote('ws', bed.url, { headers: { 'X-Team': 'red' } })))
    expect((await conn.client.listTools()).tools.map(t => t.name)).toEqual(['ping'])
    const [upgrade] = bed.seen
    expect(bed.protocols).toEqual(['mcp'])
    expect(upgrade!.headers['user-agent']).toBe(getMCPUserAgent())
    expect(upgrade!.headers.authorization).toBe('Bearer ingress-ws')
    expect(upgrade!.headers['x-team']).toBe('red')
  })

  test('ws: no ingress token, no Authorization', async () => {
    const bed = serveWs({ tools: [] })
    beds.push(bed)
    connected(await connect(fresh('ws-bare'), remote('ws', bed.url)))
    expect(bed.seen[0]!.headers.authorization).toBeUndefined()
  })

  test('ws-ide: the lockfile token travels in its own header, never as Authorization, and the IDE is told the pid', async () => {
    const bed = serveWs({ tools: [] })
    beds.push(bed)
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'never-on-ide'
    const config = { type: 'ws-ide', url: bed.url, ideName: 'Editor', authToken: 'lock-123', scope: 'dynamic' } as ScopedMcpServerConfig
    connected(await connect(fresh('ws-ide'), config))
    const [upgrade] = bed.seen
    expect(upgrade!.headers['x-claude-code-ide-authorization']).toBe('lock-123')
    expect(upgrade!.headers.authorization).toBeUndefined()
    expect(upgrade!.headers['user-agent']).toBe(getMCPUserAgent())
    const note = await until(() => bed.ledger.notes.find(n => n.method === 'ide_connected'), Boolean, 'ide_connected')
    expect(note!.params).toEqual({ pid: process.pid })
  })

  test('ws-ide without a token sends no IDE header', async () => {
    const bed = serveWs({ tools: [] })
    beds.push(bed)
    const config = { type: 'ws-ide', url: bed.url, ideName: 'Editor', scope: 'dynamic' } as ScopedMcpServerConfig
    connected(await connect(fresh('ws-ide-bare'), config))
    expect(bed.seen[0]!.headers['x-claude-code-ide-authorization']).toBeUndefined()
  })

  test('when the server hangs up, the next lookup reconnects', async () => {
    const bed = serveWs({ tools: [] })
    beds.push(bed)
    const name = fresh('ws-hangup')
    const config = remote('ws', bed.url)
    const first = connected(await connect(name, config))
    bed.hangUp()
    const reconnected = connected(await reconnectAfter(name, config, first))
    expect(reconnected).not.toBe(first)
    expect(bed.seen.length).toBe(2)
  })

  test('a refused upgrade yields failed', async () => {
    const bed = serveWs({ tools: [] })
    beds.push(bed)
    bed.refuse = new Response('no', { status: 403 })
    const conn = await connect(fresh('ws-refused'), remote('ws', bed.url))
    expect(conn.type).toBe('failed')
  })
})

// --- config types this module does not connect itself -----------------------------

describe('types that do not connect here', () => {
  test('sdk, unknown types and a claude.ai connector without a login fail with a reason', async () => {
    const cases: Array<[ScopedMcpServerConfig, string]> = [
      [{ type: 'sdk', name: 'in-host', scope: 'dynamic' } as ScopedMcpServerConfig, 'SDK servers should be handled in print.ts'],
      [{ type: 'carrier-pigeon', scope: 'user' } as unknown as ScopedMcpServerConfig, 'Unsupported server type: carrier-pigeon'],
      [{ type: 'claudeai-proxy', url: 'https://example.invalid', id: 'srv_1', scope: 'claudeai' } as ScopedMcpServerConfig, 'No claude.ai OAuth token found'],
    ]
    for (const [config, error] of cases) {
      const name = fresh('elsewhere')
      expect(await connect(name, config)).toEqual({ name, type: 'failed', config, error })
    }
  })

  test('a claude.ai connector goes to the proxy with the login token and the session id; a 401 there is needs-auth', async () => {
    const bed = serveHttp({ tools: [] })
    beds.push(bed)
    bed.refuse = new Response('{}', { status: 401 })
    store.write({
      claudeAiOauth: {
        accessToken: 'ai-access',
        refreshToken: null,
        expiresAt: Date.now() + 3_600_000,
        scopes: ['user:inference', 'user:mcp_servers'],
      },
    })
    clearOAuthTokenCache()
    const realFetch = globalThis.fetch
    const loopback = new URL(bed.url).origin
    globalThis.fetch = Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        const target = typeof input === 'string' || input instanceof URL ? new URL(String(input)) : new URL(input.url)
        const rerouted = target.origin === 'https://mcp-proxy.anthropic.com' ? `${loopback}${target.pathname}${target.search}` : target.href
        return realFetch(rerouted, init)
      },
      { preconnect: realFetch.preconnect },
    ) as typeof fetch
    try {
      const name = fresh('connector')
      const config = { type: 'claudeai-proxy', url: 'https://ignored.example', id: 'srv_42', scope: 'claudeai' } as ScopedMcpServerConfig
      expect(await connect(name, config)).toEqual({ name, type: 'needs-auth', config })
      const [first] = bed.seen
      expect(first!.path).toBe('/v1/mcp/srv_42')
      expect(first!.headers.authorization).toBe('Bearer ai-access')
      expect(first!.headers['x-mcp-client-session-id']).toBe(getSessionId())
      expect(first!.headers['user-agent']).toBe(getMCPUserAgent())
      expect(await eventually(() => isMcpAuthCached(name), 'the needs-auth entry')).toBe(true)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
