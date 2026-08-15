import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from 'src/Tool.js'
import type { Message } from 'src/types/message.js'
import { getAttachments } from 'src/agent/attachments/attachments.js'
import { createTask, getTaskListId, resetTaskList } from 'src/tasks/tasks.js'

const TASK_LIST_ID = 'reconcile-pipeline-test'
let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'reconcile-pipeline-'))
  process.env.CLAUDIN_CONFIG_DIR = configDir
  process.env.CLAUDE_CODE_TASK_LIST_ID = TASK_LIST_ID
  process.env.CLAUDE_CODE_ENABLE_TASKS = '1'
})

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
  delete process.env.CLAUDIN_CONFIG_DIR
  delete process.env.CLAUDE_CODE_TASK_LIST_ID
  delete process.env.CLAUDE_CODE_ENABLE_TASKS
  delete process.env.CLAUDIN_DISABLE_TASK_RECONCILE
})

beforeEach(async () => {
  delete process.env.CLAUDIN_DISABLE_TASK_RECONCILE
  await resetTaskList(getTaskListId())
})

function makeContext(agentId?: string): ToolUseContext {
  return {
    agentId,
    options: {
      tools: [],
      mcpClients: [],
      agentDefinitions: { activeAgents: [] },
      mainLoopModel: 'test-model',
    },
    getAppState: () => ({ toolPermissionContext: {}, mcp: { commands: [] } }),
    setAppState: () => {},
    readFileState: new Map(),
  } as unknown as ToolUseContext
}

/** A completed turn with four tool calls, none of them Task*. */
function workedTurn(): Message[] {
  const assistant = (...names: string[]) =>
    ({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: names.map((name, i) => ({
          type: 'tool_use',
          id: `tu_${i}`,
          name,
          input: {},
        })),
      },
    }) as unknown as Message
  return [
    { type: 'user', message: { role: 'user', content: 'go' } },
    assistant('Read', 'Grep'),
    assistant('Edit', 'Bash'),
  ] as unknown as Message[]
}

function seedOpenTask(): Promise<string> {
  return createTask(getTaskListId(), {
    subject: 'left pending',
    description: '',
    activeForm: undefined,
    status: 'pending',
    owner: undefined,
    blocks: [],
    blockedBy: [],
  })
}

async function reconcileAttachments(
  input: string | null,
  context = makeContext(),
): Promise<unknown[]> {
  const all = await getAttachments(input, context, null, [], workedTurn())
  return all.filter(a => a.type === 'task_reconcile')
}

describe('task_reconcile in the attachment pipeline', () => {
  test('rides along with a real user prompt', async () => {
    await seedOpenTask()
    expect(await reconcileAttachments('what next?')).toHaveLength(1)
  })

  test('never fires on a mid-turn pass (input === null)', async () => {
    await seedOpenTask()
    // The tool loop re-runs this pipeline after every batch of tool results
    // with no input. Attaching there staples the reminder onto a file read,
    // which reads to the model as injected text — it said so when tried.
    expect(await reconcileAttachments(null)).toEqual([])
  })

  test('never fires for a subagent', async () => {
    await seedOpenTask()
    expect(
      await reconcileAttachments('what next?', makeContext('agent_123')),
    ).toEqual([])
  })

  test('honours the killswitch', async () => {
    await seedOpenTask()
    process.env.CLAUDIN_DISABLE_TASK_RECONCILE = '1'
    expect(await reconcileAttachments('what next?')).toEqual([])
  })

  test('stays silent when the list is empty', async () => {
    expect(await reconcileAttachments('what next?')).toEqual([])
  })
})
