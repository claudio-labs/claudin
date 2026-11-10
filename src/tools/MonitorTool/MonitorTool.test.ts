import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { getCommandQueue, resetCommandQueue } from 'src/agent/messageQueueManager.js'
import { getTaskOutputPath } from 'src/agent/tasks/diskOutput.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import { MonitorTool } from 'src/tools/MonitorTool/MonitorTool.js'
import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'
import type { ToolPermissionContext, ToolUseContext } from 'src/tools/Tool.js'

beforeAll(() => {
  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: 'test',
  }
})

function makeStateHarness(): {
  setAppState: (f: (prev: AppState) => AppState) => void
  getState: () => AppState
} {
  let state = getDefaultAppState()
  return {
    setAppState: updater => {
      state = updater(state)
    },
    getState: () => state,
  }
}

async function waitForNotification(
  matches: (value: string) => boolean,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = getCommandQueue()
      .map(c => String(c.value))
      .find(matches)
    if (hit !== undefined) return hit
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(
    `no matching notification within ${timeoutMs}ms; queue: ${JSON.stringify(getCommandQueue().map(c => c.value))}`,
  )
}

// A command still running when its test fails would notify into the next test.
function stopCommand(state: AppState, taskId: string): void {
  const task = state.tasks[taskId] as { shellCommand?: { kill(): void } | null } | undefined
  task?.shellCommand?.kill()
}

