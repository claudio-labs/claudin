import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { runWithAgentContext } from 'src/agent/coordinator/agentContext.js'
import { stopMonitorMcpTask } from 'src/agent/tasks/MonitorMcpTask/MonitorMcpTask.js'
import {
  type MonitorMcpTaskDeps,
  type RegisterMonitorMcpTaskInput,
  registerMonitorMcpTask,
} from 'src/agent/tasks/MonitorMcpTask/registerMonitorMcpTask.js'
import {
  callMCPToolWithUrlElicitationRetry,
  type McpTaskCallDeps,
  taskResultSummary,
} from 'src/mcp/client/callTool.js'
import { connectToServer, getServerCacheKey, listRootsResult } from 'src/mcp/client/connection.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import type { ConnectedMCPServer, MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { _setSecureStorageForTesting } from 'src/platform/secureStorage/index.js'
import type { QueuedCommand } from 'src/shared/types/textInputTypes.js'
import type { AppState } from 'src/terminal/state/AppState.js'
import { waitUntil } from 'src/mcp/__testutils__/elicitationHarness.js'
import { type ModernFixture, serveLegacy, serveModern } from 'src/mcp/__testutils__/eraServers.js'
import { connectRawMcpServer, type RawMcpServer } from 'src/mcp/__testutils__/rawMcpServer.js'

/*
 * Task-augmented tool calls (SEP-2663) end to end: a 2026-07-28 server
 * reached through connectToServer answers tools/call with a task and
 * tasks/get with a scripted status, and callMCPToolWithUrlElicitationRetry
 * polls it inline or hands it to a monitor_mcp task. The clock is fake (each
 * sleep advances it), the server and the SDK are real.
 */

const macroHost = globalThis as Record<string, unknown>
let savedMacro: unknown
let fixture: { stop: () => Promise<void> } | undefined
let raw: RawMcpServer | undefined
const connections: MCPServerConnection[] = []

beforeEach(() => {
  savedMacro = macroHost.MACRO
  macroHost.MACRO = { ...(savedMacro as Record<string, unknown> | undefined), VERSION: '0.0.0-test' }
  _setSecureStorageForTesting({
    name: 'memory',
    read: () => ({}),
    readAsync: async () => ({}),
    update: () => ({ success: true }),
    delete: () => true,
  })
})

afterEach(async () => {
  for (const connection of connections.splice(0)) {
    if (connection.type === 'connected') await connection.cleanup().catch(() => {})
    connectToServer.cache.delete(getServerCacheKey(connection.name, connection.config))
  }
  await fixture?.stop()
  fixture = undefined
  await raw?.close()
  raw = undefined
  _setSecureStorageForTesting(null)
  if (savedMacro === undefined) delete macroHost.MACRO
  else macroHost.MACRO = savedMacro
})

const CREATED = '2026-11-27T00:00:00.000Z'
const BASE = { taskId: 'srv-task-1', createdAt: CREATED, lastUpdatedAt: CREATED, ttlMs: 3_600_000 }
const DONE = {
  status: 'completed',
  result: { content: [{ type: 'text', text: 'indexed 42 files' }] },
}

type Step = Record<string, unknown>
type Params = Record<string, unknown> | undefined

/** A modern server whose `longjob` is a task; `next` answers each tasks/get. */
function serveTasks(next: (gets: number, updates: Params[]) => Step) {
  const seen = { gets: 0, updates: [] as Params[], cancels: [] as Params[], call: undefined as Params }
  const reply = (id: unknown, result: Record<string, unknown>) => Response.json({ jsonrpc: '2.0', id, result })
  const modern: ModernFixture = serveModern(
    server =>
      server.registerTool('longjob', { description: 'slow', inputSchema: z.object({}) }, async () => ({
        content: [{ type: 'text', text: 'not a task' }],
      })),
    {
      answer: body => {
        const params = body?.params as Params
        switch (body?.method) {
          case 'tools/call':
            if (params?.name !== 'longjob') return undefined
            seen.call = params
            return reply(body.id, { resultType: 'task', ...BASE, status: 'working', pollIntervalMs: 10 })
          case 'tasks/get':
            seen.gets++
            return reply(body.id, { resultType: 'complete', cacheScope: 'private', ...BASE, ...next(seen.gets, seen.updates) })
          case 'tasks/update':
            seen.updates.push(params)
            // No ttlMs/cacheScope: wireRules fills them, or the SDK rejects it.
            return reply(body.id, { resultType: 'complete' })
          case 'tasks/cancel':
            seen.cancels.push(params)
            return reply(body.id, { resultType: 'complete', ...BASE, status: 'cancelled' })
          default:
            return undefined
        }
      },
    },
  )
  fixture = modern
  return { modern, seen }
}

