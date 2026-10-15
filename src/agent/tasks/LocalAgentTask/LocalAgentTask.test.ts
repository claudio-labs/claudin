import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { SetAppState } from 'src/agent/Task.js'
import {
  getCommandQueueSnapshot,
  resetCommandQueue,
} from 'src/agent/messageQueueManager.js'
import { drainSdkEvents } from 'src/agent/sdkEventQueue.js'
import { cleanupTaskOutput, getTaskOutputPath } from 'src/agent/tasks/diskOutput.js'
import { PANEL_GRACE_MS } from 'src/agent/tasks/framework.js'
import {
  appendMessageToLocalAgent,
  backgroundAgentTask,
  completeAgentTask,
  createActivityDescriptionResolver,
  createProgressTracker,
  drainPendingMessages,
  enqueueAgentNotification,
  failAgentTask,
  getProgressUpdate,
  getTokenCountFromTracker,
  isLocalAgentTask,
  isPanelAgentTask,
  killAllRunningAgentTasks,
  killAsyncAgent,
  LocalAgentTask,
  type LocalAgentTaskState,
  markAgentsNotified,
  queuePendingMessage,
  registerAgentForeground,
  registerAsyncAgent,
  takePendingMessages,
  unregisterAgentForeground,
  updateAgentProgress,
  updateAgentSummary,
  updateProgressFromMessage,
} from 'src/agent/tasks/LocalAgentTask/LocalAgentTask.js'
import {
  getIsInteractive,
  getSdkAgentProgressSummariesEnabled,
  setIsInteractive,
  setSdkAgentProgressSummariesEnabled,
} from 'src/platform/bootstrap/state.js'
import type { AppState } from 'src/terminal/state/AppState.js'
import type { AgentToolResult } from 'src/tools/AgentTool/agentToolUtils.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from 'src/tools/SyntheticOutputTool/SyntheticOutputTool.js'
import type { Tool, Tools } from 'src/tools/Tool.js'
import type { Message } from 'src/shared/types/message.js'

/** The slice of AppState these functions read, behind a plain setter. */
function makeStore() {
  let state = { tasks: {}, speculation: { status: 'idle' } } as unknown as AppState
  const setAppState: SetAppState = f => {
    state = f(state)
  }
  return {
    setAppState,
    getAppState: () => state,
    task: (id: string) => state.tasks[id] as LocalAgentTaskState | undefined,
  }
}

const AGENT = { agentType: 'Code' } as unknown as AgentDefinition

let nextId = 0
const registered: string[] = []
function newId(): string {
  const id = `lat-test-${process.pid}-${nextId++}`
  registered.push(id)
  return id
}

function asyncAgent(
  store: ReturnType<typeof makeStore>,
  extra: { parentAgentId?: string; parentAbortController?: AbortController } = {},
): LocalAgentTaskState {
  return registerAsyncAgent({
    agentId: newId(),
    description: 'audit',
    prompt: 'audit the branch',
    selectedAgent: AGENT,
    setAppState: store.setAppState,
    toolUseId: 'toolu_1',
    ...extra,
  })
}

function foregroundAgent(
  store: ReturnType<typeof makeStore>,
  autoBackgroundMs?: number,
  parentAgentId?: string,
) {
  return registerAgentForeground({
    agentId: newId(),
    description: 'inline',
    prompt: 'look around',
    selectedAgent: AGENT,
    setAppState: store.setAppState,
    autoBackgroundMs,
    parentAgentId,
  })
}

function assistant(
  content: unknown[],
  usage = { input_tokens: 10, output_tokens: 5 } as Record<string, number>,
): Message {
  return { type: 'assistant', message: { usage, content } } as unknown as Message
}

function toolUse(name: string, input: Record<string, unknown> = {}) {
  return { type: 'tool_use', id: `toolu_${name}`, name, input }
}

function agentResult(agentId: string): AgentToolResult {
  return { agentId, content: [{ type: 'text', text: 'done' }] } as unknown as AgentToolResult
}

afterEach(async () => {
  resetCommandQueue()
  // The symlink to the agent's transcript is written fire-and-forget.
  await Bun.sleep(5)
  await Promise.all(registered.splice(0).map(id => cleanupTaskOutput(id)))
})

