import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from '../../Tool.js'
import {
  createTask,
  getTask,
  getTaskListId,
  isTodoV2Enabled,
  listTasks,
  resetTaskList,
} from '../../utils/tasks.js'
import { TaskUpdateTool } from './TaskUpdateTool.js'

let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'taskupdate-'))
  process.env.CLAUDIO_CONFIG_DIR = configDir
  process.env.CLAUDE_CODE_TASK_LIST_ID = 'taskupdate-test'
  process.env.CLAUDE_CODE_ENABLE_TASKS = '1'
})

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
  delete process.env.CLAUDIO_CONFIG_DIR
  delete process.env.CLAUDE_CODE_TASK_LIST_ID
  delete process.env.CLAUDE_CODE_ENABLE_TASKS
})

afterEach(async () => {
  await resetTaskList(getTaskListId())
})

function makeContext(): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({ expandedView: null }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

async function seedTask(overrides: Partial<{
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed'
  owner: string | undefined
  blocks: string[]
  blockedBy: string[]
  metadata: Record<string, unknown>
}> = {}): Promise<string> {
  return createTask(getTaskListId(), {
    subject: overrides.subject ?? 's',
    description: overrides.description ?? 'd',
    activeForm: undefined,
    status: overrides.status ?? 'pending',
    owner: overrides.owner,
    blocks: overrides.blocks ?? [],
    blockedBy: overrides.blockedBy ?? [],
    metadata: overrides.metadata,
  })
}

describe('TaskUpdateTool', () => {
  test('isEnabled reflects isTodoV2Enabled()', () => {
    expect(TaskUpdateTool.isEnabled?.()).toBe(isTodoV2Enabled())
  })

  test('input schema requires taskId; accepts deleted status', () => {
    expect(TaskUpdateTool.inputSchema.safeParse({}).success).toBe(false)
    expect(
      TaskUpdateTool.inputSchema.safeParse({
        taskId: '1',
        status: 'deleted',
      }).success,
    ).toBe(true)
    expect(
      TaskUpdateTool.inputSchema.safeParse({
        taskId: '1',
        status: 'bogus',
      }).success,
    ).toBe(false)
  })

  test('updates basic fields only when they change', async () => {
    const id = await seedTask({ subject: 'old', description: 'old' })

    const { data } = await TaskUpdateTool.call(
      {
        taskId: id,
        subject: 'new',
        description: 'old', // unchanged: should not be reported
      } as never,
      makeContext(),
    )
    expect(data.success).toBe(true)
    expect(data.updatedFields).toEqual(['subject'])

    const stored = await getTask(getTaskListId(), id)
    expect(stored?.subject).toBe('new')
    expect(stored?.description).toBe('old')
  })

  test('status change reports statusChange and persists', async () => {
    const id = await seedTask({ status: 'pending' })

    const { data } = await TaskUpdateTool.call(
      { taskId: id, status: 'in_progress' } as never,
      makeContext(),
    )
    expect(data.success).toBe(true)
    expect(data.statusChange).toEqual({ from: 'pending', to: 'in_progress' })

    const stored = await getTask(getTaskListId(), id)
    expect(stored?.status).toBe('in_progress')
  })

  test('status=deleted removes the task file', async () => {
    const id = await seedTask()

    const { data } = await TaskUpdateTool.call(
      { taskId: id, status: 'deleted' } as never,
      makeContext(),
    )
    expect(data.success).toBe(true)
    expect(data.updatedFields).toEqual(['deleted'])
    expect(data.statusChange).toEqual({ from: 'pending', to: 'deleted' })

    expect(await getTask(getTaskListId(), id)).toBeNull()
    expect(await listTasks(getTaskListId())).toEqual([])
  })

  test('non-existent task returns success=false with error', async () => {
    const { data } = await TaskUpdateTool.call(
      { taskId: '999', subject: 'x' } as never,
      makeContext(),
    )
    expect(data.success).toBe(false)
    expect(data.error).toBe('Task not found')
  })

  test('metadata merges and supports key deletion via null', async () => {
    const id = await seedTask({ metadata: { keep: 1, drop: 2 } })

    await TaskUpdateTool.call(
      {
        taskId: id,
        metadata: { drop: null, add: 'x' },
      } as never,
      makeContext(),
    )

    const stored = await getTask(getTaskListId(), id)
    expect(stored?.metadata).toEqual({ keep: 1, add: 'x' })
  })

  test('addBlockedBy wires the reverse blocks relationship', async () => {
    const blocker = await seedTask({ subject: 'blocker' })
    const dependent = await seedTask({ subject: 'dependent' })

    const { data } = await TaskUpdateTool.call(
      { taskId: dependent, addBlockedBy: [blocker] } as never,
      makeContext(),
    )
    expect(data.success).toBe(true)
    expect(data.updatedFields).toContain('blockedBy')

    const dep = await getTask(getTaskListId(), dependent)
    const blk = await getTask(getTaskListId(), blocker)
    expect(dep?.blockedBy).toEqual([blocker])
    expect(blk?.blocks).toEqual([dependent])
  })

  test('mapToolResultToToolResultBlockParam reports error and success', () => {
    const map = TaskUpdateTool.mapToolResultToToolResultBlockParam
    expect(map).toBeDefined()
    const err = map?.(
      {
        success: false,
        taskId: '7',
        updatedFields: [],
        error: 'boom',
      },
      'u',
    )
    expect(err?.content).toBe('boom')

    const ok = map?.(
      {
        success: true,
        taskId: '7',
        updatedFields: ['subject', 'status'],
      },
      'u',
    )
    expect(ok?.content).toBe('Updated task #7 subject, status')
  })
})
