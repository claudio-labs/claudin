import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  createTeammateContext,
  runWithTeammateContext,
} from 'src/agent/coordinator/teammateContext.js'
import {
  blockTask,
  claimTask,
  clearLeaderTeamName,
  createTask,
  deleteTask,
  getTask,
  getTaskListId,
  getTaskPath,
  getTasksDir,
  isTodoV2Enabled,
  listTasks,
  onTasksUpdated,
  resetTaskList,
  sanitizePathComponent,
  setLeaderTeamName,
  unassignTeammateTasks,
  updateTask,
} from 'src/agent/tasks/tasks.js'
import { getSessionId } from 'src/platform/bootstrap/state.js'

const LIST = 'tasks-test'
const ENV_KEYS = ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_TASK_LIST_ID', 'CLAUDIN_ENABLE_TASKS', 'CLAUDE_CODE_TEAM_NAME']
const saved: Record<string, string | undefined> = {}
let root: string

const base = { description: '', status: 'pending' as const, blocks: [], blockedBy: [] }

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  root = mkdtempSync(join(tmpdir(), 'tasks-test-'))
  process.env.CLAUDIN_CONFIG_DIR = root
  delete process.env.CLAUDIN_TASK_LIST_ID
  delete process.env.CLAUDIN_ENABLE_TASKS
  delete process.env.CLAUDE_CODE_TEAM_NAME
})

afterEach(() => {
  clearLeaderTeamName()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(root, { recursive: true, force: true })
})

