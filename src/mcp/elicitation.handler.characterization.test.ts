/**
 * Characterization of `elicitationHandler.ts`, pinned before the clean-base
 * rewrite: how an MCP server's `elicitation/create` request reaches the
 * dialog queue in the app state, how the answer goes back, and what the
 * Elicitation, ElicitationResult and Notification hooks see and may change.
 *
 * Nothing is mocked. Each test connects a real SDK `Server` to a real SDK
 * `Client` over the in-memory transport, and the hooks are real command hooks
 * read from a `settings.json` in a temp `CLAUDIN_CONFIG_DIR`. Each hook writes
 * the JSON it was given to a file, so the test reads what the hook saw.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  type ElicitRequestParams,
  type ElicitResult,
  ElicitResultSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js'

import {
  type ElicitationRequestEvent,
  registerElicitationHandler,
  runElicitationHooks,
  runElicitationResultHooks,
} from 'src/mcp/elicitationHandler.js'
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
import { type AppState, getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

// --- the environment: temp config, temp project, hooks allowed ----------------

const ENV_KEYS = ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_SIMPLE', 'CLAUDIN_ENV_FILE'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
let savedProcess: { cwd: string; originalCwd: string; interactive: boolean }

let root: string
let configDir: string
const opened: Array<{ close(): Promise<void> }> = []

beforeAll(() => {
  savedProcess = { cwd: getCwdState(), originalCwd: getOriginalCwd(), interactive: !getIsNonInteractiveSession() }
})

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-elicitation-')))
  configDir = join(root, 'config')
  const project = join(root, 'project')
  mkdirSync(configDir)
  mkdirSync(project)
  process.env.CLAUDIN_CONFIG_DIR = configDir
  delete process.env.CLAUDIN_SIMPLE
  delete process.env.CLAUDIN_ENV_FILE
  setOriginalCwd(project)
  setCwdState(project)
  // A non-interactive session runs hooks without the workspace-trust dialog.
  setIsInteractive(false)
  resetSettingsCache()
  resetHooksConfigSnapshot()
})

afterEach(async () => {
  for (const side of opened.splice(0)) await side.close()
  setOriginalCwd(savedProcess.originalCwd)
  setCwdState(savedProcess.cwd)
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  resetSettingsCache()
  resetHooksConfigSnapshot()
  rmSync(root, { recursive: true, force: true })
})

afterAll(() => {
  setIsInteractive(savedProcess.interactive)
})

// --- hooks ------------------------------------------------------------------------

const sh = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

type HookSpec = { log?: string; reply?: unknown; exit?: number }
type EventName = 'Elicitation' | 'ElicitationResult' | 'Notification'

/** A command hook that appends its stdin as one line to `log`, prints `reply`, and exits with `exit`. */
function commandHook({ log, reply, exit }: HookSpec) {
  const parts = [log ? `{ cat; echo; } >> ${sh(join(root, log))}` : 'cat > /dev/null']
  if (reply !== undefined) parts.push(`printf '%s\\n' ${sh(typeof reply === 'string' ? reply : JSON.stringify(reply))}`)
  if (exit !== undefined) parts.push(`exit ${exit}`)
  return { type: 'command', command: parts.join('; ') }
}

function useHooks(hooks: Partial<Record<EventName, Array<{ matcher: string } & HookSpec>>>) {
  const settings = Object.fromEntries(
    Object.entries(hooks).map(([event, list]) => [
      event,
      list!.map(({ matcher, ...spec }) => ({ matcher, hooks: [commandHook(spec)] })),
    ]),
  )
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ hooks: settings }))
  resetSettingsCache()
  resetHooksConfigSnapshot()
}