describe('MonitorTool', () => {
  test('isConcurrencySafe is true and userFacingName is Monitor', () => {
    expect(MonitorTool.isConcurrencySafe?.()).toBe(true)
    expect(MonitorTool.userFacingName()).toBe('Monitor')
  })

  test('input schema requires command and description', () => {
    expect(MonitorTool.inputSchema.safeParse({}).success).toBe(false)
    expect(
      MonitorTool.inputSchema.safeParse({ command: 'ls' }).success,
    ).toBe(false)
    expect(
      MonitorTool.inputSchema.safeParse({
        command: 'ls',
        description: 'list files',
      }).success,
    ).toBe(true)
  })

  test('input schema rejects unknown keys (strict)', () => {
    expect(
      MonitorTool.inputSchema.safeParse({
        command: 'ls',
        description: 'd',
        extra: 1,
      }).success,
    ).toBe(false)
  })

  test('toAutoClassifierInput returns the raw command', () => {
    expect(
      MonitorTool.toAutoClassifierInput?.({
        command: 'ls /tmp',
        description: 'list',
      } as never),
    ).toBe('ls /tmp')
  })

  test('description() falls back when input omits a description', async () => {
    expect(await MonitorTool.description({ command: 'ls' } as never)).toBe(
      'Monitor shell command',
    )
    expect(
      await MonitorTool.description({
        command: 'ls',
        description: 'list files',
      } as never),
    ).toBe('list files')
  })

  test('getToolUseSummary prefers description, falls back to command', () => {
    expect(
      MonitorTool.getToolUseSummary?.({
        command: 'ls',
        description: 'list files',
      } as never),
    ).toBe('list files')
    expect(
      MonitorTool.getToolUseSummary?.({ command: 'ls' } as never),
    ).toBe('ls')
  })

  test('getActivityDescription frames description as "Monitoring X"', () => {
    expect(
      MonitorTool.getActivityDescription?.({
        command: 'ls',
        description: 'logs',
      } as never),
    ).toBe('Monitoring logs')
    expect(MonitorTool.getActivityDescription?.({} as never)).toBe(
      'Starting monitor',
    )
  })

  test('mapToolResultToToolResultBlockParam references the task id and output path', () => {
    const block = MonitorTool.mapToolResultToToolResultBlockParam?.(
      { taskId: 'tsk_1', outputFile: '/tmp/out.log' },
      'u1',
    )
    expect(block?.content).toContain('tsk_1')
    expect(block?.content).toContain('/tmp/out.log')
    expect(block?.content).toContain('TaskStop')
  })

  test('preparePermissionMatcher matches every pattern', async () => {
    const match = await MonitorTool.preparePermissionMatcher?.({
      command: 'tail -f log',
      description: 'd',
    } as never)
    expect(match?.('anything')).toBe(true)
    expect(match?.('')).toBe(true)
  })

  test('the prompt points one-shot waits at Bash run_in_background', async () => {
    const prompt = await MonitorTool.prompt()
    expect(prompt).toContain('run_in_background')
  })

  test('the prompt carries the choice table and the pipeline traps', async () => {
    const prompt = await MonitorTool.prompt()
    expect(prompt).toContain('Pick by how many notifications you need:')
    expect(prompt).toContain('One per occurrence, until a known end')
    expect(prompt).toContain('`tail -f app.log | grep -m 1 Ready` does not fix that')
    expect(prompt).toContain('`| head -N` cannot flush')
    expect(prompt).toContain('print every terminal state')
    expect(prompt).toContain('`curl … || true`')
    expect(prompt).toContain('every notification is titled with it')
    // Claudin's stream carries stderr; Claude Code's "only stdout" advice is not true here.
    expect(prompt).toContain('stdout and stderr together')
    expect(prompt).not.toContain('Only stdout')
  })

  test('renderToolUseMessage joins description and command, else shows whichever is set', () => {
    const render = (input: object) => MonitorTool.renderToolUseMessage(input as never)
    expect(render({ command: 'tail -f a.log', description: 'app log' })).toBe(
      'app log: tail -f a.log',
    )
    expect(render({ command: 'tail -f a.log' })).toBe('tail -f a.log')
    expect(render({ description: 'app log' })).toBe('app log')
    expect(render({})).toBe('')
  })

  test('renderToolResultMessage names the task', () => {
    expect(
      MonitorTool.renderToolResultMessage?.({ taskId: 'tsk_9', outputFile: '/tmp/o' }),
    ).toBe('Monitor started (task tsk_9)')
  })

  test('a non-allow Bash verdict is returned as is', async () => {
    const context = {
      abortController: new AbortController(),
      options: { isNonInteractiveSession: false },
      getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
    } as unknown as ToolUseContext
    const result = await MonitorTool.checkPermissions(
      { command: 'rm -rf /tmp/monitor-cover-probe', description: 'd' },
      context,
    )
    expect(result.behavior).not.toBe('allow')
  })

  // Same contract as WaitFor: Bash's `updatedInput` is `{ command }`, and the
  // harness applies it verbatim — `description` would not survive the allow.
  test('on allow it hands back its own input, never the Bash-shaped one', async () => {
    const toolPermissionContext: ToolPermissionContext = {
      ...getEmptyToolPermissionContext(),
      alwaysAllowRules: { cliArg: ['Bash(echo:*)'] },
    }
    const context = {
      abortController: new AbortController(),
      options: { isNonInteractiveSession: false },
      getAppState: () => ({ toolPermissionContext }),
    } as unknown as ToolUseContext
    const input = { command: 'echo hi', description: 'watch the greeting' }
    const result = await MonitorTool.checkPermissions(input, context)
    expect(result.behavior).toBe('allow')
    if (result.behavior === 'allow') {
      expect(result.updatedInput).toBe(input)
    }
  })
})

