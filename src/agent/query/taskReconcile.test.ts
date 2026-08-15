import { describe, expect, test } from 'bun:test'
import type { Message } from 'src/shared/types/message.js'
import type { Task } from 'src/agent/tasks/tasks.js'
import {
  buildTaskReconcileReminder,
  shouldReconcileTasks,
  taskStateSignature,
} from 'src/agent/query/taskReconcile.js'

// Plain literals rather than the message factories: this module only reads
// `type`, `isMeta`, the content blocks and the attachment payload, and
// hand-built fixtures keep the test free of the factories' import chain.
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

/**
 * A reminder this module emitted earlier. `signature` is what the repeat-cap
 * compares against, so tests pass a stale one when they want only the
 * per-turn cap in play.
 */
function reconcileAttachment(signature: string): Message {
  return {
    type: 'attachment',
    attachment: {
      type: 'task_reconcile',
      reason: 'untouched_list',
      stale: [],
      signature,
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

/**
 * One working turn, shaped the way the loop really stores it: the prompt, then
 * anything that rode along with it (attachments land between the prompt and
 * the first reply), then the assistant work.
 */
function turn(prompt: string, rideAlong: Message[] = []): Message[] {
  return [userPrompt(prompt), ...rideAlong, ...workingTurn().slice(1)]
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

  test('judges the previous turn when the next prompt is already appended', () => {
    // This is the real shape at attachment time: the user has just typed, so
    // the newest turn is empty. Judging it instead of the one before would
    // read as "did no work" and the nudge would never fire.
    const messages = [...workingTurn(), userPrompt('next thing')]
    expect(shouldReconcileTasks(messages, [task({ id: '1' })])?.reason).toBe(
      'untouched_list',
    )
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

  test('does not count task tools from a turn it is not judging', () => {
    // TaskUpdate belongs to the earlier turn; the turn under judgement
    // ignored the list entirely.
    const messages = [
      userPrompt('first'),
      assistantToolUses('TaskUpdate'),
      ...workingTurn(),
    ]
    expect(shouldReconcileTasks(messages, [task({ id: '1' })])?.reason).toBe(
      'untouched_list',
    )
  })

  test('fires at most once for the turn it is judging', () => {
    // Stale signature, so only the per-turn cap can be doing the suppressing.
    const messages = [
      userPrompt(),
      reconcileAttachment('9:pending'),
      assistantToolUses('Read', 'Grep'),
      toolResult(),
      assistantToolUses('Edit', 'Bash'),
    ]
    expect(shouldReconcileTasks(messages, [task({ id: '1' })])).toBeNull()
  })

  test('stays quiet on later turns while the list state is unchanged', () => {
    // The model was already asked about exactly this list and left it alone.
    // Without this cap the nudge would ride along on every remaining turn.
    const tasks = [task({ id: '1', status: 'in_progress' })]
    const messages = [
      ...turn('first', [reconcileAttachment(taskStateSignature(tasks))]),
      ...turn('next thing'),
    ]
    expect(shouldReconcileTasks(messages, tasks)).toBeNull()
  })

  test('an orphan in_progress task does not re-nudge every turn', () => {
    const tasks = [task({ id: '1', status: 'in_progress' })]
    const messages = [
      ...turn('first', [reconcileAttachment(taskStateSignature(tasks))]),
      ...turn('turn two'),
      ...turn('turn three'),
    ]
    expect(shouldReconcileTasks(messages, tasks)).toBeNull()
  })

  test('re-arms once the list state has changed', () => {
    const nudged = [task({ id: '1', status: 'in_progress' })]
    const now = [
      task({ id: '1', status: 'in_progress' }),
      task({ id: '2', status: 'pending' }),
    ]
    const messages = [
      ...turn('first', [reconcileAttachment(taskStateSignature(nudged))]),
      ...turn('next thing'),
    ]
    expect(shouldReconcileTasks(messages, now)?.reason).toBe(
      'orphan_in_progress',
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
})

describe('buildTaskReconcileReminder', () => {
  test('lists the open tasks', () => {
    const text = buildTaskReconcileReminder({
      stale: [
        { id: '1', subject: 'Wire the loop', status: 'pending' },
        { id: '2', subject: 'Run tests', status: 'in_progress' },
      ],
    })
    expect(text).toContain('- #1 Wire the loop (pending)')
    expect(text).toContain('- #2 Run tests (in_progress)')
  })

  test('never tells the model to delete tasks', () => {
    const text = buildTaskReconcileReminder({
      stale: [{ id: '1', subject: 'Wire the loop', status: 'in_progress' }],
    })
    expect(text).toContain('Do not delete tasks')
    expect(text).not.toContain('deleted: true')
  })
})

describe('taskStateSignature', () => {
  test('is order-independent', () => {
    const a = [task({ id: '1' }), task({ id: '2', status: 'in_progress' })]
    const b = [task({ id: '2', status: 'in_progress' }), task({ id: '1' })]
    expect(taskStateSignature(a)).toBe(taskStateSignature(b))
  })

  test('changes when a status changes', () => {
    const before = [task({ id: '1', status: 'pending' })]
    const after = [task({ id: '1', status: 'in_progress' })]
    expect(taskStateSignature(before)).not.toBe(taskStateSignature(after))
  })
})