describe('progress tracker', () => {
  test('starts empty, waiting on the first request', () => {
    expect(createProgressTracker()).toEqual({
      toolUseCount: 0,
      latestInputTokens: 0,
      cumulativeOutputTokens: 0,
      recentActivities: [],
      isRequesting: true,
    })
  })

  test('keeps the latest input with its cache reads and sums the outputs', () => {
    const tracker = createProgressTracker()
    updateProgressFromMessage(
      tracker,
      assistant([], {
        input_tokens: 100,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
        output_tokens: 7,
      }),
    )
    updateProgressFromMessage(tracker, assistant([], { input_tokens: 200, output_tokens: 3 }))
    expect(tracker.latestInputTokens).toBe(200)
    expect(tracker.cumulativeOutputTokens).toBe(10)
    expect(getTokenCountFromTracker(tracker)).toBe(210)
  })

  test('ignores anything but an assistant message', () => {
    const tracker = createProgressTracker()
    updateProgressFromMessage(tracker, { type: 'user' } as unknown as Message)
    expect(tracker).toEqual(createProgressTracker())
  })

  test('counts every tool use but leaves StructuredOutput out of the activities', () => {
    const tracker = createProgressTracker()
    updateProgressFromMessage(
      tracker,
      assistant([toolUse('Grep'), toolUse(SYNTHETIC_OUTPUT_TOOL_NAME), { type: 'text', text: 'hm' }]),
    )
    expect(tracker.toolUseCount).toBe(2)
    expect(tracker.recentActivities.map(a => a.toolName)).toEqual(['Grep'])
  })

  test('keeps only the five most recent activities', () => {
    const tracker = createProgressTracker()
    for (let i = 0; i < 7; i++) {
      updateProgressFromMessage(tracker, assistant([toolUse(`T${i}`)]))
    }
    expect(tracker.recentActivities.map(a => a.toolName)).toEqual(['T2', 'T3', 'T4', 'T5', 'T6'])
  })

  test('records the resolved description and the read/search classification', () => {
    const tracker = createProgressTracker()
    updateProgressFromMessage(
      tracker,
      assistant([toolUse('Mystery', { x: 1 })]),
      (name, input) => `${name} on ${JSON.stringify(input)}`,
      [] as unknown as Tools,
    )
    const [activity] = tracker.recentActivities
    expect(activity?.activityDescription).toBe('Mystery on {"x":1}')
    expect(activity?.isSearch).toBe(false)
    expect(activity?.isRead).toBe(false)
  })

  test('getProgressUpdate copies the activities and names the last one', () => {
    const tracker = createProgressTracker()
    updateProgressFromMessage(tracker, assistant([toolUse('A'), toolUse('B')]))
    const update = getProgressUpdate(tracker)
    expect(update.toolUseCount).toBe(2)
    expect(update.tokenCount).toBe(15)
    expect(update.lastActivity?.toolName).toBe('B')
    expect(update.recentActivities).not.toBe(tracker.recentActivities)
    expect(update.isRequesting).toBe(true)
    expect(getProgressUpdate(createProgressTracker()).lastActivity).toBeUndefined()
  })

  test('the activity resolver asks the named tool, and knows no other', () => {
    const tool = { name: 'Read', getActivityDescription: () => 'Reading a.ts' } as unknown as Tool
    const resolve = createActivityDescriptionResolver([tool] as unknown as Tools)
    expect(resolve('Read', {})).toBe('Reading a.ts')
    expect(resolve('Write', {})).toBeUndefined()
  })
})

describe('guards', () => {
  test('a local agent is any local_agent task; the panel excludes the main session', () => {
    expect(isLocalAgentTask({ type: 'local_agent' })).toBe(true)
    expect(isLocalAgentTask({ type: 'local_bash' })).toBe(false)
    expect(isLocalAgentTask(null)).toBe(false)
    expect(isPanelAgentTask({ type: 'local_agent', agentType: 'Code' })).toBe(true)
    expect(isPanelAgentTask({ type: 'local_agent', agentType: 'main-session' })).toBe(false)
  })
})