describe('MonitorTool.call', () => {
  beforeEach(() => resetCommandQueue())
  afterEach(() => resetCommandQueue())

  test('registers a background monitor task and notifies when the command exits', async () => {
    const harness = makeStateHarness()
    const context = {
      abortController: new AbortController(),
      setAppState: harness.setAppState,
      toolUseId: 'toolu_monitor_call',
    } as unknown as ToolUseContext

    const result = await MonitorTool.call(
      { command: "printf 'one\\n'", description: 'print one line' },
      context,
    )
    const { taskId, outputFile } = result.data
    expect(outputFile).toBe(getTaskOutputPath(taskId))
    const task = harness.getState().tasks[taskId]
    expect(task).toMatchObject({ type: 'local_bash', kind: 'monitor' })

    const exit = await waitForNotification(n => n.includes(taskId) && n.includes('<status>'))
    expect(exit).toContain(taskId)
    expect(exit).toContain('<status>completed</status>')
  }, 15_000)

  // The prompt promises output while the command runs; until 11-01 only the
  // exit notice ever reached the model.
  test('delivers output lines while the command is still running', async () => {
    const harness = makeStateHarness()
    const context = {
      abortController: new AbortController(),
      setAppState: harness.setAppState,
      toolUseId: 'toolu_monitor_stream',
    } as unknown as ToolUseContext

    const result = await MonitorTool.call(
      { command: "printf 'first-event\\n'; sleep 4; printf 'second-event\\n'", description: 'two events' },
      context,
    )
    const { taskId } = result.data
    try {
      const event = await waitForNotification(n => n.includes('first-event'), 3_000)
      expect(event).toContain(taskId)
      expect(event).not.toContain('<status>')
      expect(harness.getState().tasks[taskId]?.status).toBe('running')

      await waitForNotification(n => n.includes(taskId) && n.includes('<status>'), 10_000)
      const second = getCommandQueue()
        .map(c => String(c.value))
        .filter(v => v.includes('second-event'))
      expect(second).toHaveLength(1)
    } finally {
      stopCommand(harness.getState(), taskId)
    }
  }, 20_000)

  test('input schema accepts timeout_ms', () => {
    expect(
      MonitorTool.inputSchema.safeParse({ command: 'ls', description: 'd', timeout_ms: 60_000 }).success,
    ).toBe(true)
  })

  // Review round, PR #337: models quote numbers; Bash timeout and WaitFor take
  // "60000", and Monitor refused it.
  test('timeout_ms accepts a quoted number, like Bash timeout', () => {
    const parsed = MonitorTool.inputSchema.safeParse({ command: 'ls', description: 'd', timeout_ms: '60000' })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.timeout_ms).toBe(60_000)
  })

  test('timeout_ms kills the monitor and says it expired', async () => {
    const harness = makeStateHarness()
    const context = {
      abortController: new AbortController(),
      setAppState: harness.setAppState,
      toolUseId: 'toolu_monitor_timeout',
    } as unknown as ToolUseContext

    const result = await MonitorTool.call(
      { command: 'sleep 30', description: 'never ends', timeout_ms: 1_000 },
      context,
    )
    const { taskId } = result.data
    try {
      const exit = await waitForNotification(n => n.includes(taskId) && n.includes('<status>'), 6_000)
      expect(exit).toContain('<status>killed</status>')
      expect(exit).toContain('expired')
    } finally {
      stopCommand(harness.getState(), taskId)
    }
  }, 15_000)
})

