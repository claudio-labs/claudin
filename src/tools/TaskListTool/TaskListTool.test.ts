import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  createTask,
  getTaskListId,
  isTodoV2Enabled,
  resetTaskList,
} from '../../utils/tasks.js'
import { TaskListTool } from './TaskListTool.js'

let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'tasklist-'))
  process.env.CLAUDIO_CONFIG_DIR = configDir
  process.env.CLAUDE_CODE_TASK_LIST_ID = 'tasklist-test'
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

describe('TaskListTool', () => {
  test('isEnabled() reflects isTodoV2Enabled()', () => {
    expect(TaskListTool.isEnabled?.()).toBe(isTodoV2Enabled())
  })

  test('isReadOnly() and isConcurrencySafe() are true', () => {
    expect(TaskListTool.isReadOnly?.()).toBe(true)
    expect(TaskListTool.isConcurrencySafe?.()).toBe(true)
  })

  test('input schema accepts only empty object', () => {
    expect(TaskListTool.inputSchema.safeParse({}).success).toBe(true)
    expect(TaskListTool.inputSchema.safeParse({ x: 1 }).success).toBe(false)
  })

  test('call() returns empty list when no tasks exist', async () => {
    const { data } = await TaskListTool.call()
    expect(data.tasks).toEqual([])
  })

  test('call() returns stored tasks and hides _internal entries', async () => {
    const lid = getTaskListId()
    const visible = await createTask(lid, {
      subject: 'visible',
      description: 'd',
      status: 'pending',
      owner: 'alice',
      blocks: [],
      blockedBy: [],
    })
    await createTask(lid, {
      subject: 'internal',
      description: 'd',
      status: 'pending',
      owner: undefined,
      blocks: [],
      blockedBy: [],
      metadata: { _internal: true },
    })

    const { data } = await TaskListTool.call()
    expect(data.tasks).toHaveLength(1)
    expect(data.tasks[0]?.id).toBe(visible)
    expect(data.tasks[0]?.owner).toBe('alice')
  })

  test('call() filters resolved blockers out of blockedBy', async () => {
    const lid = getTaskListId()
    const blocker = await createTask(lid, {
      subject: 'blocker',
      description: 'd',
      status: 'completed',
      owner: undefined,
      blocks: [],
      blockedBy: [],
    })
    const dependent = await createTask(lid, {
      subject: 'dependent',
      description: 'd',
      status: 'pending',
      owner: undefined,
      blocks: [],
      blockedBy: [blocker],
    })

    const { data } = await TaskListTool.call()
    const dep = data.tasks.find(t => t.id === dependent)
    expect(dep?.blockedBy).toEqual([])
  })

  test('mapToolResultToToolResultBlockParam handles empty and populated cases', () => {
    const map = TaskListTool.mapToolResultToToolResultBlockParam
    expect(map).toBeDefined()
    expect(map?.({ tasks: [] }, 'u')?.content).toBe('No tasks found')

    const block = map?.(
      {
        tasks: [
          {
            id: '1',
            subject: 'a',
            status: 'pending',
            owner: 'alice',
            blockedBy: ['2'],
          },
        ],
      },
      'u',
    )
    expect(block?.content).toBe('#1 [pending] a (alice) [blocked by #2]')
  })
})