/** Every input a hook logged so far, parsed. */
function logged(log: string): Array<Record<string, unknown>> {
  const path = join(root, log)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

async function waitFor<T>(read: () => T, done: (value: T) => boolean, what: string): Promise<T> {
  for (let elapsed = 0; elapsed < 5_000; elapsed += 15) {
    const value = read()
    if (done(value)) return value
    await Bun.sleep(15)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const loggedOnce = async (log: string) => (await waitFor(() => logged(log), l => l.length > 0, log))[0]!

/** Strip the fields every hook input carries, so a test compares only the event's own. */
function eventFields(input: Record<string, unknown>) {
  const { session_id, transcript_path, cwd, ...own } = input
  expect(typeof session_id).toBe('string')
  expect(typeof transcript_path).toBe('string')
  expect(cwd).toBe(getCwdState())
  return own
}

const answer = (event: 'Elicitation' | 'ElicitationResult', action: string, content?: object) => ({
  hookSpecificOutput: { hookEventName: event, action, ...(content && { content }) },
})

// --- a server connected to a client the handler is registered on ---------------

type Capabilities = ConstructorParameters<typeof Client>[1]
const FORM_AND_URL: Capabilities = { capabilities: { elicitation: { form: {}, url: {} } } }
/** What Claudin's own MCP client declares. */
const AS_SHIPPED: Capabilities = { capabilities: { elicitation: {} } }

/** The app state the handler updates, as the REPL holds it. */
function stateHolder() {
  const holder = {
    state: getDefaultAppState() as AppState,
    updates: 0,
    failNext: false,
    set(update: (prev: AppState) => AppState) {
      if (holder.failNext) {
        holder.failNext = false
        throw new Error('state store unavailable')
      }
      holder.updates++
      holder.state = update(holder.state)
    },
    get queue(): ElicitationRequestEvent[] {
      return holder.state.elicitation.queue
    },
  }
  return holder
}

async function connect(serverName = 'tracker', capabilities: Capabilities = FORM_AND_URL) {
  const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: {} })
  const client = new Client({ name: 'test-host', version: '1.0.0' }, capabilities)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const sentIds: Array<string | number> = []
  const send = serverSide.send.bind(serverSide)
  serverSide.send = async (message: JSONRPCMessage, options) => {
    if ('method' in message && message.method === 'elicitation/create' && 'id' in message) sentIds.push(message.id)
    return send(message, options)
  }
  await server.connect(serverSide)
  await client.connect(clientSide)
  opened.push(client, server)
  const app = stateHolder()
  registerElicitationHandler(client, serverName, app.set)
  /** Sent on the wire as is: the SDK server refuses to send it to a client without URL support. */
  const completed = (elicitationId: string) =>
    send({ jsonrpc: '2.0', method: 'notifications/elicitation/complete', params: { elicitationId } })
  return { server, client, app, sentIds, completed }
}

type Connected = Awaited<ReturnType<typeof connect>>

/** Send a raw `elicitation/create`; settles with the result or the error the server got. */
function ask(link: Connected, params: Record<string, unknown>, signal?: AbortSignal) {
  return link.server
    .request({ method: 'elicitation/create', params } as never, ElicitResultSchema, { signal })
    .then(
      result => ({ result: result as ElicitResult }),
      (error: { code?: number; message: string }) => ({ error }),
    )
}

const queued = (link: Connected, count = 1) =>
  waitFor(() => link.app.queue, queue => queue.length >= count, `${count} queued elicitation(s)`)

const FORM = {
  message: 'Which environment?',
  requestedSchema: {
    type: 'object',
    properties: { env: { type: 'string', enum: ['staging', 'prod'] }, retries: { type: 'integer', minimum: 0 } },
    required: ['env'],
  },
} satisfies Record<string, unknown>
const URL_ASK = {
  mode: 'url',
  message: 'Authorize the tracker',
  url: 'https://auth.example.test/start?state=abc',
  elicitationId: 'el-42',
} satisfies Record<string, unknown>

// --- registration -----------------------------------------------------------------

describe('registerElicitationHandler', () => {
  test('a client created without the elicitation capability is left alone, without throwing', async () => {
    const link = await connect('quiet', { capabilities: {} })
    expect(await ask(link, FORM)).toMatchObject({ error: { code: -32601 } })
    await link.completed('x')
    await Bun.sleep(30)
    expect(link.app.updates).toBe(0)
  })

  test('with the capability as Claudin declares it, form requests are queued and URL requests refused', async () => {
    const link = await connect('tracker', AS_SHIPPED)
    expect(await ask(link, URL_ASK)).toMatchObject({ error: { code: -32602 } })
    expect(link.app.updates).toBe(0)

    const pending = ask(link, FORM)
    const [event] = await queued(link)
    event!.respond({ action: 'decline' })
    expect(await pending).toEqual({ result: { action: 'decline' } })
  })

  test('a request whose schema the protocol does not allow never reaches the queue', async () => {
    const link = await connect()
    const malformed: Array<Record<string, unknown>> = [
      { message: 'nested', requestedSchema: { type: 'object', properties: { address: { type: 'object' } } } },
      { message: 'not an object', requestedSchema: { type: 'array' } },
      { message: 'unknown format', requestedSchema: { type: 'object', properties: { tel: { type: 'string', format: 'phone' } } } },
      { message: 'free list', requestedSchema: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } } },
      { message: 'no schema' },
      { requestedSchema: { type: 'object', properties: {} } },
      { mode: 'url', message: 'no id', url: 'https://auth.example.test' },
    ]
    for (const params of malformed) {
      const outcome = await ask(link, params)
      expect('error' in outcome).toBe(true)
    }
    expect(link.app.updates).toBe(0)
  })
})