describe('MonitorTool ws source', () => {
  beforeEach(() => resetCommandQueue())
  afterEach(() => resetCommandQueue())

  const validate = (input: object) => MonitorTool.validateInput!(input as never)

  test('validateInput wants exactly one of command and ws, and a well-formed ws', async () => {
    expect(await validate({ description: 'd' })).toMatchObject({ result: false, message: 'Pass exactly one of `command` and `ws`.' })
    expect(await validate({ command: 'ls', ws: { url: 'wss://a.example' }, description: 'd' })).toMatchObject({ result: false })
    expect(await validate({ ws: { url: 'https://a.example' }, description: 'd' })).toMatchObject({ result: false, errorCode: 2 })
    expect(await validate({ ws: { url: 'wss://a.example/feed#x' }, description: 'd' })).toMatchObject({ result: false, errorCode: 2 })
    expect(await validate({ ws: { url: 'wss://93.184.216.34', protocols: ['v1'] }, description: 'd' })).toEqual({ result: true })
    expect(await validate({ command: 'ls', description: 'd' })).toEqual({ result: true })
  })

  // Before the permission step, so the user is never asked about a URL that
  // would then be refused.
  test('validateInput refuses a private address', async () => {
    expect(await validate({ ws: { url: 'ws://10.1.2.3:9000/feed' }, description: 'internal feed' })).toEqual({
      result: false,
      message: 'Monitor will not open ws://10.1.2.3:9000/feed: 10.1.2.3 is in a private, link-local or cloud-metadata range',
      errorCode: 3,
    })
    expect(await validate({ ws: { url: 'ws://127.0.0.1:9000/feed' }, description: 'local feed' })).toEqual({ result: true })
  })

  test('the schema takes a ws object and nothing else beside it', () => {
    expect(MonitorTool.inputSchema.safeParse({ ws: { url: 'wss://a.example' }, description: 'd' }).success).toBe(true)
    expect(MonitorTool.inputSchema.safeParse({ ws: { url: 'wss://a.example', extra: 1 }, description: 'd' }).success).toBe(false)
  })

  test('a ws source is always asked for, naming the URL and subprotocols, with no rule offered', async () => {
    const result = await MonitorTool.checkPermissions(
      { ws: { url: 'wss://events.example.com/stream', protocols: ['v1'] }, description: 'deploy events' },
      {} as ToolUseContext,
    )
    expect(result).toEqual({
      behavior: 'ask',
      message: 'Monitor will open a WebSocket to wss://events.example.com/stream (subprotocols: v1)',
    })
  })

  test('the classifier, the summary and the transcript line name the socket', () => {
    const input = { ws: { url: 'wss://events.example.com/stream' }, description: '' }
    expect(MonitorTool.toAutoClassifierInput?.(input as never)).toBe('websocket wss://events.example.com/stream')
    expect(MonitorTool.getToolUseSummary?.(input as never)).toBe('websocket wss://events.example.com/stream')
    expect(MonitorTool.renderToolUseMessage({ ...input, description: 'deploy events' } as never)).toBe(
      'deploy events: websocket wss://events.example.com/stream',
    )
  })

  test('the prompt describes the ws source', async () => {
    const prompt = await MonitorTool.prompt()
    expect(prompt).toContain('`ws` instead of `command` opens a WebSocket')
    expect(prompt).toContain('`[binary frame, N bytes]`')
    expect(prompt).toContain('a frame over 1 MiB closes the socket')
    expect(prompt).toContain('a `ws` monitor asks the user first unless the permission mode already allows it')
  })

  test('streams frames from a local socket and ends with the close', async () => {
    let peer: { send(data: string | Uint8Array): void; close(code?: number, reason?: string): void } | undefined
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response('no', { status: 400 })
      },
      websocket: {
        open(ws) {
          peer = ws
        },
        message() {},
      },
    })
    const harness = makeStateHarness()
    const context = {
      abortController: new AbortController(),
      setAppState: harness.setAppState,
      toolUseId: 'toolu_monitor_ws_local',
    } as unknown as ToolUseContext
    try {
      const result = await MonitorTool.call(
        { ws: { url: `ws://127.0.0.1:${server.port}/feed` }, description: 'local feed' },
        context,
      )
      const { taskId } = result.data
      expect(harness.getState().tasks[taskId]).toMatchObject({ kind: 'monitor', command: `websocket ws://127.0.0.1:${server.port}/feed` })
      const deadline = Date.now() + 5_000
      while (!peer && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
      peer!.send('build 42 passed')
      // Not valid UTF-8: decoded, these four bytes would count as ten.
      peer!.send(new Uint8Array([0xff, 0xfe, 0x00, 0x80]))
      const event = await waitForNotification(n => n.includes('build 42 passed'), 5_000)
      expect(event).toContain(taskId)
      expect(event).toContain('Monitor "local feed" output')

      peer!.close(1000, 'bye')
      const exit = await waitForNotification(n => n.includes(taskId) && n.includes('<status>'), 8_000)
      expect(exit).toContain('<status>completed</status>')
      const all = getCommandQueue().map(c => String(c.value)).join('\n')
      expect(all).toContain('[binary frame, 4 bytes]')
      expect(all).toContain('[WebSocket closed: 1000 bye]')
    } finally {
      server.stop(true)
    }
  }, 20_000)
})