describe('task store', () => {
  test('creates tasks with climbing ids and reads them back', async () => {
    expect(await createTask(LIST, { ...base, subject: 'one' })).toBe('1')
    expect(await createTask(LIST, { ...base, subject: 'two' })).toBe('2')
    expect(await getTask(LIST, '2')).toEqual({ id: '2', ...base, subject: 'two' })
    expect(await getTask(LIST, '9')).toBeNull()
    expect((await listTasks(LIST)).map(t => t.subject).sort()).toEqual(['one', 'two'])
  })

  test('a list that was never written is empty', async () => {
    expect(await listTasks('never-written')).toEqual([])
  })

  test('lists tasks in id order whatever order the directory returns them in', async () => {
    for (let i = 1; i <= 12; i++) await createTask(LIST, { ...base, subject: `t${i}` })
    expect((await listTasks(LIST)).map(t => t.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'])
  })

  test('a file that fails the schema or does not parse reads as missing', async () => {
    await createTask(LIST, { ...base, subject: 'ok' })
    writeFileSync(getTaskPath(LIST, '2'), JSON.stringify({ id: '2', subject: 'no status' }))
    writeFileSync(getTaskPath(LIST, '3'), '{not json')
    expect(await getTask(LIST, '2')).toBeNull()
    expect(await getTask(LIST, '3')).toBeNull()
    expect((await listTasks(LIST)).map(t => t.id)).toEqual(['1'])
  })

  test('updates merge into the task and keep its id; a missing task updates to null', async () => {
    await createTask(LIST, { ...base, subject: 'one' })
    const updated = await updateTask(LIST, '1', { status: 'in_progress', id: 'x' } as never)
    expect(updated?.id).toBe('1')
    expect(updated?.status).toBe('in_progress')
    expect((await getTask(LIST, '1'))?.status).toBe('in_progress')
    expect(await updateTask(LIST, '42', { status: 'completed' })).toBeNull()
  })

  test('deleting a task frees no id, and drops every reference to it', async () => {
    await createTask(LIST, { ...base, subject: 'a' })
    await createTask(LIST, { ...base, subject: 'b' })
    await blockTask(LIST, '1', '2')
    expect(await deleteTask(LIST, '1')).toBe(true)
    expect((await getTask(LIST, '2'))?.blockedBy).toEqual([])
    expect(await deleteTask(LIST, '1')).toBe(false)
    // The high water mark keeps the deleted id out of reuse, even when it was the highest.
    expect(await deleteTask(LIST, '2')).toBe(true)
    expect(await createTask(LIST, { ...base, subject: 'c' })).toBe('3')
  })

  test('a reset clears the list and numbering carries on past it', async () => {
    await createTask(LIST, { ...base, subject: 'a' })
    await createTask(LIST, { ...base, subject: 'b' })
    await resetTaskList(LIST)
    expect(await listTasks(LIST)).toEqual([])
    expect(readFileSync(join(getTasksDir(LIST), '.highwatermark'), 'utf8')).toBe('2')
    expect(await createTask(LIST, { ...base, subject: 'c' })).toBe('3')
    await resetTaskList('empty-list')
    expect(await listTasks('empty-list')).toEqual([])
  })

  test('blocking records both sides once, and refuses an unknown task', async () => {
    await createTask(LIST, { ...base, subject: 'a' })
    await createTask(LIST, { ...base, subject: 'b' })
    expect(await blockTask(LIST, '1', '2')).toBe(true)
    expect(await blockTask(LIST, '1', '2')).toBe(true)
    expect((await getTask(LIST, '1'))?.blocks).toEqual(['2'])
    expect((await getTask(LIST, '2'))?.blockedBy).toEqual(['1'])
    expect(await blockTask(LIST, '1', '99')).toBe(false)
  })
})

describe('claiming', () => {
  beforeEach(async () => {
    await createTask(LIST, { ...base, subject: 'free' })
    await createTask(LIST, { ...base, subject: 'blocked' })
    await createTask(LIST, { ...base, subject: 'done', status: 'completed' })
    await blockTask(LIST, '1', '2')
  })

  test('claims a free task and refuses the other cases', async () => {
    expect(await claimTask(LIST, '9', 'me')).toEqual({ success: false, reason: 'task_not_found' })
    expect((await claimTask(LIST, '3', 'me')).reason).toBe('already_resolved')
    const blocked = await claimTask(LIST, '2', 'me')
    expect(blocked.reason).toBe('blocked')
    expect(blocked.blockedByTasks).toEqual(['1'])
    const won = await claimTask(LIST, '1', 'me')
    expect(won.success).toBe(true)
    expect(won.task?.owner).toBe('me')
    expect((await claimTask(LIST, '1', 'other')).reason).toBe('already_claimed')
  })

  test('with the busy check, an agent that already owns an open task is refused', async () => {
    await createTask(LIST, { ...base, subject: 'second free' })
    expect((await claimTask(LIST, '1', 'me', { checkAgentBusy: true })).success).toBe(true)
    const busy = await claimTask(LIST, '4', 'me', { checkAgentBusy: true })
    expect(busy.reason).toBe('agent_busy')
    expect(busy.busyWithTasks).toEqual(['1'])
    expect((await claimTask(LIST, '1', 'other', { checkAgentBusy: true })).reason).toBe('already_claimed')
    expect((await claimTask(LIST, '3', 'other', { checkAgentBusy: true })).reason).toBe('already_resolved')
    expect((await claimTask(LIST, '2', 'other', { checkAgentBusy: true })).reason).toBe('blocked')
    expect((await claimTask(LIST, '4', 'other', { checkAgentBusy: true })).success).toBe(true)
  })

  test("a teammate's open tasks go back to pending when it leaves", async () => {
    await claimTask(LIST, '1', 'worker')
    const result = await unassignTeammateTasks(LIST, 'worker', 'Worker', 'terminated')
    expect(result.unassignedTasks).toEqual([{ id: '1', subject: 'free' }])
    expect(result.notificationMessage).toContain('Worker was terminated. 1 task(s) were unassigned: #1 "free"')
    expect((await getTask(LIST, '1'))?.owner).toBeUndefined()
    const none = await unassignTeammateTasks(LIST, 'nobody', 'Nobody', 'shutdown')
    expect(none.notificationMessage).toBe('Nobody has shut down.')
  })
})

describe('task list identity', () => {
  test('resolves the explicit id, then the teammate team, then the leader team, then the session', () => {
    expect(getTaskListId()).toBe(getSessionId())
    setLeaderTeamName('crew')
    expect(getTaskListId()).toBe('crew')
    const ctx = createTeammateContext({
      agentId: 'a@squad',
      agentName: 'a',
      teamName: 'squad',
      planModeRequired: false,
      parentSessionId: 'p',
      abortController: new AbortController(),
    })
    expect(runWithTeammateContext(ctx, () => getTaskListId())).toBe('squad')
    process.env.CLAUDIN_TASK_LIST_ID = 'explicit'
    expect(runWithTeammateContext(ctx, () => getTaskListId())).toBe('explicit')
  })

  test('changing the leader team notifies listeners once, and a throwing listener is contained', () => {
    let calls = 0
    const off = onTasksUpdated(() => {
      calls++
    })
    const offBad = onTasksUpdated(() => {
      throw new Error('listener')
    })
    setLeaderTeamName('crew')
    setLeaderTeamName('crew')
    clearLeaderTeamName()
    clearLeaderTeamName()
    off()
    offBad()
    expect(calls).toBe(2)
  })

  test('path components are sanitized', () => {
    expect(sanitizePathComponent('../a b/c')).toBe('---a-b-c')
    expect(getTaskPath('x/y', '../1')).toBe(join(root, 'tasks', 'x-y', '---1.json'))
  })

  test('TodoV2 is forced on by the env switch', () => {
    process.env.CLAUDIN_ENABLE_TASKS = '1'
    expect(isTodoV2Enabled()).toBe(true)
  })
})
