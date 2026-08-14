import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  createTask,
  getTaskListId,
  isTodoV2Enabled,
  resetTaskList,
} from 'src/utils/tasks.js'
import { TaskGetTool } from './TaskGetTool.js'

let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'taskget-'))
  process.env.CLAUDIN_CONFIG_DIR = configDir
  process.env.CLAUDE_CODE_TASK_LIST_ID = 'taskget-test'
  process.env.CLAUDE_CODE_ENABLE_TASKS = '1'
})

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
  delete process.env.CLAUDIN_CONFIG_DIR
  delete process.env.CLAUDE_CODE_TASK_LIST_ID
  delete process.env.CLAUDE_CODE_ENABLE_TASKS
})

afterEach(async () => {
  await resetTaskList(getTaskListId())
})

describe('TaskGetTool', () => {
  test('isEnabled reflects isTodoV2Enabled()', () => {
    expect(TaskGetTool.isEnabled?.()).toBe(isTodoV2Enabled())
  })

  test('isReadOnly() and isConcurrencySafe() are true', () => {
    expect(TaskGetTool.isReadOnly?.()).toBe(true)
    expect(TaskGetTool.isConcurrencySafe?.()).toBe(true)
  })

  test('input schema requires taskId and rejects unknown keys', () => {
    expect(TaskGetTool.inputSchema.safeParse({}).success).toBe(false)
    expect(
      TaskGetTool.inputSchema.safeParse({ taskId: '1', extra: true }).success,
    ).toBe(false)
    expect(TaskGetTool.inputSchema.safeParse({ taskId: '1' }).success).toBe(
      true,
    )
  })

  test('call() returns the task fields when it exists', async () => {
    const id = await createTask(getTaskListId(), {
      subject: 'subj',
      description: 'desc',
      activeForm: undefined,
      status: 'in_progress',
      owner: undefined,
      blocks: [],
      blockedBy: ['9'],
    })

    const { data } = await TaskGetTool.call({ taskId: id } as never)
    expect(data.task).toEqual({
      id,
      subject: 'subj',
      description: 'desc',
      status: 'in_progress',
      blocks: [],
      blockedBy: ['9'],
    })
  })

  test('call() returns null task for unknown id', async () => {
    const { data } = await TaskGetTool.call({ taskId: '999' } as never)
    expect(data.task).toBeNull()
  })

  test('mapToolResultToToolResultBlockParam renders status, blocks and blockedBy', () => {
    const map = TaskGetTool.mapToolResultToToolResultBlockParam
    expect(map).toBeDefined()
    const notFound = map?.({ task: null }, 'u1')
    expect(notFound?.content).toBe('Task not found')

    const block = map?.(
      {
        task: {
          id: '3',
          subject: 'hi',
          description: 'd',
          status: 'pending',
          blocks: ['4'],
          blockedBy: ['1', '2'],
        },
      },
      'u2',
    )
    expect(block?.content).toContain('Task #3: hi')
    expect(block?.content).toContain('Status: pending')
    expect(block?.content).toContain('Description: d')
    expect(block?.content).toContain('Blocked by: #1, #2')
    expect(block?.content).toContain('Blocks: #4')
  })
})