// --- a form request ----------------------------------------------------------------

describe('a form request', () => {
  test('is appended to the queue as an event that carries the request untouched', async () => {
    const link = await connect('tracker')
    const earlier = { serverName: 'other', requestId: 'kept', params: { message: 'x' } } as unknown as ElicitationRequestEvent
    link.app.state = { ...link.app.state, elicitation: { queue: [earlier] } }
    const before = link.app.state

    void ask(link, FORM)
    await queued(link, 2)
    const [first, event] = link.app.queue
    expect(first).toBe(earlier)
    expect(event!.serverName).toBe('tracker')
    expect(event!.requestId).toBe(link.sentIds[0]!)
    expect(event!.params).toEqual(FORM as unknown as ElicitRequestParams)
    expect(event!.signal.aborted).toBe(false)
    expect(event!.waitingState).toBeUndefined()
    expect(event!.completed).toBeUndefined()
    expect(event!.onWaitingDismiss).toBeUndefined()
    // Everything else in the app state is carried over as it was.
    const { elicitation: _new, ...rest } = link.app.state
    const { elicitation: _old, ...restBefore } = before
    expect(rest).toEqual(restBefore)
  })

  test('each request gets its own event, keyed by its JSON-RPC id', async () => {
    const link = await connect()
    void ask(link, FORM)
    await queued(link)
    void ask(link, { ...FORM, message: 'Second question' })
    await queued(link, 2)
    expect(link.app.queue.map(event => event.requestId)).toEqual(link.sentIds)
    expect(new Set(link.sentIds).size).toBe(2)
    expect(link.app.queue.map(event => event.params.message)).toEqual(['Which environment?', 'Second question'])
  })

  const answers: ElicitResult[] = [
    { action: 'accept', content: { env: 'prod', retries: 3 } },
    { action: 'accept', content: {} },
    { action: 'decline' },
    { action: 'cancel' },
  ]
  for (const reply of answers) {
    test(`the user's ${JSON.stringify(reply)} is what the server receives`, async () => {
      const link = await connect()
      const pending = ask(link, FORM)
      const [event] = await queued(link)
      event!.respond(reply)
      expect(await pending).toEqual({ result: reply })
    })
  }

  test('the first answer wins; later ones are ignored', async () => {
    const link = await connect()
    const pending = ask(link, FORM)
    const [event] = await queued(link)
    event!.respond({ action: 'accept', content: { env: 'staging' } })
    event!.respond({ action: 'cancel' })
    expect(await pending).toEqual({ result: { action: 'accept', content: { env: 'staging' } } })
  })

  test('the event is not taken off the queue: that is the caller’s job', async () => {
    const link = await connect()
    const pending = ask(link, FORM)
    const [event] = await queued(link)
    event!.respond({ action: 'decline' })
    await pending
    expect(link.app.queue).toEqual([event!])
  })

  test('when the server cancels, the event’s signal aborts and cancel is announced, past the result hooks', async () => {
    useHooks({
      ElicitationResult: [{ matcher: 'tracker', log: 'result.jsonl' }],
      Notification: [{ matcher: 'elicitation_response', log: 'notice.jsonl' }],
    })
    const link = await connect('tracker')
    // The SDK drops a cancel for request id 0, so the elicitation must not be the first request.
    await link.server.ping()
    const stop = new AbortController()
    const pending = ask(link, FORM, stop.signal)
    const [event] = await queued(link)
    stop.abort('server gave up')
    expect(await pending).toMatchObject({ error: { message: expect.stringContaining('server gave up') } })
    await waitFor(() => event!.signal.aborted, Boolean, 'the abort to reach the client')
    expect((await loggedOnce('notice.jsonl')).message).toBe('Elicitation response for server "tracker": cancel')
    // The result hooks run under the aborted signal, so they are skipped.
    expect(logged('result.jsonl')).toEqual([])
    expect(link.app.queue).toHaveLength(1)
    expect(() => event!.respond({ action: 'accept', content: { env: 'prod' } })).not.toThrow()
  })

  test('if the app state cannot be updated, the server is told cancel', async () => {
    const link = await connect()
    link.app.failNext = true
    expect(await ask(link, FORM)).toEqual({ result: { action: 'cancel' } })
    expect(link.app.queue).toEqual([])
  })
})

