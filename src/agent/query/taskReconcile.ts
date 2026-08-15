/**
 * Task-list reconciliation nudge.
 *
 * The TodoV2 task list seeded from an approved plan (`seedTasksFromPlan`) is
 * only ever advanced by the model calling `TaskUpdate` — nothing in the loop
 * enforces it. The one existing signal, `getTaskReminderAttachments`, needs 10
 * assistant turns with zero `Task*` calls before it fires
 * (`TODO_REMINDER_CONFIG`), so a turn can easily end with the whole checklist
 * still pending while the work is done. The UI then keeps the list on screen,
 * because it only hides once *every* task is completed.
 *
 * This module decides whether the last completed turn left the list out of
 * sync, and rides along as an attachment on the next turn.
 *
 * WHY AN ATTACHMENT AND NOT AN END-OF-TURN CONTINUATION: injecting a reminder
 * and re-entering the loop does work — measured, the model reconciles — but the
 * continuation's reply becomes the turn's last assistant message, so the user
 * gets a bookkeeping line ("Task #1 is marked completed.") appended after the
 * real answer, and in `-p` that line *replaces* the answer entirely. Three
 * wordings were tried; every one produced trailing prose, because the model has
 * to end its turn with something. As an attachment the reminder costs no extra
 * round-trip and produces no extra message — the trade is that the list stays
 * visually stale until the user's next turn.
 *
 * Both repeat-caps are derived from the transcript rather than from loop state.
 * The emitted attachment carries a signature of the open tasks: seeing one
 * inside the turn being judged means the nudge already fired for it, and seeing
 * the same signature anywhere earlier means we already asked about this exact
 * list state and got nowhere. Without that second cap a single task the model
 * won't advance — one it deliberately keeps `in_progress` across turns, say —
 * would re-nudge on every later turn for the rest of the session.
 *
 * Killswitch: `CLAUDIN_DISABLE_TASK_RECONCILE=1` disables this nudge only. The
 * archive-on-hide path (`archiveCompletedTasks`) and the tasks-dir GC are
 * correctness fixes and stay on.
 */

import type { Attachment } from 'src/agent/attachments/types.js'
import type { Message } from 'src/types/message.js'
import type { ToolUseContext } from 'src/Tool.js'
import {
  getTaskListId,
  isTodoV2Enabled,
  listTasks,
  type Task,
} from 'src/tasks/tasks.js'
import { TASK_CREATE_TOOL_NAME } from 'src/tools/TaskCreateTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from 'src/tools/TaskUpdateTool/constants.js'
import { isBareMode, isEnvTruthy } from 'src/shared/envUtils.js'
import { isTeammate } from 'src/coordinator/teammate.js'

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
  /** State of `stale` when the nudge fired; carried on the attachment. */
  signature: string
}

/**
 * Identity of a list state: which tasks are open and what status each has.
 * Order-independent so a reordered listing doesn't read as a change.
 */
