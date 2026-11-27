import { describe, expect, test } from 'bun:test'
import {
  cancelPolledTask,
  inlineTaskBudgetMs,
  MCP_TASK_INLINE_MS,
  type McpTask,
  pollDelayMs,
  pollTask,
  readTaskMarker,
  startTaskPoll,
  TASK_POLL_CAP_MS,
  TASK_POLL_DEFAULT_MS,
  TASK_POLL_FLOOR_MS,
  taskFailureMessage,
  type TaskPollDeps,
  taskStep,
  unsupportedTaskInputMessage,
} from 'src/mcp/client/taskPoll.js'
import { MCP_TASK_META_KEY } from 'src/mcp/client/wireRules.js'

const working: McpTask = { taskId: 't1', status: 'working', pollIntervalMs: 1_000 }
const ask = { method: 'elicitation/create', params: { message: 'ok?' } }

describe('readTaskMarker', () => {
  test('reads the task the wire rule left in _meta', () => {
    expect(readTaskMarker({ [MCP_TASK_META_KEY]: { taskId: 't1', status: 'working', ttlMs: 5 } })).toEqual({
      taskId: 't1',
      status: 'working',
      ttlMs: 5,
    })
  })

  test('no marker, or one without an id, is no task', () => {
    expect(readTaskMarker(undefined)).toBeUndefined()
    expect(readTaskMarker({ other: 1 })).toBeUndefined()
    expect(readTaskMarker({ [MCP_TASK_META_KEY]: { status: 'working' } })).toBeUndefined()
  })

  test('an optional field of the wrong type reads as absent', () => {
    expect(readTaskMarker({ [MCP_TASK_META_KEY]: { taskId: 't', status: 'working', statusMessage: null, ttlMs: 'x' } })).toEqual({
      taskId: 't',
      status: 'working',
    })
  })
})

describe('pollDelayMs', () => {
  test('honors the server between the floor and the cap, 2 s when it names none', () => {
    expect(pollDelayMs({})).toBe(TASK_POLL_DEFAULT_MS)
    expect(pollDelayMs({ pollIntervalMs: Number.NaN })).toBe(TASK_POLL_DEFAULT_MS)
    expect(pollDelayMs({ pollIntervalMs: 10 })).toBe(TASK_POLL_FLOOR_MS)
    expect(pollDelayMs({ pollIntervalMs: 5_000 })).toBe(5_000)
    expect(pollDelayMs({ pollIntervalMs: 3_600_000 })).toBe(TASK_POLL_CAP_MS)
    expect([TASK_POLL_FLOOR_MS, TASK_POLL_DEFAULT_MS, TASK_POLL_CAP_MS]).toEqual([1_000, 2_000, 30_000])
  })
})

describe('inlineTaskBudgetMs', () => {
  test('120 s inline, never past the tool timeout', () => {
    expect(MCP_TASK_INLINE_MS).toBe(120_000)
    expect(inlineTaskBudgetMs(MCP_TASK_INLINE_MS, 300_000)).toBe(120_000)
    expect(inlineTaskBudgetMs(MCP_TASK_INLINE_MS, 60_000)).toBe(60_000)
  })
})

describe('taskFailureMessage', () => {
  test("prefers the server's error, then its status line", () => {
    expect(taskFailureMessage({ ...working, status: 'failed', error: { code: 1, message: 'disk full' } })).toBe('disk full')
    expect(taskFailureMessage({ ...working, status: 'failed', error: 'boom' })).toBe('boom')
    expect(taskFailureMessage({ ...working, status: 'failed', error: { code: 1 }, statusMessage: 'gave up' })).toBe('gave up')
    expect(taskFailureMessage({ ...working, status: 'failed' })).toBe('MCP task t1 failed')
    expect(taskFailureMessage({ ...working, status: 'cancelled' })).toBe('MCP task t1 was cancelled')
  })
})