// --- a URL request and its completion ----------------------------------------------

describe('a URL request', () => {
  test('is queued with its link and id, and a "Skip confirmation" waiting state', async () => {
    const link = await connect()
    const pending = ask(link, URL_ASK)
    const [event] = await queued(link)
    expect(event!.params).toEqual(URL_ASK as unknown as ElicitRequestParams)
    expect(event!.waitingState).toEqual({ actionLabel: 'Skip confirmation' })
    event!.respond({ action: 'accept' })
    expect(await pending).toEqual({ result: { action: 'accept' } })
  })

  test('a completion notice marks the first URL event of that server with that id, and nothing else', async () => {
    const link = await connect('tracker')
    for (const [count, params] of [{ ...URL_ASK, elicitationId: 'el-43' }, URL_ASK, FORM].entries()) {
      void ask(link, params)
      await queued(link, count + 1)
    }
    // Decoys queued ahead for the same id: another server's URL event, and a form event.
    const foreign = { serverName: 'billing', requestId: 'b', params: { ...URL_ASK } } as unknown as ElicitationRequestEvent
    const formWithId = { serverName: 'tracker', requestId: 'f', params: { ...FORM, mode: 'form', elicitationId: 'el-42' } } as unknown as ElicitationRequestEvent
    // A later event for the same id, as a tool call's retry flow queues it.
    const retry = { serverName: 'tracker', requestId: 'error-elicit-el-42', params: { ...URL_ASK } } as unknown as ElicitationRequestEvent
    link.app.state = { ...link.app.state, elicitation: { queue: [foreign, formWithId, ...link.app.queue, retry] } }
    const marks = () => link.app.queue.map(event => event.completed ?? false)

    await link.completed('el-42')
    await waitFor(() => link.app.queue[3]!.completed, Boolean, 'the completion')
    expect(marks()).toEqual([false, false, false, true, false, false])
    expect(link.app.queue[3]!.params).toEqual(URL_ASK as unknown as ElicitRequestParams)

    // A second notice finds the same first match again, so the retry event is never marked.
    const updates = link.app.updates
    await link.completed('el-42')
    await waitFor(() => link.app.updates, n => n > updates, 'the second notice')
    expect(marks()).toEqual([false, false, false, true, false, false])
  })

  test('a completion notice for an unknown id leaves the state object as it was', async () => {
    const link = await connect()
    void ask(link, URL_ASK)
    await queued(link)
    const before = link.app.state
    const updates = link.app.updates
    await link.completed('nobody')
    await waitFor(() => link.app.updates, n => n > updates, 'the notice to be handled')
    expect(link.app.state).toBe(before)
  })

  test('a completion notice is announced to Notification hooks', async () => {
    useHooks({ Notification: [{ matcher: 'elicitation_complete', log: 'notice.jsonl' }] })
    const link = await connect('tracker')
    await link.completed('el-42')
    expect(eventFields(await loggedOnce('notice.jsonl'))).toEqual({
      hook_event_name: 'Notification',
      message: 'MCP server "tracker" confirmed elicitation el-42 complete',
      notification_type: 'elicitation_complete',
    })
  })
})

// --- hooks around a request -----------------------------------------------------------