export function taskStateSignature(tasks: Task[]): string {
  return tasks
    .map(t => `${t.id}:${t.status}`)
    .sort()
    .join(',')
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

/** The signature on a reconcile attachment, or null for anything else. */
function reconcileAttachmentSignature(message: Message): string | null {
  if (message.type !== 'attachment') return null
  const attachment = message.attachment
  if (!attachment || attachment.type !== 'task_reconcile') return null
  return attachment.signature
}

type TranscriptScan = {
  toolUses: number
  touchedTaskTools: boolean
  /** A reconcile attachment already rode along with the judged turn. */
  alreadyNudged: boolean
  /** Signature of the most recent nudge in the whole transcript, if any. */
  lastSignature: string | null
}

/**
 * Walk the transcript backwards once.
 *
 * Tool use is counted over the last turn that actually contains assistant
 * activity — at attachment time the new user prompt may already be appended,
 * and an empty turn must not read as "did no work". So a real user prompt only
 * closes the scan once an assistant message has been seen; before that it is
 * just the boundary of a turn we aren't judging.
 *
 * The search for a prior signature keeps going past that boundary, since the
 * last state we nudged about may be several turns old.
 */
function scanTranscript(messages: Message[]): TranscriptScan {
  const scan: TranscriptScan = {
    toolUses: 0,
    touchedTaskTools: false,
    alreadyNudged: false,
    lastSignature: null,
  }
  let insideTurn = false
  let turnClosed = false

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue

    const signature = reconcileAttachmentSignature(message)
    if (signature !== null) {
      // Only counts as "already nudged" when it rode with the turn being
      // judged — it sits between that turn's prompt and its first reply, so
      // walking backwards we meet it after the replies and before the prompt.
      if (insideTurn && !turnClosed) scan.alreadyNudged = true
      if (scan.lastSignature === null) scan.lastSignature = signature
      continue
    }

    if (message.type === 'user') {
      // A prompt the human actually typed. Only meaningful once we're inside
      // the turn being judged — otherwise it's the boundary of a later, empty
      // one.
      if (
        insideTurn &&
        !turnClosed &&
        !message.isMeta &&
        !isToolResultUserMessage(message)
      ) {
        turnClosed = true
        // Nothing left to learn once we have both halves.
        if (scan.lastSignature !== null) break
      }
      continue
    }

    if (message.type !== 'assistant') continue
    insideTurn = true
    if (turnClosed) continue
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
 * Decide whether the last completed turn left the task list out of sync.
 * Returns null when the list is fine, when the nudge already rode along with
 * that turn, when the list is in the same state we last nudged about, or when
 * the turn didn't do enough work for an untouched list to mean anything.
 */
export function shouldReconcileTasks(
  messages: Message[],
  tasks: Task[],
): TaskReconcileDecision | null {
  const open = tasks.filter(
    t => t.status !== 'completed' && !t.metadata?._internal,
  )
  if (open.length === 0) return null

  const scan = scanTranscript(messages)
  if (scan.alreadyNudged) return null

  // Already asked about exactly this list state and it didn't move. Asking
  // again buys nothing and costs context on every turn.
  const signature = taskStateSignature(open)
  if (scan.lastSignature === signature) return null

  // (A) Nothing is in progress once the turn is over — always inconsistent.
  if (open.some(t => t.status === 'in_progress')) {
    return { reason: 'orphan_in_progress', stale: open, signature }
  }

  // (B) The turn did real work and never touched the list. This is the case
  // where a seeded plan checklist stays entirely pending while it gets built.
  if (
    !scan.touchedTaskTools &&
    scan.toolUses >= MIN_TOOL_USES_FOR_UNTOUCHED_LIST
  ) {
    return { reason: 'untouched_list', stale: open, signature }
  }

  return null
}

/**
 * The reminder text. Deliberately does not authorize deletion — an obsolete
 * task stays visible until the user says otherwise — and deliberately does NOT
 * tell the model to hide the reminder from the user: an earlier draft did, and
 * the model read the combination of "here are instructions" plus "don't tell
 * them" as injected text and reported it to the user, which is the correct
 * instinct. The `<system-reminder>` wrapper is what marks it as harness-sent.
 */
export function buildTaskReconcileReminder(attachment: {
  stale: Array<{ id: string; subject: string; status: string }>
}): string {
  return [
    'The previous turn ended with the task list out of sync. Still open:',
    ...attachment.stale.map(t => `- #${t.id} ${t.subject} (${t.status})`),
    '',
    'Reconcile the list with TaskUpdate before continuing: mark completed',
    'whatever was actually finished, and leave pending only what genuinely',
    'remains. Do not delete tasks. Then carry on with the request above.',
  ].join('\n')
}

/**
 * Pipeline producer. Main agent only: subagents and teammates share the
 * leader's list and must not drive it from their own attachment pass
 * (teammates already run TaskCompleted hooks in `query/stopHooks.ts`).
 */
export async function getTaskReconcileAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!messages || messages.length === 0) return []
  if (toolUseContext.agentId) return []
  if (!isTodoV2Enabled()) return []
  if (isBareMode() || isTeammate()) return []
  if (isEnvTruthy(process.env.CLAUDIN_DISABLE_TASK_RECONCILE)) return []

  const decision = shouldReconcileTasks(
    messages,
    await listTasks(getTaskListId()),
  )
  if (!decision) return []

  return [
    {
      type: 'task_reconcile',
      reason: decision.reason,
      stale: decision.stale.map(t => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
      })),
      signature: decision.signature,
    },
  ]
}