describe('taskStep', () => {
  test('maps each status', () => {
    const none = new Set<string>()
    expect(taskStep({ ...working, status: 'completed', result: { content: [] } }, none)).toEqual({
      kind: 'completed',
      result: { content: [] },
    })
    expect(taskStep({ ...working, status: 'failed' }, none)).toEqual({ kind: 'failed', message: 'MCP task t1 failed' })
    expect(taskStep({ ...working, status: 'cancelled' }, none)).toEqual({
      kind: 'cancelled',
      message: 'MCP task t1 was cancelled',
    })
    expect(taskStep(working, none)).toEqual({ kind: 'working' })
    expect(taskStep({ ...working, status: 'paused-by-a-future-spec' }, none)).toEqual({ kind: 'working' })
  })

  test('input_required lists only the requests not answered yet, and skips what is not a request', () => {
    const task: McpTask = { ...working, status: 'input_required', inputRequests: { a: ask, b: ask, junk: 'nope' } }
    expect(taskStep(task, new Set())).toEqual({ kind: 'input', requests: [['a', ask], ['b', ask]] })
    expect(taskStep(task, new Set(['a']))).toEqual({ kind: 'input', requests: [['b', ask]] })
    expect(taskStep(task, new Set(['a', 'b']))).toEqual({ kind: 'working' })
    expect(taskStep({ ...working, status: 'input_required' }, new Set())).toEqual({ kind: 'working' })
  })

  test('roots/list is answered; any other method ends the task, even beside one that is supported', () => {
    const roots = { method: 'roots/list' }
    expect(taskStep({ ...working, status: 'input_required', inputRequests: { r: roots } }, new Set())).toEqual({
      kind: 'input',
      requests: [['r', roots]],
    })
    const sampling = { method: 'sampling/createMessage', params: {} }
    expect(
      taskStep({ ...working, status: 'input_required', inputRequests: { a: ask, s: sampling } }, new Set()),
    ).toEqual({ kind: 'unsupported', method: 'sampling/createMessage' })
    expect(unsupportedTaskInputMessage('sampling/createMessage')).toBe(
      'the MCP server asked for sampling/createMessage, which Claudin does not support',
    )
  })
})

describe('startTaskPoll', () => {
  test('a task with a ttl expires that long after it arrived', () => {
    expect(startTaskPoll({ ...working, ttlMs: 60_000 }, 1_000)).toMatchObject({ expiresAt: 61_000, lifetimeMs: 60_000 })
    expect(startTaskPoll({ ...working, ttlMs: 0 }, 1_000).expiresAt).toBeUndefined()
    expect(startTaskPoll(working, 1_000).expiresAt).toBeUndefined()
  })
})

/** Deps over a scripted tasks/get, a clock each sleep advances, and a log of every call. */
function script(gets: Array<McpTask | Error>, over: Partial<TaskPollDeps> = {}) {
  let clock = 0
  const log: string[] = []
  const deps: TaskPollDeps = {
    getTask: async id => {
      log.push(`get ${id}`)
      const next = gets.shift()
      if (next === undefined) throw new Error('script ran out')
      if (next instanceof Error) throw next
      return next
    },
    updateTask: async (id, responses) => {
      log.push(`update ${id} ${JSON.stringify(responses)}`)
    },
    cancelTask: async id => {
      log.push(`cancel ${id}`)
    },
    answerInput: async key => {
      log.push(`ask ${key}`)
      return { action: 'accept' }
    },
    onStatus: message => log.push(`status ${message}`),
    now: () => clock,
    sleep: async ms => {
      log.push(`sleep ${ms}`)
      clock += ms
    },
    ...over,
  }
  return { deps, log, advance: (ms: number) => (clock += ms) }
}

const signal = () => new AbortController().signal