describe('messages queued to a running agent', () => {
  test('queue, take and drain', () => {
    const store = makeStore()
    const { agentId } = asyncAgent(store)
    queuePendingMessage(agentId, 'from main', store.setAppState)
    queuePendingMessage(agentId, 'from a sibling', store.setAppState)
    expect(
      takePendingMessages(agentId, m => m.includes('sibling'), store.getAppState, store.setAppState),
    ).toEqual(['from a sibling'])
    expect(takePendingMessages(agentId, () => false, store.getAppState, store.setAppState)).toEqual([])
    expect(drainPendingMessages(agentId, store.getAppState, store.setAppState)).toEqual(['from main'])
    expect(drainPendingMessages(agentId, store.getAppState, store.setAppState)).toEqual([])
    killAsyncAgent(agentId, store.setAppState)
  })

  test('take and drain answer nothing for a task that is not an agent', () => {
    const store = makeStore()
    expect(drainPendingMessages('missing', store.getAppState, store.setAppState)).toEqual([])
    expect(takePendingMessages('missing', () => true, store.getAppState, store.setAppState)).toEqual([])
  })

  test('appendMessageToLocalAgent adds to the viewed transcript', () => {
    const store = makeStore()
    const { agentId } = asyncAgent(store)
    const message = { type: 'user' } as unknown as Message
    appendMessageToLocalAgent(agentId, message, store.setAppState)
    expect(store.task(agentId)?.messages).toEqual([message])
    killAsyncAgent(agentId, store.setAppState)
  })
})

describe('enqueueAgentNotification', () => {
  test('queues one task-notification with everything the report carries', () => {
    const store = makeStore()
    const { agentId } = asyncAgent(store)
    completeAgentTask(agentResult(agentId), store.setAppState)
    enqueueAgentNotification({
      taskId: agentId,
      description: 'audit',
      status: 'completed',
      setAppState: store.setAppState,
      finalMessage: 'all green',
      usage: { totalTokens: 1200, toolUses: 4, durationMs: 900 },
      toolUseId: 'toolu_1',
      worktreePath: '/tmp/wt',
      worktreeBranch: 'agent-x',
    })
    const queued = getCommandQueueSnapshot()
    expect(queued).toHaveLength(1)
    const [notice] = queued
    expect(notice?.mode).toBe('task-notification')
    expect(notice?.priority).toBe('next')
    const text = String(notice?.value)
    for (const part of [
      `<task-id>${agentId}</task-id>`,
      '<tool-use-id>toolu_1</tool-use-id>',
      `<output-file>${getTaskOutputPath(agentId)}</output-file>`,
      '<status>completed</status>',
      '<summary>Agent "audit" completed</summary>',
      '<result>all green</result>',
      '<total_tokens>1200</total_tokens>',
      '<worktree><worktreePath>/tmp/wt</worktreePath><worktreeBranch>agent-x</worktreeBranch></worktree>',
    ]) {
      expect(text).toContain(part)
    }
    expect(store.task(agentId)?.notified).toBe(true)
  })

  test('a task already notified is not notified twice', () => {
    const store = makeStore()
    const { agentId } = asyncAgent(store)
    markAgentsNotified(agentId, store.setAppState)
    enqueueAgentNotification({ taskId: agentId, description: 'd', status: 'killed', setAppState: store.setAppState })
    expect(getCommandQueueSnapshot()).toHaveLength(0)
    killAsyncAgent(agentId, store.setAppState)
  })

  test('the summary names a failure and its error, and a stop', () => {
    const store = makeStore()
    const failed = asyncAgent(store).agentId
    const stopped = asyncAgent(store).agentId
    enqueueAgentNotification({ taskId: failed, description: 'a', status: 'failed', error: 'boom', setAppState: store.setAppState })
    enqueueAgentNotification({ taskId: stopped, description: 'b', status: 'killed', setAppState: store.setAppState })
    const [first, second] = getCommandQueueSnapshot().map(c => String(c.value))
    expect(first).toContain('<summary>Agent "a" failed: boom</summary>')
    expect(first).not.toContain('<result>')
    expect(second).toContain('<summary>Agent "b" was stopped</summary>')
    killAsyncAgent(failed, store.setAppState)
    killAsyncAgent(stopped, store.setAppState)
  })
})

