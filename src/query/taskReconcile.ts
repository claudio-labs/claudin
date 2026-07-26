/**
 * End-of-turn task-list reconciliation nudge.
 *
 * The TodoV2 task list seeded from an approved plan (`seedTasksFromPlan`) is
 * only ever advanced by the model calling `TaskUpdate` — nothing in the loop
 * enforces it. The one existing signal, `getTaskReminderAttachments`, needs 10
 * assistant turns with zero `Task*` calls before it fires
 * (`TODO_REMINDER_CONFIG`), so a turn can easily end with the whole checklist
 * still pending while the work is done. The UI then keeps the list on screen
 * forever, because it only hides once *every* task is completed.
 *
 * This module owns the decision: did the turn about to end leave the list out
 * of sync? `query.ts` injects the returned reminder as a meta user message and
 * re-enters the loop once, exactly like the token-budget continuation.
 *
 * The 1-per-turn cap is derived from the transcript rather than from loop
 * state: the injected message carries `TASK_RECONCILE_MARKER`, and finding it
 * within the current turn means the nudge already fired.
 *
 * Killswitch: `CLAUDIN_DISABLE_TASK_RECONCILE=1` disables this nudge only. The
 * archive-on-hide path (`archiveCompletedTasks`) and the tasks-dir GC are
 * correctness fixes and stay on.
 */

import type { Message } from '../types/message.js'
import type { Task } from '../utils/tasks.js'
import { TASK_CREATE_TOOL_NAME } from '../tools/TaskCreateTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../tools/TaskUpdateTool/constants.js'

/**
 * Sentinel embedded in the injected reminder. Scanning for it is what bounds
 * the nudge to once per turn, so it must stay stable and unique.
 */
export const TASK_RECONCILE_MARKER = '<task-reconcile-reminder>'

/**
 * How much work a turn has to do before an untouched list counts as neglect.
 * A turn that answered a question with one or two lookups legitimately leaves
 * the checklist alone.
 */
const MIN_TOOL_USES_FOR_UNTOUCHED_LIST = 3

export type TaskReconcileReason =
  /** A task is still `in_progress` even though the turn is over. */
  | 'orphan_in_progress'
  /** The turn did real work and never touched TaskCreate/TaskUpdate. */
  | 'untouched_list'

export type TaskReconcileDecision = {
  reason: TaskReconcileReason
  /** The open tasks to list in the reminder, in list order. */
  stale: Task[]
}

/** True for user messages that carry tool_result blocks (not a real prompt). */
function isToolResultUserMessage(message: Message): boolean {
  if (message.type !== 'user') return false
  const content = message.message.content
  if (!Array.isArray(content)) return false
  return content.some(
    block =>
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      block.type === 'tool_result',
  )
}

/** True when a user message is the reminder this module injected. */
function isReconcileReminder(message: Message): boolean {
  if (message.type !== 'user') return false
  const content = message.message.content
  if (typeof content === 'string') return content.includes(TASK_RECONCILE_MARKER)
  if (!Array.isArray(content)) return false
  return content.some(
    block =>
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      typeof block.text === 'string' &&
      block.text.includes(TASK_RECONCILE_MARKER),
  )
}

type TurnScan = {
  toolUses: number
  touchedTaskTools: boolean
  alreadyNudged: boolean
}

/**
 * Walk backwards over the current turn: from the end of the transcript to the
 * last real user prompt. Tool results and meta messages are part of the turn,
 * so only a user message that is neither ends the walk.
 */
function scanCurrentTurn(messages: Message[]): TurnScan {
  const scan: TurnScan = {
    toolUses: 0,
    touchedTaskTools: false,
    alreadyNudged: false,
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue

    if (message.type === 'user') {
      if (isReconcileReminder(message)) {
        scan.alreadyNudged = true
        continue
      }
      // A prompt the human actually typed — the turn starts here.
      if (!message.isMeta && !isToolResultUserMessage(message)) break
      continue
    }

    if (message.type !== 'assistant') continue
    const content = message.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type !== 'tool_use') continue
      scan.toolUses++
      if (
        block.name === TASK_CREATE_TOOL_NAME ||
        block.name === TASK_UPDATE_TOOL_NAME
      ) {
        scan.touchedTaskTools = true
      }
    }
  }

  return scan
}

/**
 * Decide whether the ending turn left the task list out of sync. Returns null
 * when the list is fine, when the nudge already fired this turn, or when the
 * turn didn't do enough work for an untouched list to mean anything.
 */
export function shouldReconcileTasks(
  messages: Message[],
  tasks: Task[],
): TaskReconcileDecision | null {
  const open = tasks.filter(
    t => t.status !== 'completed' && !t.metadata?._internal,
  )
  if (open.length === 0) return null

  const scan = scanCurrentTurn(messages)
  if (scan.alreadyNudged) return null

  // (A) Nothing is in progress once the turn is over — always inconsistent.
  if (open.some(t => t.status === 'in_progress')) {
    return { reason: 'orphan_in_progress', stale: open }
  }

  // (B) The turn did real work and never touched the list. This is the case
  // where a seeded plan checklist stays entirely pending while it gets built.
  if (
    !scan.touchedTaskTools &&
    scan.toolUses >= MIN_TOOL_USES_FOR_UNTOUCHED_LIST
  ) {
    return { reason: 'untouched_list', stale: open }
  }

  return null
}

/**
 * The reminder text. Deliberately does not authorize deletion — an obsolete
 * task stays visible until the user says otherwise — and tells the model to
 * stop afterwards, so the continuation costs one short TaskUpdate round-trip
 * instead of turning one turn into several.
 */
export function buildTaskReconcileReminder(
  decision: TaskReconcileDecision,
): string {
  const lines = decision.stale.map(
    t => `- #${t.id} ${t.subject} (${t.status})`,
  )
  return [
    `<system-reminder>${TASK_RECONCILE_MARKER}`,
    'Turn is ending with the task list out of sync. Tasks still open:',
    ...lines,
    '',
    'Reconcile the list now with TaskUpdate: mark completed everything you',
    'actually finished this turn, and leave pending only what genuinely',
    'remains. Do not delete tasks. Then stop — do not start new work, and',
    'never mention this reminder to the user.',
    '</system-reminder>',
  ].join('\n')
}
