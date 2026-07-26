import { describe, expect, test } from 'bun:test'
import type { Message } from '../types/message.js'
import type { Task } from '../utils/tasks.js'
import {
  TASK_RECONCILE_MARKER,
  buildTaskReconcileReminder,
  shouldReconcileTasks,
} from './taskReconcile.js'

// Plain literals rather than the message factories: this module only reads
// `type`, `isMeta` and the content blocks, and hand-built fixtures keep the
// test free of the factories' import chain.
function userPrompt(text = 'do the thing'): Message {
  return {
    type: 'user',
    message: { role: 'user', content: text },
  } as unknown as Message
}

function toolResult(): Message {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }],
    },
  } as unknown as Message
}

function assistantToolUses(...names: string[]): Message {
  return {
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
  } as unknown as Message
}

function reminderMessage(): Message {
  return {
    type: 'user',
    isMeta: true,
    message: {
      role: 'user',
      content: `<system-reminder>${TASK_RECONCILE_MARKER}\nreconcile\n</system-reminder>`,
    },
  } as unknown as Message
}

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    subject: `task ${overrides.id}`,
    description: '',
    status: 'pending',
    blocks: [],
    blockedBy: [],
    ...overrides,
  } as Task
}

/** A turn that did real work: 4 tool calls, none of them Task*. */
function workingTurn(): Message[] {
  return [
    userPrompt(),
    assistantToolUses('Read', 'Grep'),
    toolResult(),
    assistantToolUses('Edit', 'Bash'),
    toolResult(),
  ]
}

describe('shouldReconcileTasks', () => {
  test('fires on an orphan in_progress task even without tool use', () => {
    const decision = shouldReconcileTasks(
      [userPrompt(), assistantToolUses('Read')],
      [task({ id: '1', status: 'in_progress' })],
    )
    expect(decision?.reason).toBe('orphan_in_progress')
    expect(decision?.stale).toHaveLength(1)
  })

  test('fires when a working turn never touched the task tools', () => {
    const decision = shouldReconcileTasks(workingTurn(), [
      task({ id: '1' }),
      task({ id: '2' }),
    ])
    expect(decision?.reason).toBe('untouched_list')
    expect(decision?.stale.map(t => t.id)).toEqual(['1', '2'])
  })

  test('stays quiet when the turn barely did anything', () => {
    const messages = [userPrompt(), assistantToolUses('Read', 'Grep')]
    expect(shouldReconcileTasks(messages, [task({ id: '1' })])).toBeNull()
  })

  test('stays quiet when the turn already called TaskUpdate', () => {
    const messages = [...workingTurn(), assistantToolUses('TaskUpdate')]
    expect(shouldReconcileTasks(messages, [task({ id: '1' })])).toBeNull()
  })

  test('stays quiet when the turn already called TaskCreate', () => {
    const messages = [...workingTurn(), assistantToolUses('TaskCreate')]
    expect(shouldReconcileTasks(messages, [task({ id: '1' })])).toBeNull()
  })

  test('fires at most once per turn (marker present)', () => {
    const messages = [...workingTurn(), reminderMessage(), assistantToolUses()]
    expect(shouldReconcileTasks(messages, [task({ id: '1' })])).toBeNull()
  })

  test('a new prompt re-arms the nudge after an earlier one', () => {
    const messages = [
      ...workingTurn(),
      reminderMessage(),
      userPrompt('next thing'),
      ...workingTurn().slice(1),
    ]
    expect(shouldReconcileTasks(messages, [task({ id: '1' })])?.reason).toBe(
      'untouched_list',
    )
  })

  test('stays quiet when every task is completed', () => {
    const tasks = [
      task({ id: '1', status: 'completed' }),
      task({ id: '2', status: 'completed' }),
    ]
    expect(shouldReconcileTasks(workingTurn(), tasks)).toBeNull()
  })

  test('stays quiet when the only open tasks are archived', () => {
    const tasks = [task({ id: '1', metadata: { _internal: true } })]
    expect(shouldReconcileTasks(workingTurn(), tasks)).toBeNull()
  })

  test('stays quiet when there are no tasks at all', () => {
    expect(shouldReconcileTasks(workingTurn(), [])).toBeNull()
  })

  test('counts tool use across the whole turn, not one message', () => {
    const messages = [
      userPrompt(),
      assistantToolUses('Read'),
      toolResult(),
      assistantToolUses('Read'),
      toolResult(),
      assistantToolUses('Read'),
    ]
    expect(shouldReconcileTasks(messages, [task({ id: '1' })])?.reason).toBe(
      'untouched_list',
    )
  })

  test('does not count work from a previous turn', () => {
    const messages = [...workingTurn(), userPrompt('quick question')]
    expect(shouldReconcileTasks(messages, [task({ id: '1' })])).toBeNull()
  })
})

describe('buildTaskReconcileReminder', () => {
  test('lists the open tasks and carries the marker', () => {
    const text = buildTaskReconcileReminder({
      reason: 'untouched_list',
      stale: [
        task({ id: '1', subject: 'Wire the loop' }),
        task({ id: '2', subject: 'Run tests', status: 'in_progress' }),
      ],
    })
    expect(text).toContain(TASK_RECONCILE_MARKER)
    expect(text).toContain('- #1 Wire the loop (pending)')
    expect(text).toContain('- #2 Run tests (in_progress)')
  })

  test('never tells the model to delete tasks', () => {
    const text = buildTaskReconcileReminder({
      reason: 'orphan_in_progress',
      stale: [task({ id: '1', status: 'in_progress' })],
    })
    expect(text).toContain('Do not delete tasks')
    expect(text).not.toContain('deleted: true')
  })
})
