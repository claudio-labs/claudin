import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from 'src/tools/Tool.js'
import type { Message } from 'src/shared/types/message.js'
import { createTask, getTaskListId, resetTaskList } from 'src/agent/tasks/tasks.js'
import { getTaskReminderAttachments } from 'src/agent/attachments/lifecycle.js'

const TASK_LIST_ID = 'lifecycle-archived-test'
let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'lifecycle-archived-'))
  process.env.CLAUDIN_CONFIG_DIR = configDir
  process.env.CLAUDIN_TASK_LIST_ID = TASK_LIST_ID
  process.env.CLAUDIN_ENABLE_TASKS = '1'
})

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
  delete process.env.CLAUDIN_CONFIG_DIR
  delete process.env.CLAUDIN_TASK_LIST_ID
  delete process.env.CLAUDIN_ENABLE_TASKS
})

beforeEach(async () => {
  await resetTaskList(getTaskListId())
})

function makeContext(): ToolUseContext {
  return {
    options: { tools: [{ name: 'TaskUpdate' }] },
    getAppState: () => ({ todos: {} }),
    setAppState: () => {},
  } as unknown as ToolUseContext
}

/**
 * Assistant turns with no Task* call in them. The reminder needs
 * TASK_TURNS_SINCE_WRITE of these (and no earlier reminder) before it fires.
 */
function quietTurns(count = 12): Message[] {
  return Array.from({ length: count }, () => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  })) as unknown as Message[]
}

function seed(
  subject: string,
  status: 'pending' | 'completed',
  archived = false,
): Promise<string> {
  return createTask(getTaskListId(), {
    subject,
    description: '',
    activeForm: undefined,
    status,
    owner: undefined,
    blocks: [],
    blockedBy: [],
    metadata: archived ? { _internal: true } : undefined,
  })
}

describe('getTaskReminderAttachments — archived tasks', () => {
  test('keeps archived tasks out of the snapshot sent to the model', async () => {
    // Archived first so it takes id 1 and the live one takes id 2 — the
    // snapshot only carries ids and statuses, not the subject text.
    await seed('finished and hidden', 'completed', true)
    await seed('still open', 'pending')

    const out = await getTaskReminderAttachments(quietTurns(), makeContext())

    expect(out).toHaveLength(1)
    const attachment = out[0]!
    expect(attachment.type).toBe('todo_reminder_delta')
    if (attachment.type !== 'todo_reminder_delta') return
    // Archiving is what the hide timer does. The user watched task #1 leave
    // the screen; re-listing it in the model's context on every reminder is
    // the leak that deleting the file used to hide.
    expect(attachment.snapshot.map(s => s.id)).toEqual(['#2'])
    expect(attachment.added.map(a => a.text)).toEqual(['still open'])
  })

  test('reports an empty list when every remaining task is archived', async () => {
    await seed('finished and hidden', 'completed', true)

    const out = await getTaskReminderAttachments(quietTurns(), makeContext())

    const attachment = out[0]!
    expect(attachment.type).toBe('todo_reminder_delta')
    if (attachment.type !== 'todo_reminder_delta') return
    expect(attachment.snapshot).toEqual([])
    expect(attachment.added).toEqual([])
  })
})

// These counters are assistant messages and the pipeline re-runs after every
// batch of tool results, so this is what decides how deep into a working turn
// the model gets before anything reminds it the list exists.
describe('getTaskReminderAttachments — how soon it speaks up', () => {
  test('fires after 4 quiet assistant turns', async () => {
    await seed('still open', 'pending')

    const out = await getTaskReminderAttachments(quietTurns(4), makeContext())

    expect(out).toHaveLength(1)
  })

  test('stays quiet at 3', async () => {
    await seed('still open', 'pending')

    const out = await getTaskReminderAttachments(quietTurns(3), makeContext())

    expect(out).toEqual([])
  })
})