describe('background agent lifecycle', () => {
  test('registerAsyncAgent starts running, backgrounded, under its parent', () => {
    const store = makeStore()
    const task = asyncAgent(store, { parentAgentId: 'parent-1' })
    const stored = store.task(task.agentId)
    expect(stored?.status).toBe('running')
    expect(stored?.isBackgrounded).toBe(true)
    expect(stored?.parentAgentId).toBe('parent-1')
    expect(stored?.agentType).toBe('Code')
    expect(typeof stored?.unregisterCleanup).toBe('function')
    killAsyncAgent(task.agentId, store.setAppState)
  })

  test('a parent abort controller reaches the agent', () => {
    const store = makeStore()
    const parent = new AbortController()
    const task = asyncAgent(store, { parentAbortController: parent })
    parent.abort()
    expect(task.abortController?.signal.aborted).toBe(true)
    killAsyncAgent(task.agentId, store.setAppState)
  })

  test('kill aborts, marks it killed and starts the panel grace', () => {
    const store = makeStore()
    const task = asyncAgent(store)
    const before = Date.now()
    killAsyncAgent(task.agentId, store.setAppState)
    const stored = store.task(task.agentId)
    expect(task.abortController?.signal.aborted).toBe(true)
    expect(stored?.status).toBe('killed')
    expect(stored?.evictAfter).toBeGreaterThanOrEqual(before + PANEL_GRACE_MS)
    expect(stored?.abortController).toBeUndefined()
    expect(stored?.unregisterCleanup).toBeUndefined()
    // Not running any more: a second kill changes nothing.
    const after = store.getAppState()
    killAsyncAgent(task.agentId, store.setAppState)
    expect(store.getAppState()).toBe(after)
  })

  test('LocalAgentTask.kill is killAsyncAgent', async () => {
    const store = makeStore()
    const task = asyncAgent(store)
    await LocalAgentTask.kill(task.agentId, store.setAppState)
    expect(store.task(task.agentId)?.status).toBe('killed')
  })

  test('a retained task gets no eviction deadline', () => {
    const store = makeStore()
    const task = asyncAgent(store)
    store.setAppState(prev => ({
      ...prev,
      tasks: { ...prev.tasks, [task.agentId]: { ...store.task(task.agentId)!, retain: true } },
    }))
    completeAgentTask(agentResult(task.agentId), store.setAppState)
    expect(store.task(task.agentId)?.evictAfter).toBeUndefined()
  })

  test('killAllRunningAgentTasks stops only running agents', () => {
    const store = makeStore()
    const running = asyncAgent(store).agentId
    const done = asyncAgent(store).agentId
    completeAgentTask(agentResult(done), store.setAppState)
    killAllRunningAgentTasks(store.getAppState().tasks, store.setAppState)
    expect(store.task(running)?.status).toBe('killed')
    expect(store.task(done)?.status).toBe('completed')
  })

  test('complete and fail are terminal, and only from running', () => {
    const store = makeStore()
    const ok = asyncAgent(store).agentId
    const bad = asyncAgent(store).agentId
    const result = agentResult(ok)
    completeAgentTask(result, store.setAppState)
    failAgentTask(bad, 'boom', store.setAppState)
    expect(store.task(ok)).toMatchObject({ status: 'completed', result })
    expect(store.task(bad)).toMatchObject({ status: 'failed', error: 'boom' })
    expect(store.task(bad)?.endTime).toBeNumber()
    failAgentTask(ok, 'late', store.setAppState)
    completeAgentTask(agentResult(bad), store.setAppState)
    expect(store.task(ok)?.status).toBe('completed')
    expect(store.task(bad)?.status).toBe('failed')
  })

  test('progress keeps the summary already written, and stops at the end', () => {
    const store = makeStore()
    const { agentId } = asyncAgent(store)
    updateAgentSummary(agentId, 'reading the tests', store.setAppState)
    updateAgentProgress(agentId, { toolUseCount: 3, tokenCount: 50 }, store.setAppState)
    expect(store.task(agentId)?.progress).toEqual({
      toolUseCount: 3,
      tokenCount: 50,
      summary: 'reading the tests',
    })
    completeAgentTask(agentResult(agentId), store.setAppState)
    updateAgentProgress(agentId, { toolUseCount: 9, tokenCount: 90 }, store.setAppState)
    updateAgentSummary(agentId, 'too late', store.setAppState)
    expect(store.task(agentId)?.progress?.toolUseCount).toBe(3)
    expect(store.task(agentId)?.progress?.summary).toBe('reading the tests')
  })

  test('progress without a summary yet is stored as given', () => {
    const store = makeStore()
    const { agentId } = asyncAgent(store)
    updateAgentProgress(agentId, { toolUseCount: 1, tokenCount: 5 }, store.setAppState)
    expect(store.task(agentId)?.progress).toEqual({ toolUseCount: 1, tokenCount: 5 })
    killAsyncAgent(agentId, store.setAppState)
  })

  describe('summary events for SDK consumers', () => {
    let interactive: boolean
    let summaries: boolean
    beforeAll(() => {
      interactive = getIsInteractive()
      summaries = getSdkAgentProgressSummariesEnabled()
      setIsInteractive(false)
    })
    afterAll(() => {
      setIsInteractive(interactive)
      setSdkAgentProgressSummariesEnabled(summaries)
    })
    beforeEach(() => {
      drainSdkEvents()
    })

    test('emitted only when the SDK asked for them', () => {
      const store = makeStore()
      const { agentId } = asyncAgent(store)
      drainSdkEvents()
      setSdkAgentProgressSummariesEnabled(false)
      updateAgentSummary(agentId, 'quiet', store.setAppState)
      expect(drainSdkEvents()).toEqual([])
      setSdkAgentProgressSummariesEnabled(true)
      updateAgentSummary(agentId, 'loud', store.setAppState)
      const events = drainSdkEvents()
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        subtype: 'task_progress',
        task_id: agentId,
        tool_use_id: 'toolu_1',
        summary: 'loud',
      })
      killAsyncAgent(agentId, store.setAppState)
    })
  })
})

