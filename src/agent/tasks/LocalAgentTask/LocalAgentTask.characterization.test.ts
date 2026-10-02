/**
 * Characterization of the local background-agent task: the progress tracker
 * the agent loop feeds, the mailbox SendMessage writes into, the completion
 * notice the model reads, and the lifecycle AgentTool drives (register,
 * foreground/background, complete, fail, kill).
 *
 * Everything is observed the way callers observe it: the app-state store they
 * pass in, the pending-notification queue, and the SDK event queue.
 */
import { afterEach, describe, expect, test } from 'bun:test'
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
  killAllRunningAgentTasks,
  killAsyncAgent,
  markAgentsNotified,
  queuePendingMessage,
  registerAgentForeground,
  registerAsyncAgent,
  takePendingMessages,
  unregisterAgentForeground,
  updateAgentProgress,
  updateAgentSummary,
  updateProgressFromMessage,
  isPanelAgentTask,
  LocalAgentTask,
} from 'src/agent/tasks/LocalAgentTask/LocalAgentTask.js'
import { getTaskOutputPath } from 'src/agent/tasks/diskOutput.js'
import { PANEL_GRACE_MS } from 'src/agent/tasks/framework.js'
import { drainSdkEvents } from 'src/agent/sdkEventQueue.js'
import { getCommandQueueSnapshot } from 'src/agent/messageQueueManager.js'
import {
  getIsInteractive,
  getSdkAgentProgressSummariesEnabled,
  setIsInteractive,
  setSdkAgentProgressSummariesEnabled,
} from 'src/platform/bootstrap/state.js'
import { createTaskStore, isStubbedDescriptor, isolateTaskEnv, queuedTexts, type TaskStore } from 'src/agent/tasks/__testutils__/taskHarness.js'

const STUBBED = isStubbedDescriptor(LocalAgentTask)

isolateTaskEnv('local-agent-char')

// The row as the store holds it; the suite reads whichever field a case is about.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentRow = Record<string, any>

const EXPLORER = { agentType: 'Explore', whenToUse: 'look around', source: 'built-in' } as never

// Every test that starts an agent ends it, so nothing is left in the
// process-wide cleanup registry.
const live: Array<{ id: string; store: TaskStore }> = []
afterEach(() => {
  for (const { id, store } of live.splice(0)) killAsyncAgent(id, store.set)
})

function startBackground(store: TaskStore, id: string, extra: Record<string, unknown> = {}) {
  live.push({ id, store })
  return registerAsyncAgent({
    agentId: id,
    description: `job ${id}`,
    prompt: `do ${id}`,
    selectedAgent: EXPLORER,
    setAppState: store.set,
    ...extra,
  } as never)
}

function startForeground(store: TaskStore, id: string, extra: Record<string, unknown> = {}) {
  live.push({ id, store })
  return registerAgentForeground({
    agentId: id,
    description: `fg ${id}`,
    prompt: `do ${id}`,
    selectedAgent: EXPLORER,
    setAppState: store.set,
    ...extra,
  } as never)
}

function assistantTurn(usage: Record<string, number>, toolNames: string[]) {
  return {
    type: 'assistant',
    message: {
      usage,
      content: [
        { type: 'text', text: 'thinking out loud' },
        ...toolNames.map((name, i) => ({ type: 'tool_use', id: `tu${i}`, name, input: { n: i, name } })),
      ],
    },
  } as never
}