async function connect(name: string, config: ScopedMcpServerConfig): Promise<ConnectedMCPServer> {
  const connection = await connectToServer(name, config)
  connections.push(connection)
  if (connection.type !== 'connected') {
    throw new Error(`expected connected, got ${connection.type}: ${'error' in connection ? connection.error : ''}`)
  }
  return connection
}

/** The AppState slices the call touches: the elicitation queue and the task rows. */
function world() {
  let state = {
    tasks: {},
    elicitation: { queue: [] },
    speculation: { status: 'idle' },
  } as unknown as AppState
  const setAppState = (f: (prev: AppState) => AppState) => {
    state = f(state)
  }
  return { get: () => state, setAppState }
}

/** A fake clock that each sleep advances, plus a monitor_mcp registry on fake disk and queue. */
function harness(over: Partial<McpTaskCallDeps> = {}) {
  let clock = 1_000_000
  const output: string[] = []
  const queued: QueuedCommand[] = []
  const registered: RegisterMonitorMcpTaskInput[] = []
  const monitorDeps: MonitorMcpTaskDeps = {
    initOutput: async () => undefined,
    appendOutput: (_id, text) => output.push(text),
    flushOutput: async () => {},
    enqueue: command => queued.push(command),
    registerCleanup: () => () => {},
  }
  const deps: Partial<McpTaskCallDeps> = {
    now: () => clock,
    sleep: async ms => {
      clock += ms
      await new Promise(resolve => setTimeout(resolve, 1))
    },
    inlineMs: () => 5_000,
    isBackgroundHidden: () => false,
    registerTask: input => {
      registered.push(input)
      return registerMonitorMcpTask(input, monitorDeps)
    },
    ...over,
  }
  return { deps, output, queued, registered }
}

function call(
  connection: ConnectedMCPServer,
  box: ReturnType<typeof world>,
  deps: Partial<McpTaskCallDeps>,
  signal: AbortSignal = new AbortController().signal,
  extra: Partial<Parameters<typeof callMCPToolWithUrlElicitationRetry>[0]> = {},
) {
  return callMCPToolWithUrlElicitationRetry({
    client: connection,
    clientConnection: connection,
    tool: 'longjob',
    args: {},
    meta: { 'claudecode/toolUseId': 'toolu_task' },
    signal,
    setAppState: box.setAppState,
    taskDeps: deps,
    ...extra,
  })
}