describe('hooks around a request', () => {
  test('the Elicitation hook sees the request; a form one has no link or id, a URL one no schema', async () => {
    useHooks({ Elicitation: [{ matcher: 'tracker', log: 'asked.jsonl' }] })
    const link = await connect('tracker')
    void ask(link, FORM)
    await queued(link)
    void ask(link, URL_ASK)
    await queued(link, 2)
    expect(logged('asked.jsonl').map(eventFields)).toEqual([
      {
        hook_event_name: 'Elicitation',
        mcp_server_name: 'tracker',
        message: 'Which environment?',
        mode: 'form',
        requested_schema: FORM.requestedSchema,
      },
      {
        hook_event_name: 'Elicitation',
        mcp_server_name: 'tracker',
        message: 'Authorize the tracker',
        mode: 'url',
        url: 'https://auth.example.test/start?state=abc',
        elicitation_id: 'el-42',
      },
    ])
  })

  test('an Elicitation hook that answers resolves the request without queueing it', async () => {
    useHooks({ Elicitation: [{ matcher: 'tracker', reply: answer('Elicitation', 'accept', { env: 'staging' }) }] })
    const link = await connect('tracker')
    expect(await ask(link, FORM)).toEqual({ result: { action: 'accept', content: { env: 'staging' } } })
    expect(link.app.updates).toBe(0)
  })

  test('an Elicitation hook that blocks declines the request without queueing it', async () => {
    useHooks({ Elicitation: [{ matcher: 'tracker', reply: 'not this server', exit: 2 }] })
    const link = await connect('tracker')
    expect(await ask(link, URL_ASK)).toEqual({ result: { action: 'decline' } })
    expect(link.app.updates).toBe(0)
  })

  test('hooks are matched on the server name', async () => {
    useHooks({ Elicitation: [{ matcher: 'billing', exit: 2, log: 'billing.jsonl' }] })
    const link = await connect('tracker')
    const pending = ask(link, FORM)
    const [event] = await queued(link)
    event!.respond({ action: 'accept', content: { env: 'prod' } })
    expect(await pending).toEqual({ result: { action: 'accept', content: { env: 'prod' } } })
    expect(logged('billing.jsonl')).toEqual([])
  })

  test('the ElicitationResult hook sees the answer, and the response is announced', async () => {
    useHooks({
      ElicitationResult: [{ matcher: 'tracker', log: 'result.jsonl' }],
      Notification: [{ matcher: 'elicitation_response', log: 'notice.jsonl' }],
    })
    const link = await connect('tracker')
    const pending = ask(link, URL_ASK)
    const [event] = await queued(link)
    event!.respond({ action: 'decline' })
    expect(await pending).toEqual({ result: { action: 'decline' } })
    expect(eventFields(await loggedOnce('result.jsonl'))).toEqual({
      hook_event_name: 'ElicitationResult',
      mcp_server_name: 'tracker',
      elicitation_id: 'el-42',
      mode: 'url',
      action: 'decline',
    })
    expect(eventFields(await loggedOnce('notice.jsonl'))).toEqual({
      hook_event_name: 'Notification',
      message: 'Elicitation response for server "tracker": decline',
      notification_type: 'elicitation_response',
    })
  })

  test('the ElicitationResult hook may replace the answer the server receives', async () => {
    useHooks({
      ElicitationResult: [{ matcher: 'tracker', log: 'result.jsonl', reply: answer('ElicitationResult', 'accept', { env: 'staging' }) }],
      Notification: [{ matcher: 'elicitation_response', log: 'notice.jsonl' }],
    })
    const link = await connect('tracker')
    const pending = ask(link, FORM)
    const [event] = await queued(link)
    event!.respond({ action: 'accept', content: { env: 'prod', retries: 1 } })
    expect(await pending).toEqual({ result: { action: 'accept', content: { env: 'staging' } } })
    expect(eventFields(await loggedOnce('result.jsonl'))).toEqual({
      hook_event_name: 'ElicitationResult',
      mcp_server_name: 'tracker',
      mode: 'form',
      action: 'accept',
      content: { env: 'prod', retries: 1 },
    })
    expect((await loggedOnce('notice.jsonl')).message).toBe('Elicitation response for server "tracker": accept')
  })

  test('an ElicitationResult hook that blocks turns any answer into decline', async () => {
    useHooks({
      ElicitationResult: [{ matcher: 'tracker', exit: 2 }],
      Notification: [{ matcher: 'elicitation_response', log: 'notice.jsonl' }],
    })
    const link = await connect('tracker')
    const pending = ask(link, FORM)
    const [event] = await queued(link)
    event!.respond({ action: 'accept', content: { env: 'prod' } })
    expect(await pending).toEqual({ result: { action: 'decline' } })
    expect((await loggedOnce('notice.jsonl')).message).toBe('Elicitation response for server "tracker": decline')
  })
})

// --- the hook runners, as the tool-call and headless paths use them -----------------

