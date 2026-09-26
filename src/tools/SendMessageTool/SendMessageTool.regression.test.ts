import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getCommandQueueSnapshot,
  resetCommandQueue,
} from 'src/agent/messageQueueManager.js'
import type { AppState } from 'src/terminal/state/AppState.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { SendMessageTool } from 'src/tools/SendMessageTool/SendMessageTool.js'

// Characterization net for the agent-messaging work. Messaging between agents
// is an opt-in extra, so what a send already does must survive it: the OUTCOME
// of each route is pinned here — queued, resumed, refused — and deliberately
// not its wording, which the sender envelope changes on purpose.

let configDir: string
const savedConfigDir = process.env.CLAUDIN_CONFIG_DIR

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'send-message-regression-'))
  process.env.CLAUDIN_CONFIG_DIR = configDir
})

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = savedConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

afterEach(() => {
  resetCommandQueue()
})

const RUNNING_ID = 'a0123456789abcdef'
const INLINE_ID = 'a1123456789abcdef'
const STOPPED_ID = 'a2123456789abcdef'

type FakeAgentTask = {
  type: 'local_agent'
  agentType: string
  agentId: string
  description: string
  status: string
  isBackgrounded: boolean
  pendingMessages: string[]
}

function agentTask(agentId: string, status: string, isBackgrounded: boolean): FakeAgentTask {
  return {
    type: 'local_agent',
    agentType: 'Code',
    agentId,
    description: `task ${agentId}`,
    status,
    isBackgrounded,
    pendingMessages: [],
  }
}

function harness(agentId?: string) {
  let state = {
    tasks: {
      [RUNNING_ID]: agentTask(RUNNING_ID, 'running', true),
      [INLINE_ID]: agentTask(INLINE_ID, 'running', false),
      [STOPPED_ID]: agentTask(STOPPED_ID, 'completed', true),
    } as Record<string, FakeAgentTask>,
    agentNameRegistry: new Map([
      ['worker', RUNNING_ID],
      ['finished', STOPPED_ID],
    ]),
    toolPermissionContext: { mode: 'default' },
  }
  const setAppState = (f: (prev: AppState) => AppState): void => {
    state = f(state as unknown as AppState) as unknown as typeof state
  }
  const context = {
    agentId,
    getAppState: () => state,
    setAppState,
  } as unknown as ToolUseContext
  return { context, pending: (id: string) => state.tasks[id]!.pendingMessages }
}

async function send(input: Record<string, unknown>, context: ToolUseContext) {
  const result = await SendMessageTool.call(
    input as never,
    context,
    (() => {}) as never,
    undefined as never,
  )
  return result.data as { success: boolean; message: string }
}

describe('SendMessage routes — outcomes that must not change', () => {
  test('main → a running background agent by name: queued for its next tool round', async () => {
    const { context, pending } = harness()
    const data = await send({ to: 'worker', message: 'check the pod' }, context)
    expect(data.success).toBe(true)
    expect(pending(RUNNING_ID)).toHaveLength(1)
    expect(pending(RUNNING_ID)[0]).toContain('check the pod')
    expect(getCommandQueueSnapshot()).toEqual([])
  })

  test('a running agent is reachable by its raw agentId too', async () => {
    const { context, pending } = harness()
    const data = await send({ to: RUNNING_ID, message: 'ping' }, context)
    expect(data.success).toBe(true)
    expect(pending(RUNNING_ID)).toHaveLength(1)
  })

  test('a running INLINE agent is reachable by agentId and queues the same way', async () => {
    const { context, pending } = harness(RUNNING_ID)
    const data = await send({ to: INLINE_ID, message: 'ping' }, context)
    expect(data.success).toBe(true)
    expect(pending(INLINE_ID)).toHaveLength(1)
  })

  test('a stopped agent is resumed, not queued — here it has no transcript, so the resume fails', async () => {
    const { context, pending } = harness()
    const data = await send({ to: 'finished', message: 'one more thing' }, context)
    expect(data.success).toBe(false)
    expect(data.message).toContain('could not be resumed')
    expect(pending(STOPPED_ID)).toEqual([])
  })

  test('a background agent reaches "main" through the command queue', async () => {
    const { context } = harness(RUNNING_ID)
    const data = await send({ to: 'main', message: 'found it' }, context)
    expect(data.success).toBe(true)
    const [queued] = getCommandQueueSnapshot()
    expect(queued?.mode).toBe('task-notification')
    expect(queued?.agentId).toBeUndefined()
    expect(String(queued?.value)).toContain('found it')
  })

  test('an inline agent cannot write to "main"', async () => {
    const { context } = harness(INLINE_ID)
    await expect(send({ to: 'main', message: 'hi' }, context)).rejects.toThrow()
    expect(getCommandQueueSnapshot()).toEqual([])
  })

  test('an unknown name fails loudly and points at ListAgents', async () => {
    const { context } = harness()
    await expect(send({ to: 'nobody', message: 'hi' }, context)).rejects.toThrow('ListAgents')
  })
})