describe('pollTask', () => {
  test('polls at the interval, reports each new status line once, and returns the result', async () => {
    const { deps, log } = script([
      { ...working, statusMessage: 'half' },
      { ...working, statusMessage: 'half' },
      { ...working, status: 'completed', result: { content: [] } },
    ])
    const state = startTaskPoll({ ...working, statusMessage: 'start' }, 0)
    expect(await pollTask(state, deps, { signal: signal() })).toEqual({ kind: 'completed', result: { content: [] } })
    expect(log).toEqual([
      'status start',
      'sleep 1000',
      'get t1',
      'status half',
      'sleep 1000',
      'get t1',
      'sleep 1000',
      'get t1',
    ])
  })

  test('a terminal task needs no poll', async () => {
    const { deps, log } = script([])
    const state = startTaskPoll({ ...working, status: 'failed', error: { message: 'no' } }, 0)
    expect(await pollTask(state, deps, { signal: signal() })).toEqual({ kind: 'failed', message: 'no' })
    expect(log).toEqual([])
  })

  test('answers input once, sends it with tasks/update, and does not ask again while the server catches up', async () => {
    const input: McpTask = { ...working, status: 'input_required', inputRequests: { a: ask } }
    const { deps, log } = script([input, { ...working, status: 'cancelled' }])
    const outcome = await pollTask(startTaskPoll(input, 0), deps, { signal: signal() })
    expect(outcome).toEqual({ kind: 'cancelled', message: 'MCP task t1 was cancelled' })
    expect(log).toEqual([
      'ask a',
      'update t1 {"a":{"action":"accept"}}',
      'sleep 1000',
      'get t1',
      'sleep 1000',
      'get t1',
    ])
  })

  test('an input left unanswered sends no update', async () => {
    const input: McpTask = { ...working, status: 'input_required', inputRequests: { a: ask } }
    const { deps, log } = script([{ ...working, status: 'completed' }], { answerInput: async () => undefined })
    await pollTask(startTaskPoll(input, 0), deps, { signal: signal() })
    expect(log).toEqual(['sleep 1000', 'get t1'])
  })

  test('stops at stopAt with the task running, and picks up from the same state', async () => {
    const { deps, log } = script([working, working, { ...working, status: 'completed', result: 'r' }])
    const state = startTaskPoll(working, 0)
    expect(await pollTask(state, deps, { signal: signal(), stopAt: 1_500 })).toEqual({ kind: 'pending' })
    // The second sleep is cut to what is left of the window.
    expect(log).toEqual(['sleep 1000', 'get t1', 'sleep 500', 'get t1'])
    expect(await pollTask(state, deps, { signal: signal() })).toEqual({ kind: 'completed', result: 'r' })
  })

  test("stops polling past the task's ttl", async () => {
    const { deps, log } = script([working, working])
    const state = startTaskPoll({ ...working, ttlMs: 1_500 }, 0)
    expect(await pollTask(state, deps, { signal: signal() })).toEqual({
      kind: 'expired',
      message: 'MCP task t1 was still working when its 2s lifetime ran out',
    })
    expect(log).toEqual(['sleep 1000', 'get t1', 'sleep 500', 'get t1'])
  })

  test('an abort before, during the sleep, during a get or during the input sends tasks/cancel', async () => {
    const before = new AbortController()
    before.abort()
    const first = script([])
    expect(await pollTask(startTaskPoll(working, 0), first.deps, { signal: before.signal })).toEqual({ kind: 'aborted' })
    expect(first.log).toEqual(['cancel t1'])

    const sleeping = new AbortController()
    const second = script([], { sleep: async () => sleeping.abort() })
    expect(await pollTask(startTaskPoll(working, 0), second.deps, { signal: sleeping.signal })).toEqual({ kind: 'aborted' })
    expect(second.log).toEqual(['cancel t1'])

    const getting = new AbortController()
    const third = script([], {
      getTask: async () => {
        getting.abort()
        throw new Error('aborted')
      },
    })
    expect(await pollTask(startTaskPoll(working, 0), third.deps, { signal: getting.signal })).toEqual({ kind: 'aborted' })
    expect(third.log).toEqual(['sleep 1000', 'cancel t1'])

    const asking = new AbortController()
    const input: McpTask = { ...working, status: 'input_required', inputRequests: { a: ask } }
    const fourth = script([], {
      answerInput: async () => {
        asking.abort()
        return { action: 'cancel' }
      },
    })
    expect(await pollTask(startTaskPoll(input, 0), fourth.deps, { signal: asking.signal })).toEqual({ kind: 'aborted' })
    expect(fourth.log).toEqual(['cancel t1'])

    const updating = new AbortController()
    const fifth = script([], {
      updateTask: async () => {
        updating.abort()
        throw new Error('aborted')
      },
    })
    expect(await pollTask(startTaskPoll(input, 0), fifth.deps, { signal: updating.signal })).toEqual({ kind: 'aborted' })
    expect(fifth.log).toEqual(['ask a', 'cancel t1'])
  })

  test('a failing tasks/cancel still ends the poll as aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { deps } = script([], {
      cancelTask: async () => {
        throw new Error('unknown task')
      },
    })
    expect(await pollTask(startTaskPoll(working, 0), deps, { signal: controller.signal })).toEqual({ kind: 'aborted' })
  })

  test('an unsupported input request sends tasks/cancel once, asks nothing and ends the poll', async () => {
    const input: McpTask = {
      ...working,
      status: 'input_required',
      inputRequests: { s: { method: 'sampling/createMessage' } },
    }
    const { deps, log } = script([])
    expect(await pollTask(startTaskPoll(input, 0), deps, { signal: signal() })).toEqual({
      kind: 'unsupported',
      message: 'the MCP server asked for sampling/createMessage, which Claudin does not support',
    })
    expect(log).toEqual(['cancel t1'])
  })

  test('cancelPolledTask never throws', async () => {
    const calls: string[] = []
    await cancelPolledTask('t9', {
      cancelTask: async id => {
        calls.push(id)
        throw new Error('gone')
      },
    })
    expect(calls).toEqual(['t9'])
  })

  test('a failing tasks/get or tasks/update that is not an abort is thrown', async () => {
    const gone = script([new Error('-32602 unknown task')])
    await expect(pollTask(startTaskPoll(working, 0), gone.deps, { signal: signal() })).rejects.toThrow('unknown task')

    const input: McpTask = { ...working, status: 'input_required', inputRequests: { a: ask } }
    const refused = script([], {
      updateTask: async () => {
        throw new Error('bad responses')
      },
    })
    await expect(pollTask(startTaskPoll(input, 0), refused.deps, { signal: signal() })).rejects.toThrow('bad responses')
  })
})