describe('a 2026-07-28 task-augmented tool call', () => {
  test('declares the tasks extension, polls a working task and returns its result inline', async () => {
    const { modern, seen } = serveTasks(gets => (gets < 3 ? { status: 'working', statusMessage: `step ${gets}` } : DONE))
    const connection = await connect('tasks-inline', { type: 'http', url: modern.url, scope: 'user' })
    expect(connection.client.getProtocolEra()).toBe('modern')
    const { deps, registered } = harness()
    const progress: string[] = []

    const result = await call(connection, world(), deps, undefined, {
      onProgress: data => progress.push(String(data.progressMessage)),
    })

    expect(result.content).toEqual([{ type: 'text', text: 'indexed 42 files' }])
    expect(seen.gets).toBe(3)
    expect(progress).toEqual(['step 1', 'step 2'])
    expect(registered).toEqual([])
    const capabilities = JSON.stringify(seen.call?._meta)
    expect(capabilities).toContain('io.modelcontextprotocol/tasks')
  })

  test('without the extension a modern client does not declare it', async () => {
    const { modern, seen } = serveTasks(() => DONE)
    const connection = await connect('tasks-off', {
      type: 'http',
      url: modern.url,
      scope: 'user',
      extensions: { tasks: false },
    } as ScopedMcpServerConfig)
    await call(connection, world(), harness().deps)
    expect(JSON.stringify(seen.call?._meta)).not.toContain('io.modelcontextprotocol/tasks')
  })

  test('input_required asks through the elicitation dialog once and sends the answer with tasks/update', async () => {
    const ask = {
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: 'Overwrite the index?',
        requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
    }
    // The server still lists the request on the first poll after the update.
    const { modern, seen } = serveTasks((gets, updates) =>
      updates.length === 0 || gets <= 2 ? { status: 'input_required', inputRequests: { confirm: ask } } : DONE,
    )
    const connection = await connect('tasks-input', { type: 'http', url: modern.url, scope: 'user' })
    const box = world()
    const pending = call(connection, box, harness().deps)

    await waitUntil(() => box.get().elicitation.queue.length === 1, 'the elicitation dialog')
    const event = box.get().elicitation.queue[0]!
    expect(event.serverName).toBe('tasks-input')
    expect(event.params.message).toBe('Overwrite the index?')
    event.respond({ action: 'accept', content: { ok: true } })

    expect((await pending).content).toEqual([{ type: 'text', text: 'indexed 42 files' }])
    expect(seen.updates).toHaveLength(1)
    expect(seen.updates[0]).toMatchObject({
      taskId: 'srv-task-1',
      inputResponses: { confirm: { action: 'accept', content: { ok: true } } },
    })
    expect(box.get().elicitation.queue).toHaveLength(1)
  })

  test('in print mode the input goes to handleElicitation instead of the dialog', async () => {
    const ask = { method: 'elicitation/create', params: { mode: 'form', message: 'Name?', requestedSchema: { type: 'object', properties: {} } } }
    const { modern, seen } = serveTasks((_gets, updates) =>
      updates.length === 0 ? { status: 'input_required', inputRequests: { who: ask } } : DONE,
    )
    const connection = await connect('tasks-print', { type: 'http', url: modern.url, scope: 'user' })
    const box = world()
    const asked: string[] = []
    await call(connection, box, harness().deps, undefined, {
      handleElicitation: async (serverName, params) => {
        asked.push(`${serverName}: ${params.message}`)
        return { action: 'decline' }
      },
    })
    expect(asked).toEqual(['tasks-print: Name?'])
    expect(seen.updates[0]?.inputResponses).toEqual({ who: { action: 'decline' } })
    expect(box.get().elicitation.queue).toHaveLength(0)
  })

  test('a failed task is a tool error with the server message', async () => {
    const { modern } = serveTasks(() => ({ status: 'failed', error: { code: -32603, message: 'disk full' } }))
    const connection = await connect('tasks-failed', { type: 'http', url: modern.url, scope: 'user' })
    const error = await call(connection, world(), harness().deps).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('disk full')
  })

  test('aborting the call sends tasks/cancel', async () => {
    const { modern, seen } = serveTasks(() => ({ status: 'working' }))
    const connection = await connect('tasks-abort', { type: 'http', url: modern.url, scope: 'user' })
    const controller = new AbortController()
    const pending = call(connection, world(), harness({ isBackgroundHidden: () => true }).deps, controller.signal)
    await waitUntil(() => seen.gets >= 2, 'two polls')
    controller.abort()
    expect((await pending).content).toBeUndefined()
    expect(seen.cancels).toHaveLength(1)
    expect(seen.cancels[0]).toMatchObject({ taskId: 'srv-task-1' })
  })

  test('on the main thread a task past the timer moves to a monitor_mcp task that notifies at the end', async () => {
    let finished = false
    const { modern, seen } = serveTasks(() => (finished ? DONE : { status: 'working', statusMessage: 'crawling' }))
    const connection = await connect('tasks-bg', { type: 'http', url: modern.url, scope: 'user' })
    const box = world()
    const { deps, output, queued, registered } = harness()

    const result = await call(connection, box, deps)

    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({ kind: 'call', serverName: 'tasks-bg', description: 'longjob', toolUseId: 'toolu_task' })
    const taskId = Object.keys(box.get().tasks)[0]!
    const row = box.get().tasks[taskId] as unknown as { status: string; statusMessage?: string; outputFile: string }
    expect(row.status).toBe('running')
    expect(row.statusMessage).toBe('crawling')
    expect(result.content).toBe(
      `Tool "longjob" on MCP server "tasks-bg" is still running as an MCP task and was moved to the background with ID: ${taskId}. You will be notified when it completes. Output is being written to: ${row.outputFile}`,
    )
    // 1 s (the floor over the call's 10 ms), then the 2 s default, cut at 5 s.
    expect(seen.gets).toBe(3)

    finished = true
    await waitUntil(() => queued.length === 1, 'the task notification')
    expect(queued[0]!.mode).toBe('task-notification')
    expect(String(queued[0]!.value)).toContain('<status>completed</status>')
    expect(String(queued[0]!.value)).toContain('<summary>MCP task "longjob" on server "tasks-bg" completed: indexed 42 files</summary>')
    expect(output.join('')).toContain('indexed 42 files\n')
    expect((box.get().tasks[taskId] as unknown as { status: string }).status).toBe('completed')
    expect(seen.cancels).toEqual([])
  })

  test('a background task that fails notifies failed, its progress and error in the output', async () => {
    let phase = 'start'
    const { modern } = serveTasks(() =>
      phase === 'start'
        ? { status: 'working', statusMessage: 'crawling' }
        : phase === 'later'
          ? { status: 'working', statusMessage: 'indexing' }
          : { status: 'failed', error: { code: -32603, message: 'disk full' } },
    )
    const connection = await connect('tasks-bg-fail', { type: 'http', url: modern.url, scope: 'user' })
    const box = world()
    const { deps, output, queued } = harness()
    await call(connection, box, deps)
    const taskId = Object.keys(box.get().tasks)[0]!

    phase = 'later'
    await waitUntil(
      () => (box.get().tasks[taskId] as unknown as { statusMessage?: string }).statusMessage === 'indexing',
      'the new status line',
    )
    phase = 'end'
    await waitUntil(() => queued.length === 1, 'the task notification')
    expect(String(queued[0]!.value)).toContain('<status>failed</status>')
    expect(String(queued[0]!.value)).toContain('failed: disk full</summary>')
    expect(output).toContain('indexing\n')
    expect(output).toContain('disk full\n')
  })

  test('a roots/list input request gets the roots the connection answers, and the task completes', async () => {
    const { modern, seen } = serveTasks((_gets, updates) =>
      updates.length === 0 ? { status: 'input_required', inputRequests: { where: { method: 'roots/list' } } } : DONE,
    )
    const connection = await connect('tasks-roots', { type: 'http', url: modern.url, scope: 'user' })
    const box = world()
    expect((await call(connection, box, harness().deps)).content).toEqual([{ type: 'text', text: 'indexed 42 files' }])
    expect(seen.updates).toHaveLength(1)
    expect(seen.updates[0]?.inputResponses).toEqual({ where: listRootsResult() })
    expect(listRootsResult()).toEqual({ roots: [{ uri: `file://${getOriginalCwd()}` }] })
    expect(box.get().elicitation.queue).toHaveLength(0)
  })

  test('an input request Claudin does not support cancels the task once and fails the call naming it', async () => {
    const sampling = { method: 'sampling/createMessage', params: { messages: [], maxTokens: 10 } }
    const { modern, seen } = serveTasks(() => ({ status: 'input_required', inputRequests: { llm: sampling } }))
    const connection = await connect('tasks-sampling', { type: 'http', url: modern.url, scope: 'user' })
    const box = world()
    const error = await call(connection, box, harness().deps).catch((e: unknown) => e)
    expect((error as Error).message).toBe(
      'the MCP server asked for sampling/createMessage, which Claudin does not support',
    )
    expect(seen.gets).toBe(1)
    expect(seen.cancels).toHaveLength(1)
    expect(seen.cancels[0]).toMatchObject({ taskId: 'srv-task-1' })
    expect(seen.updates).toEqual([])
    expect(box.get().elicitation.queue).toHaveLength(0)
  })

  test('a task that completes without a result is an error', async () => {
    const { modern } = serveTasks(() => ({ status: 'completed' }))
    const connection = await connect('tasks-empty', { type: 'http', url: modern.url, scope: 'user' })
    await expect(call(connection, world(), harness().deps)).rejects.toThrow('the task completed without a result')
  })

  test('stopping the background task sends tasks/cancel and no notification', async () => {
    const { modern, seen } = serveTasks(() => ({ status: 'working' }))
    const connection = await connect('tasks-stop', { type: 'http', url: modern.url, scope: 'user' })
    const box = world()
    const { deps, queued } = harness()
    await call(connection, box, deps)
    const taskId = Object.keys(box.get().tasks)[0]!

    await stopMonitorMcpTask(taskId, box.setAppState)

    expect(seen.cancels).toHaveLength(1)
    expect(seen.cancels[0]).toMatchObject({ taskId: 'srv-task-1' })
    expect((box.get().tasks[taskId] as unknown as { status: string }).status).toBe('killed')
    expect(queued).toEqual([])
  })

  test('in a sub-agent, or where background tasks are off, the same task is polled inline to the end', async () => {
    const { modern, seen } = serveTasks(gets => (gets < 12 ? { status: 'working' } : DONE))
    const connection = await connect('tasks-sub', { type: 'http', url: modern.url, scope: 'user' })
    const sub = harness()
    const result = await runWithAgentContext({ agentId: 'a-sub-1', agentType: 'subagent' }, () =>
      call(connection, world(), sub.deps),
    )
    expect(result.content).toEqual([{ type: 'text', text: 'indexed 42 files' }])
    expect(seen.gets).toBe(12)
    expect(sub.registered).toEqual([])

    const print = harness({ isBackgroundHidden: () => true })
    seen.gets = 0
    await call(connection, world(), print.deps)
    expect(print.registered).toEqual([])
  })

  test('without a background, a task past the tool timeout is cancelled and fails as a timed-out call', async () => {
    const { modern, seen } = serveTasks(() => ({ status: 'working' }))
    const connection = await connect('tasks-sub-timeout', {
      type: 'http',
      url: modern.url,
      scope: 'user',
      toolTimeout: 3_000,
    } as ScopedMcpServerConfig)
    const sub = harness()
    const error = await runWithAgentContext({ agentId: 'a-sub-2', agentType: 'subagent' }, () =>
      call(connection, world(), sub.deps),
    ).catch((e: unknown) => e)
    expect((error as Error).message).toBe('MCP server "tasks-sub-timeout" tool "longjob" timed out after 3s')
    expect(seen.cancels).toHaveLength(1)
    expect(seen.cancels[0]).toMatchObject({ taskId: 'srv-task-1' })
    expect(sub.registered).toEqual([])
  })

  test('on the main thread the inline window is never past the tool timeout', async () => {
    const { modern, seen } = serveTasks(() => ({ status: 'working' }))
    const connection = await connect('tasks-short-timeout', {
      type: 'http',
      url: modern.url,
      scope: 'user',
      toolTimeout: 2_000,
    } as ScopedMcpServerConfig)
    const box = world()
    const { deps, registered } = harness({ inlineMs: () => 120_000 })
    await call(connection, box, deps)
    expect(registered).toHaveLength(1)
    // Backgrounded at 2 s: polls at 1 s (the floor) and at 2 s.
    expect(seen.gets).toBe(2)
    await stopMonitorMcpTask(Object.keys(box.get().tasks)[0]!, box.setAppState)
  })
})