describe('foreground agent lifecycle', () => {
  test('registers inline, then backgrounds once on request', async () => {
    const store = makeStore()
    const { taskId, backgroundSignal } = foregroundAgent(store)
    expect(store.task(taskId)).toMatchObject({ status: 'running', isBackgrounded: false })
    expect(backgroundAgentTask(taskId, store.getAppState, store.setAppState)).toBe(true)
    await backgroundSignal
    expect(store.task(taskId)?.isBackgrounded).toBe(true)
    expect(backgroundAgentTask(taskId, store.getAppState, store.setAppState)).toBe(false)
    killAsyncAgent(taskId, store.setAppState)
  })

  test('backgrounding a task that is not an agent does nothing', () => {
    const store = makeStore()
    expect(backgroundAgentTask('missing', store.getAppState, store.setAppState)).toBe(false)
  })

  test('an agent a sub-agent spawned stays inline under Ctrl+B', () => {
    // Only main owns background agents: backgrounded, its report would reach
    // main and the sub-agent that is waiting on it would never get it.
    const store = makeStore()
    const { taskId } = foregroundAgent(store, undefined, 'sub-agent-1')
    expect(backgroundAgentTask(taskId, store.getAppState, store.setAppState)).toBe(false)
    expect(store.task(taskId)?.isBackgrounded).toBe(false)
    unregisterAgentForeground(taskId, store.setAppState)
    expect(store.task(taskId)).toBeUndefined()
  })

  test('the auto-background timer backgrounds it, unless cancelled', async () => {
    const store = makeStore()
    const auto = foregroundAgent(store, 5)
    const kept = foregroundAgent(store, 5)
    kept.cancelAutoBackground?.()
    await auto.backgroundSignal
    await Bun.sleep(15)
    expect(store.task(auto.taskId)?.isBackgrounded).toBe(true)
    expect(store.task(kept.taskId)?.isBackgrounded).toBe(false)
    expect(foregroundAgent(store).cancelAutoBackground).toBeUndefined()
    killAsyncAgent(auto.taskId, store.setAppState)
    unregisterAgentForeground(kept.taskId, store.setAppState)
  })

  test('unregister removes an inline agent and keeps a backgrounded one', () => {
    const store = makeStore()
    const inline = foregroundAgent(store).taskId
    const moved = foregroundAgent(store).taskId
    backgroundAgentTask(moved, store.getAppState, store.setAppState)
    unregisterAgentForeground(inline, store.setAppState)
    unregisterAgentForeground(moved, store.setAppState)
    expect(store.task(inline)).toBeUndefined()
    expect(store.task(moved)?.isBackgrounded).toBe(true)
    killAsyncAgent(moved, store.setAppState)
  })
})