describe('progress tracking', () => {
  test('a fresh tracker counts nothing and is requesting', () => {
    const tracker = createProgressTracker()
    expect(getTokenCountFromTracker(tracker)).toBe(0)
    expect(getProgressUpdate(tracker)).toEqual({
      toolUseCount: 0,
      tokenCount: 0,
      lastActivity: undefined,
      recentActivities: [],
      isRequesting: true,
    })
  })

  test('only assistant messages move the counters', () => {
    const tracker = createProgressTracker()
    for (const type of ['user', 'system', 'progress', 'attachment']) {
      updateProgressFromMessage(tracker, { type, message: { content: [] } } as never)
    }
    expect(getProgressUpdate(tracker).tokenCount).toBe(0)
  })

  test('input tokens are the latest turn (cache included) and output tokens add up', () => {
    const tracker = createProgressTracker()
    const turns: Array<[Record<string, number>, number]> = [
      [{ input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 20 }, 125 + 10],
      [{ input_tokens: 300, output_tokens: 7 }, 300 + 17],
      [{ input_tokens: 50, output_tokens: 3, cache_read_input_tokens: 1 }, 51 + 20],
    ]
    for (const [usage, expected] of turns) {
      updateProgressFromMessage(tracker, assistantTurn(usage, []))
      expect(getTokenCountFromTracker(tracker)).toBe(expected)
    }
  })

  test('tool uses are counted, StructuredOutput is counted but kept out of the activity list', () => {
    const tracker = createProgressTracker()
    updateProgressFromMessage(tracker, assistantTurn({ input_tokens: 1, output_tokens: 1 }, ['Grep', 'StructuredOutput', 'Read']))
    const update = getProgressUpdate(tracker)
    expect(update.toolUseCount).toBe(3)
    expect(update.recentActivities!.map(a => a.toolName)).toEqual(['Grep', 'Read'])
    expect(update.lastActivity!.toolName).toBe('Read')
    expect(update.lastActivity!.input).toEqual({ n: 2, name: 'Read' })
  })

  test('only the five newest activities are kept', () => {
    const tracker = createProgressTracker()
    const names = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']
    updateProgressFromMessage(tracker, assistantTurn({ input_tokens: 0, output_tokens: 0 }, names.slice(0, 4)))
    updateProgressFromMessage(tracker, assistantTurn({ input_tokens: 0, output_tokens: 0 }, names.slice(4)))
    const update = getProgressUpdate(tracker)
    expect(update.toolUseCount).toBe(7)
    expect(update.recentActivities!.map(a => a.toolName)).toEqual(['A3', 'A4', 'A5', 'A6', 'A7'])
  })

  test('the update hands out a copy of the activity list', () => {
    const tracker = createProgressTracker()
    updateProgressFromMessage(tracker, assistantTurn({ input_tokens: 0, output_tokens: 0 }, ['Glob']))
    getProgressUpdate(tracker).recentActivities!.length = 0
    expect(getProgressUpdate(tracker).recentActivities).toHaveLength(1)
  })

  test('activities carry the resolver description and the search/read classification of the given tools', () => {
    const tools = [
      { name: 'Finder', isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }) },
      { name: 'Opener', isSearchOrReadCommand: () => ({ isSearch: false, isRead: true }) },
      { name: 'Doer' },
    ] as never
    const describeIt = (name: string, input: Record<string, unknown>) => `${name} #${String(input.n)}`
    const tracker = createProgressTracker()
    updateProgressFromMessage(tracker, assistantTurn({ input_tokens: 0, output_tokens: 0 }, ['Finder', 'Opener', 'Doer']), describeIt, tools)
    const seen = getProgressUpdate(tracker).recentActivities!.map(a => [a.toolName, a.activityDescription, a.isSearch, a.isRead])
    expect(seen).toEqual([
      ['Finder', 'Finder #0', true, false],
      ['Opener', 'Opener #1', false, true],
      ['Doer', 'Doer #2', false, false],
    ])
  })

  test('without tools there is no classification at all', () => {
    const tracker = createProgressTracker()
    updateProgressFromMessage(tracker, assistantTurn({ input_tokens: 0, output_tokens: 0 }, ['Finder']))
    const [activity] = getProgressUpdate(tracker).recentActivities!
    expect([activity!.isSearch, activity!.isRead, activity!.isWrite, activity!.activityDescription]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  test('the description resolver asks the named tool and is undefined otherwise', () => {
    const resolve = createActivityDescriptionResolver([
      { name: 'Talker', aliases: ['Chatter'], getActivityDescription: (input: { what: string }) => `talking about ${input.what}` },
      { name: 'Silent', getActivityDescription: () => null },
      { name: 'Mute' },
    ] as never)
    const cases: Array<[string, string | undefined]> = [
      ['Talker', 'talking about cats'],
      ['Chatter', 'talking about cats'],
      ['Silent', undefined],
      ['Mute', undefined],
      ['Nobody', undefined],
    ]
    for (const [name, expected] of cases) expect(resolve(name, { what: 'cats' }), name).toBe(expected)
  })
})

describe('type guards', () => {
  test('a local agent is recognised by its type', () => {
    const cases: Array<[unknown, boolean]> = [
      [{ type: 'local_agent', agentType: 'Explore' }, true],
      [{ type: 'local_agent' }, true],
      [{ type: 'local_bash' }, false],
      [{ agentType: 'Explore' }, false],
      [null, false],
      ['local_agent', false],
      [undefined, false],
    ]
    for (const [value, agent] of cases) expect(isLocalAgentTask(value), JSON.stringify(value)).toBe(agent)
  })

  test.skipIf(STUBBED)('the panel takes local agents other than the main session', () => {
    const cases: Array<[unknown, boolean]> = [
      [{ type: 'local_agent', agentType: 'Explore' }, true],
      [{ type: 'local_agent', agentType: 'main-session' }, false],
      [{ type: 'local_bash', agentType: 'Explore' }, false],
      [null, false],
      [undefined, false],
    ]
    for (const [value, panel] of cases) expect(isPanelAgentTask(value), JSON.stringify(value)).toBe(panel)
  })

  test.skipIf(STUBBED)('the task descriptor names its type and kills through the store', async () => {
    expect(LocalAgentTask.type).toBe('local_agent')
    expect(LocalAgentTask.name).toBe('LocalAgentTask')
    const store = createTaskStore()
    startBackground(store, 'a-desc')
    await LocalAgentTask.kill('a-desc', store.set)
    expect(store.task<AgentRow>('a-desc').status).toBe('killed')
  })
})

describe('registering a background agent', () => {
  test('the row starts running, backgrounded, with an empty mailbox', () => {
    const store = createTaskStore()
    const returned = startBackground(store, 'a-reg', { toolUseId: 'toolu_9', parentAgentId: 'a-parent' })
    const row = store.task<AgentRow & { prompt: string; description: string; outputFile: string; agentId: string }>('a-reg')
    expect(row).toBe(returned as never)
    expect({
      status: row.status,
      isBackgrounded: row.isBackgrounded,
      agentType: row.agentType,
      agentId: row.agentId,
      parentAgentId: row.parentAgentId,
      prompt: row.prompt,
      description: row.description,
      toolUseId: row.toolUseId,
      pendingMessages: row.pendingMessages,
      retain: row.retain,
      notified: row.notified,
      outputFile: row.outputFile,
    }).toEqual({
      status: 'running',
      isBackgrounded: true,
      agentType: 'Explore',
      agentId: 'a-reg',
      parentAgentId: 'a-parent',
      prompt: 'do a-reg',
      description: 'job a-reg',
      toolUseId: 'toolu_9',
      pendingMessages: [],
      retain: false,
      notified: false,
      outputFile: getTaskOutputPath('a-reg'),
    })
  })

  test('an agent definition without a type is recorded as Code', () => {
    const store = createTaskStore()
    startBackground(store, 'a-untyped', { selectedAgent: { whenToUse: 'x' } })
    expect(store.task<AgentRow>('a-untyped').agentType).toBe('Code')
  })

  test('aborting the parent controller aborts the agent', () => {
    const store = createTaskStore()
    const parent = new AbortController()
    startBackground(store, 'a-child', { parentAbortController: parent })
    const own = store.task<AgentRow>('a-child').abortController!
    expect(own).not.toBe(parent)
    expect(own.signal.aborted).toBe(false)
    parent.abort()
    expect(own.signal.aborted).toBe(true)
  })

  test('without a parent the agent has a controller of its own', () => {
    const store = createTaskStore()
    startBackground(store, 'a-solo')
    expect(store.task<AgentRow>('a-solo').abortController!.signal.aborted).toBe(false)
  })
})

describe('terminal transitions', () => {
  const transitions: Array<{
    name: string
    status: string
    end: (store: TaskStore, id: string) => void
    check?: (row: AgentRow) => void
  }> = [
    {
      name: 'completing',
      status: 'completed',
      end: (store, id) => completeAgentTask({ agentId: id, content: [{ type: 'text', text: 'all done' }] } as never, store.set),
      check: row => expect(row.result).toEqual({ agentId: expect.any(String), content: [{ type: 'text', text: 'all done' }] }),
    },
    {
      name: 'failing',
      status: 'failed',
      end: (store, id) => failAgentTask(id, 'boom', store.set),
      check: row => expect(row.error).toBe('boom'),
    },
    {
      name: 'killing',
      status: 'killed',
      end: (store, id) => killAsyncAgent(id, store.set),
      check: row => expect(row.result).toBeUndefined(),
    },
  ]

  for (const { name, status, end, check } of transitions) {
    test(`${name} a running agent ends it as ${status} and drops its live handles`, () => {
      const store = createTaskStore()
      startBackground(store, `a-${status}`)
      const before = Date.now()
      end(store, `a-${status}`)
      const row = store.task<AgentRow>(`a-${status}`)
      expect(row.status).toBe(status)
      expect(row.endTime!).toBeGreaterThanOrEqual(before)
      expect(row.evictAfter!).toBeGreaterThanOrEqual(before + PANEL_GRACE_MS)
      expect(row.evictAfter!).toBeLessThanOrEqual(Date.now() + PANEL_GRACE_MS)
      expect([row.abortController, row.unregisterCleanup, row.selectedAgent]).toEqual([undefined, undefined, undefined])
      check?.(row)
    })

    test(`${name} a retained agent sets no eviction deadline`, () => {
      const store = createTaskStore()
      startBackground(store, `a-kept-${status}`)
      store.set(prev => ({ ...prev, tasks: { ...prev.tasks, [`a-kept-${status}`]: { ...prev.tasks[`a-kept-${status}`]!, retain: true } } }) as never)
      end(store, `a-kept-${status}`)
      expect(store.task<AgentRow>(`a-kept-${status}`).status).toBe(status)
      expect(store.task<AgentRow>(`a-kept-${status}`).evictAfter).toBeUndefined()
    })

    test(`${name} an agent that already ended changes nothing`, () => {
      const store = createTaskStore()
      startBackground(store, `a-done-${status}`)
      failAgentTask(`a-done-${status}`, 'first', store.set)
      const settled = store.get()
      end(store, `a-done-${status}`)
      expect(store.get()).toBe(settled)
    })
  }

  test('killing aborts the agent controller', () => {
    const store = createTaskStore()
    startBackground(store, 'a-abort')
    const signal = store.task<AgentRow>('a-abort').abortController!.signal
    killAsyncAgent('a-abort', store.set)
    expect(signal.aborted).toBe(true)
  })

  test('an unknown id is ignored', () => {
    const store = createTaskStore()
    const before = store.get()
    killAsyncAgent('nobody', store.set)
    completeAgentTask({ agentId: 'nobody', content: [] } as never, store.set)
    failAgentTask('nobody', 'x', store.set)
    expect(store.get()).toBe(before)
  })

  test('kill-all stops only running local agents', () => {
    const store = createTaskStore()
    startBackground(store, 'a-run1')
    startBackground(store, 'a-run2')
    startBackground(store, 'a-over')
    completeAgentTask({ agentId: 'a-over', content: [] } as never, store.set)
    store.set(prev => ({ ...prev, tasks: { ...prev.tasks, b9: { id: 'b9', type: 'local_bash', status: 'running' } } }) as never)
    killAllRunningAgentTasks(store.get().tasks as never, store.set)
    const statuses = Object.fromEntries(Object.entries(store.get().tasks).map(([id, t]) => [id, t.status]))
    expect(statuses).toEqual({ 'a-run1': 'killed', 'a-run2': 'killed', 'a-over': 'completed', b9: 'running' })
  })
})

describe('progress and summary on the row', () => {
  test('progress replaces the previous one but keeps an existing summary', () => {
    const store = createTaskStore()
    startBackground(store, 'a-prog')
    updateAgentProgress('a-prog', { toolUseCount: 1, tokenCount: 10 }, store.set)
    expect(store.task<AgentRow>('a-prog').progress).toEqual({ toolUseCount: 1, tokenCount: 10 })
    updateAgentSummary('a-prog', 'reading the parser', store.set)
    updateAgentProgress('a-prog', { toolUseCount: 4, tokenCount: 99, summary: 'ignored' }, store.set)
    expect(store.task<AgentRow>('a-prog').progress).toEqual({ toolUseCount: 4, tokenCount: 99, summary: 'reading the parser' })
  })

  test('a summary on an agent with no progress yet starts the counters at zero', () => {
    const store = createTaskStore()
    startBackground(store, 'a-sum0')
    updateAgentSummary('a-sum0', 'warming up', store.set)
    expect(store.task<AgentRow>('a-sum0').progress).toEqual({ toolUseCount: 0, tokenCount: 0, summary: 'warming up' })
  })

  test('neither touches an agent that is no longer running', () => {
    const store = createTaskStore()
    startBackground(store, 'a-late')
    killAsyncAgent('a-late', store.set)
    const settled = store.get()
    updateAgentProgress('a-late', { toolUseCount: 1, tokenCount: 1 }, store.set)
    updateAgentSummary('a-late', 'too late', store.set)
    expect(store.get()).toBe(settled)
  })

  describe('the SDK progress event', () => {
    const wasInteractive = getIsInteractive()
    const wasEnabled = getSdkAgentProgressSummariesEnabled()
    afterEach(() => {
      setIsInteractive(wasInteractive)
      setSdkAgentProgressSummariesEnabled(wasEnabled)
      drainSdkEvents()
    })

    function progressEvents() {
      return drainSdkEvents().filter(e => e.subtype === 'task_progress') as Array<Record<string, unknown>>
    }

    test('a summary is emitted when the SDK opted in', () => {
      setIsInteractive(false)
      setSdkAgentProgressSummariesEnabled(true)
      const store = createTaskStore()
      startBackground(store, 'a-sdk', { toolUseId: 'toolu_sdk' })
      updateAgentProgress('a-sdk', { toolUseCount: 3, tokenCount: 420 }, store.set)
      drainSdkEvents()
      updateAgentSummary('a-sdk', 'halfway', store.set)
      const [event, ...rest] = progressEvents()
      expect(rest).toHaveLength(0)
      expect(event).toMatchObject({
        task_id: 'a-sdk',
        tool_use_id: 'toolu_sdk',
        description: 'halfway',
        summary: 'halfway',
        usage: { total_tokens: 420, tool_uses: 3 },
      })
      expect((event!.usage as { duration_ms: number }).duration_ms).toBeGreaterThanOrEqual(0)
    })

    test('nothing is emitted without the opt-in, or for an agent that ended', () => {
      setIsInteractive(false)
      setSdkAgentProgressSummariesEnabled(false)
      const store = createTaskStore()
      startBackground(store, 'a-quiet')
      drainSdkEvents()
      updateAgentSummary('a-quiet', 'shh', store.set)
      expect(progressEvents()).toHaveLength(0)

      setSdkAgentProgressSummariesEnabled(true)
      killAsyncAgent('a-quiet', store.set)
      updateAgentSummary('a-quiet', 'after the end', store.set)
      expect(progressEvents()).toHaveLength(0)
    })
  })
})

describe('the mailbox', () => {
  test('queued messages are drained once, in order', () => {
    const store = createTaskStore()
    startBackground(store, 'a-mail')
    for (const text of ['first', 'second', 'third']) queuePendingMessage('a-mail', text, store.set)
    expect(drainPendingMessages('a-mail', store.get, store.set)).toEqual(['first', 'second', 'third'])
    expect(drainPendingMessages('a-mail', store.get, store.set)).toEqual([])
    expect(store.task<AgentRow>('a-mail').pendingMessages).toEqual([])
  })

  test('draining something that is not an agent gives nothing', () => {
    const store = createTaskStore({ b1: { id: 'b1', type: 'local_bash', status: 'running', pendingMessages: ['x'] } })
    expect(drainPendingMessages('b1', store.get, store.set)).toEqual([])
    expect(drainPendingMessages('missing', store.get, store.set)).toEqual([])
    expect(takePendingMessages('b1', () => true, store.get, store.set)).toEqual([])
  })

  test('taking removes only the selected messages and leaves the rest for the next drain', () => {
    const store = createTaskStore()
    startBackground(store, 'a-take')
    for (const text of ['reply: 1', 'user typed', 'reply: 2']) queuePendingMessage('a-take', text, store.set)
    const isReply = (text: string) => text.startsWith('reply')
    expect(takePendingMessages('a-take', isReply, store.get, store.set)).toEqual(['reply: 1', 'reply: 2'])
    expect(store.task<AgentRow>('a-take').pendingMessages).toEqual(['user typed'])
    const untouched = store.get()
    expect(takePendingMessages('a-take', isReply, store.get, store.set)).toEqual([])
    expect(store.get()).toBe(untouched)
  })

  test('appended transcript messages accumulate on the row', () => {
    const store = createTaskStore()
    startBackground(store, 'a-view')
    appendMessageToLocalAgent('a-view', { uuid: 'm1' } as never, store.set)
    appendMessageToLocalAgent('a-view', { uuid: 'm2' } as never, store.set)
    expect(store.task<AgentRow>('a-view').messages).toEqual([{ uuid: 'm1' }, { uuid: 'm2' }])
  })
})

describe('the completion notice', () => {
  function notify(store: TaskStore, id: string, extra: Record<string, unknown>) {
    enqueueAgentNotification({ taskId: id, description: 'Audit the parser', setAppState: store.set, ...extra } as never)
  }

  test('a completed agent with every optional section', () => {
    const store = createTaskStore()
    startBackground(store, 'a-full')
    notify(store, 'a-full', {
      status: 'completed',
      toolUseId: 'toolu_1',
      finalMessage: 'Found 3 bugs',
      usage: { totalTokens: 1200, toolUses: 7, durationMs: 4500 },
      worktreePath: '/wt/feature',
      worktreeBranch: 'feature-x',
    })
    expect(queuedTexts()).toEqual([
      [
        '<task-notification>',
        '<task-id>a-full</task-id>',
        '<tool-use-id>toolu_1</tool-use-id>',
        `<output-file>${getTaskOutputPath('a-full')}</output-file>`,
        '<status>completed</status>',
        '<summary>Agent "Audit the parser" completed</summary>',
        '<result>Found 3 bugs</result>',
        '<usage><total_tokens>1200</total_tokens><tool_uses>7</tool_uses><duration_ms>4500</duration_ms></usage>',
        '<worktree><worktreePath>/wt/feature</worktreePath><worktreeBranch>feature-x</worktreeBranch></worktree>',
        '</task-notification>',
      ].join('\n'),
    ])
    expect(getCommandQueueSnapshot().map(entry => entry.mode)).toEqual(['task-notification'])
    expect(store.task<AgentRow>('a-full').notified).toBe(true)
  })

  test('the minimal notice has only id, file, status and summary', () => {
    const store = createTaskStore()
    startBackground(store, 'a-min')
    notify(store, 'a-min', { status: 'killed' })
    expect(queuedTexts()).toEqual([
      [
        '<task-notification>',
        '<task-id>a-min</task-id>',
        `<output-file>${getTaskOutputPath('a-min')}</output-file>`,
        '<status>killed</status>',
        '<summary>Agent "Audit the parser" was stopped</summary>',
        '</task-notification>',
      ].join('\n'),
    ])
  })

  test('the summary line depends on the status and the error', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ status: 'completed' }, 'Agent "Audit the parser" completed'],
      [{ status: 'failed', error: 'rate limited' }, 'Agent "Audit the parser" failed: rate limited'],
      [{ status: 'failed' }, 'Agent "Audit the parser" failed: Unknown error'],
      [{ status: 'killed' }, 'Agent "Audit the parser" was stopped'],
    ]
    for (const [i, [extra, summary]] of cases.entries()) {
      const store = createTaskStore()
      startBackground(store, `a-sum-${i}`)
      notify(store, `a-sum-${i}`, extra)
      expect(queuedTexts().at(-1)).toContain(`<summary>${summary}</summary>`)
    }
  })

  test('a worktree without a branch carries only the path', () => {
    const store = createTaskStore()
    startBackground(store, 'a-wt')
    notify(store, 'a-wt', { status: 'completed', worktreePath: '/wt/only' })
    expect(queuedTexts()[0]).toContain('<worktree><worktreePath>/wt/only</worktreePath></worktree>')
  })

  test('messages still in the mailbox are reported as unread', () => {
    const store = createTaskStore()
    startBackground(store, 'a-unread')
    queuePendingMessage('a-unread', 'are you there?', store.set)
    notify(store, 'a-unread', { status: 'completed' })
    const text = queuedTexts()[0]!
    expect(text).toContain('<unread-messages>1 message reached it after its last tool round and went unread, from: the user.')
    expect(text.endsWith('</unread-messages>\n</task-notification>')).toBe(true)
  })

  test('a second notice for the same agent is dropped', () => {
    const store = createTaskStore()
    startBackground(store, 'a-twice')
    notify(store, 'a-twice', { status: 'completed' })
    notify(store, 'a-twice', { status: 'failed' })
    expect(queuedTexts()).toHaveLength(1)
  })

  test('marking an agent notified suppresses its notice, and marking twice is a no-op', () => {
    const store = createTaskStore()
    startBackground(store, 'a-muted')
    markAgentsNotified('a-muted', store.set)
    expect(store.task<AgentRow>('a-muted').notified).toBe(true)
    const marked = store.get()
    markAgentsNotified('a-muted', store.set)
    expect(store.get()).toBe(marked)
    notify(store, 'a-muted', { status: 'completed' })
    expect(queuedTexts()).toEqual([])
  })

  test('no notice for an agent the store does not have', () => {
    const store = createTaskStore()
    notify(store, 'a-ghost', { status: 'completed' })
    expect(queuedTexts()).toEqual([])
  })
})