describe('runElicitationHooks', () => {
  const params = FORM as unknown as ElicitRequestParams
  const outcomes: Array<{ hook: HookSpec | null; expected: ElicitResult | undefined }> = [
    { hook: null, expected: undefined },
    { hook: {}, expected: undefined },
    { hook: { reply: 'plain words' }, expected: undefined },
    { hook: { reply: { hookSpecificOutput: { hookEventName: 'ElicitationResult', action: 'accept' } } }, expected: undefined },
    { hook: { reply: { hookSpecificOutput: { hookEventName: 'Elicitation' } } }, expected: undefined },
    { hook: { reply: answer('Elicitation', 'accept', { env: 'prod' }) }, expected: { action: 'accept', content: { env: 'prod' } } },
    { hook: { reply: answer('Elicitation', 'cancel') }, expected: { action: 'cancel' } },
    { hook: { reply: answer('Elicitation', 'decline', { env: 'prod' }) }, expected: { action: 'decline' } },
    { hook: { reply: { decision: 'block', reason: 'policy' } }, expected: { action: 'decline' } },
    { hook: { exit: 2 }, expected: { action: 'decline' } },
  ]
  for (const { hook, expected } of outcomes) {
    test(`a hook ${JSON.stringify(hook)} gives ${JSON.stringify(expected)}`, async () => {
      if (hook) useHooks({ Elicitation: [{ matcher: 'tracker', ...hook }] })
      const result = await runElicitationHooks('tracker', params, new AbortController().signal)
      expect(result).toEqual(expected)
      if (expected) expect(Object.keys(result!).filter(key => result![key as keyof ElicitResult] !== undefined)).toEqual(Object.keys(expected))
    })
  }

  test('a request without a mode is reported to the hook as form; a URL one with its link and id', async () => {
    useHooks({ Elicitation: [{ matcher: 'tracker', log: 'asked.jsonl' }] })
    const signal = new AbortController().signal
    await runElicitationHooks('tracker', { message: 'm', requestedSchema: { type: 'object', properties: {} } } as never, signal)
    await runElicitationHooks('tracker', URL_ASK as unknown as ElicitRequestParams, signal)
    expect(logged('asked.jsonl').map(input => [input.mode, input.url, input.elicitation_id, input.requested_schema])).toEqual([
      ['form', undefined, undefined, { type: 'object', properties: {} }],
      ['url', URL_ASK.url, 'el-42', undefined],
    ])
  })
})

describe('runElicitationResultHooks', () => {
  const given: ElicitResult = { action: 'accept', content: { env: 'prod', retries: 2 } }
  const outcomes: Array<{ hook: HookSpec | null; expected: ElicitResult }> = [
    { hook: null, expected: given },
    { hook: { reply: 'plain words' }, expected: given },
    { hook: { reply: answer('ElicitationResult', 'accept', { env: 'staging' }) }, expected: { action: 'accept', content: { env: 'staging' } } },
    { hook: { reply: answer('ElicitationResult', 'cancel') }, expected: { action: 'cancel', content: given.content } },
    { hook: { reply: answer('ElicitationResult', 'decline', { env: 'staging' }) }, expected: { action: 'decline' } },
    { hook: { reply: { decision: 'block' } }, expected: { action: 'decline' } },
    { hook: { exit: 2 }, expected: { action: 'decline' } },
  ]
  for (const { hook, expected } of outcomes) {
    test(`a hook ${JSON.stringify(hook)} gives ${JSON.stringify(expected)}, and that action is announced`, async () => {
      useHooks({
        ...(hook && { ElicitationResult: [{ matcher: 'tracker', ...hook }] }),
        Notification: [{ matcher: 'elicitation_response', log: 'notice.jsonl' }],
      })
      const result = await runElicitationResultHooks('tracker', given, new AbortController().signal)
      expect(result).toEqual(expected)
      expect((await loggedOnce('notice.jsonl')).message).toBe(`Elicitation response for server "tracker": ${expected.action}`)
    })
  }

  test('the mode and id given are passed to the hook; without them the hook sees neither', async () => {
    useHooks({ ElicitationResult: [{ matcher: 'tracker', log: 'result.jsonl' }] })
    const signal = new AbortController().signal
    await runElicitationResultHooks('tracker', { action: 'cancel' }, signal, 'url', 'el-9')
    await runElicitationResultHooks('tracker', given, signal)
    expect(logged('result.jsonl').map(eventFields)).toEqual([
      { hook_event_name: 'ElicitationResult', mcp_server_name: 'tracker', elicitation_id: 'el-9', mode: 'url', action: 'cancel' },
      { hook_event_name: 'ElicitationResult', mcp_server_name: 'tracker', action: 'accept', content: given.content },
    ])
  })
})
