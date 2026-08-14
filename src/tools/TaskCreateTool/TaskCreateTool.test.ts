import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from 'src/Tool.js'
import {
  getTaskListId,
  isTodoV2Enabled,
  listTasks,
  resetTaskList,
} from 'src/utils/tasks.js'
import { TaskCreateTool } from './TaskCreateTool.js'

// Pin task list ID + isolated config dir so each test sees a clean store.
let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'taskcreate-'))
  process.env.CLAUDIN_CONFIG_DIR = configDir
  process.env.CLAUDE_CODE_TASK_LIST_ID = 'taskcreate-test'
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

function makeContext(): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({ expandedView: null }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

describe('TaskCreateTool', () => {
  test('isEnabled reflects isTodoV2Enabled()', () => {
    expect(TaskCreateTool.isEnabled?.()).toBe(isTodoV2Enabled())
  })

  test('input schema requires subject and description', () => {
    const schema = TaskCreateTool.inputSchema
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.safeParse({ subject: 'a' }).success).toBe(false)
    expect(schema.safeParse({ subject: 'a', description: 'b' }).success).toBe(
      true,
    )
  })

  test('input schema rejects unknown keys', () => {
    const result = TaskCreateTool.inputSchema.safeParse({
      subject: 'a',
      description: 'b',
      bogus: 1,
    })
    expect(result.success).toBe(false)
  })

  test('call() persists the task and returns its id', async () => {
    const { data } = await TaskCreateTool.call(
      {
        subject: 'write tests',
        description: 'cover task tools',
      } as never,
      makeContext(),
    )

    expect(data.task.subject).toBe('write tests')
    expect(typeof data.task.id).toBe('string')
    expect(data.task.id.length).toBeGreaterThan(0)

    const tasks = await listTasks(getTaskListId())
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.id).toBe(data.task.id)
    expect(tasks[0]?.subject).toBe('write tests')
    expect(tasks[0]?.status).toBe('pending')
    expect(tasks[0]?.blocks).toEqual([])
    expect(tasks[0]?.blockedBy).toEqual([])
  })

  test('call() preserves activeForm and metadata when provided', async () => {
    const { data } = await TaskCreateTool.call(
      {
        subject: 'do thing',
        description: 'thing',
        activeForm: 'Doing thing',
        metadata: { source: 'unit-test' },
      } as never,
      makeContext(),
    )

    const tasks = await listTasks(getTaskListId())
    const stored = tasks.find(t => t.id === data.task.id)
    expect(stored?.activeForm).toBe('Doing thing')
    expect(stored?.metadata).toEqual({ source: 'unit-test' })
  })

  test('call() auto-expands the tasks view via setAppState', async () => {
    let captured: { expandedView?: string | null } | undefined
    const ctx = {
      abortController: new AbortController(),
      getAppState: () => ({ expandedView: null }),
      setAppState: (
        updater: (
          prev: { expandedView: string | null },
        ) => { expandedView: string | null },
      ) => {
        captured = updater({ expandedView: null })
      },
      options: {},
    } as unknown as ToolUseContext

    await TaskCreateTool.call(
      { subject: 's', description: 'd' } as never,
      ctx,
    )
    expect(captured?.expandedView).toBe('tasks')
  })

  test('mapToolResultToToolResultBlockParam summarises the task', () => {
    const mapResult = TaskCreateTool.mapToolResultToToolResultBlockParam
    expect(mapResult).toBeDefined()
    const block = mapResult?.(
      { task: { id: '7', subject: 'review PRs' } },
      'use-1',
    )
    expect(block).toEqual({
      tool_use_id: 'use-1',
      type: 'tool_result',
      content: 'Task #7 created successfully: review PRs',
    })
  })
})