describe('foreground agents', () => {
  test('a foreground agent is registered but not backgrounded', () => {
    const store = createTaskStore()
    const handle = startForeground(store, 'a-fg', { toolUseId: 'toolu_fg' })
    expect(handle.taskId).toBe('a-fg')
    expect(handle.cancelAutoBackground).toBeUndefined()
    const row = store.task<AgentRow>('a-fg')
    expect([row.status, row.isBackgrounded, row.agentType, row.toolUseId]).toEqual(['running', false, 'Explore', 'toolu_fg'])
  })

  test('backgrounding flips the flag once and releases the signal', async () => {
    const store = createTaskStore()
    const { backgroundSignal } = startForeground(store, 'a-flip')
    let released = false
    void backgroundSignal.then(() => {
      released = true
    })
    expect(backgroundAgentTask('a-flip', store.get, store.set)).toBe(true)
    await Bun.sleep(0)
    expect(released).toBe(true)
    expect(store.task<AgentRow>('a-flip').isBackgrounded).toBe(true)
    expect(backgroundAgentTask('a-flip', store.get, store.set)).toBe(false)
  })

  test('backgrounding refuses ids that are not local agents', () => {
    const store = createTaskStore({ b1: { id: 'b1', type: 'local_bash', status: 'running', isBackgrounded: false } })
    const before = store.get()
    expect(backgroundAgentTask('b1', store.get, store.set)).toBe(false)
    expect(backgroundAgentTask('nope', store.get, store.set)).toBe(false)
    expect(store.get()).toBe(before)
  })

  test('the auto-background timer backgrounds a foreground agent after the delay', async () => {
    const store = createTaskStore()
    const handle = startForeground(store, 'a-auto', { autoBackgroundMs: 20 })
    expect(typeof handle.cancelAutoBackground).toBe('function')
    expect(store.task<AgentRow>('a-auto').isBackgrounded).toBe(false)
    await handle.backgroundSignal
    expect(store.task<AgentRow>('a-auto').isBackgrounded).toBe(true)
  })

  test('the timer leaves an agent alone once it was backgrounded by hand', async () => {
    const store = createTaskStore()
    startForeground(store, 'a-hand', { autoBackgroundMs: 30 })
    backgroundAgentTask('a-hand', store.get, store.set)
    const settled = store.get()
    await Bun.sleep(80)
    expect(store.get()).toBe(settled)
  })

  test('cancelling the timer keeps the agent in the foreground', async () => {
    const store = createTaskStore()
    const handle = startForeground(store, 'a-stay', { autoBackgroundMs: 20 })
    handle.cancelAutoBackground!()
    await Bun.sleep(60)
    expect(store.task<AgentRow>('a-stay').isBackgrounded).toBe(false)
  })

  test('a zero delay schedules nothing', () => {
    const store = createTaskStore()
    expect(startForeground(store, 'a-zero', { autoBackgroundMs: 0 }).cancelAutoBackground).toBeUndefined()
  })

  test('unregistering removes a foreground agent and runs its cleanup', () => {
    const store = createTaskStore()
    startForeground(store, 'a-gone')
    let cleaned = 0
    store.set(prev => ({
      ...prev,
      tasks: { ...prev.tasks, 'a-gone': { ...prev.tasks['a-gone']!, unregisterCleanup: () => cleaned++ } },
    }) as never)
    unregisterAgentForeground('a-gone', store.set)
    expect(store.get().tasks['a-gone']).toBeUndefined()
    expect(cleaned).toBe(1)
  })

  test('unregistering leaves a backgrounded agent and other task types in place', () => {
    const store = createTaskStore({ b1: { id: 'b1', type: 'local_bash', status: 'running', isBackgrounded: false } })
    startForeground(store, 'a-bg')
    backgroundAgentTask('a-bg', store.get, store.set)
    const before = store.get()
    unregisterAgentForeground('a-bg', store.set)
    unregisterAgentForeground('b1', store.set)
    expect(store.get()).toBe(before)
  })
})