describe('taskResultSummary', () => {
  test("is the result's first text on one line, cut at 200 characters", () => {
    expect(taskResultSummary('done\n  in 3s')).toBe('done in 3s')
    expect(taskResultSummary([{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }])).toBe('first')
    expect(taskResultSummary(undefined)).toBe('')
    const long = taskResultSummary('x'.repeat(500))
    expect(long).toHaveLength(200)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('the 2025 protocol', () => {
  test('a legacy initialize never declares the tasks extension', async () => {
    const legacy = serveLegacy()
    fixture = legacy
    await connect('tasks-legacy', { type: 'http', url: legacy.url, scope: 'user' })
    expect(legacy.initializeCapabilities()).toEqual([{ roots: {}, elicitation: {} }])
  })

  test('a task from a server that was never told of the extension is still polled', async () => {
    raw = await connectRawMcpServer('tasks-undeclared', {
      capabilities: { tools: {} },
      answers: {
        'tools/call': () => ({ resultType: 'task', ...BASE, status: 'working' }),
        'tasks/get': () => ({ ...BASE, ...DONE }),
      },
    })
    const result = await call(raw.connection, world(), harness().deps)
    expect(result.content).toEqual([{ type: 'text', text: 'indexed 42 files' }])
    expect(raw.requests.map(r => r.method)).toEqual(['tools/call', 'tasks/get'])
  })
})
