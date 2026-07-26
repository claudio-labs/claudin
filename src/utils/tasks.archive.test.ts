import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  archiveCompletedTasks,
  createTask,
  getTaskListId,
  getTaskPath,
  listTasks,
  resetTaskList,
} from './tasks.js'

let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'taskarchive-'))
  process.env.CLAUDIN_CONFIG_DIR = configDir
  process.env.CLAUDE_CODE_TASK_LIST_ID = 'taskarchive-test'
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

function seed(
  subject: string,
  status: 'pending' | 'in_progress' | 'completed',
): Promise<string> {
  return createTask(getTaskListId(), {
    subject,
    description: '',
    activeForm: undefined,
    status,
    owner: undefined,
    blocks: [],
    blockedBy: [],
  })
}

describe('archiveCompletedTasks', () => {
  test('flags completed tasks _internal without deleting the file', async () => {
    const id = await seed('done thing', 'completed')

    const archived = await archiveCompletedTasks(getTaskListId())

    expect(archived).toBe(1)
    // The whole point of archiving over resetTaskList: the JSON survives.
    expect(existsSync(getTaskPath(getTaskListId(), id))).toBe(true)
    const stored = (await listTasks(getTaskListId())).find(t => t.id === id)
    expect(stored?.metadata?._internal).toBe(true)
    expect(stored?.status).toBe('completed')
  })

  test('leaves open tasks alone', async () => {
    const pending = await seed('still to do', 'pending')
    const active = await seed('in flight', 'in_progress')
    await seed('done thing', 'completed')

    expect(await archiveCompletedTasks(getTaskListId())).toBe(1)

    const byId = new Map((await listTasks(getTaskListId())).map(t => [t.id, t]))
    expect(byId.get(pending)?.metadata?._internal).toBeUndefined()
    expect(byId.get(active)?.metadata?._internal).toBeUndefined()
  })

  test('is idempotent — a second pass archives nothing', async () => {
    await seed('done thing', 'completed')

    expect(await archiveCompletedTasks(getTaskListId())).toBe(1)
    expect(await archiveCompletedTasks(getTaskListId())).toBe(0)
  })

  test('preserves existing metadata keys', async () => {
    const id = await createTask(getTaskListId(), {
      subject: 'from a plan',
      description: '',
      activeForm: undefined,
      status: 'completed',
      owner: undefined,
      blocks: [],
      blockedBy: [],
      metadata: { source: 'plan' },
    })

    await archiveCompletedTasks(getTaskListId())

    const stored = (await listTasks(getTaskListId())).find(t => t.id === id)
    expect(stored?.metadata?.source).toBe('plan')
    expect(stored?.metadata?._internal).toBe(true)
  })

  test('keeps IDs climbing across an archived batch', async () => {
    const first = await seed('done thing', 'completed')
    await archiveCompletedTasks(getTaskListId())
    const second = await seed('next thing', 'pending')

    expect(Number(second)).toBeGreaterThan(Number(first))
  })
})
