// Mode lifecycle attachments (plan, auto) + reminder attachments
// (todo, task, verify-plan, compaction).
//
// Extracted from src/utils/attachments.ts as part of the attachments split.
import {
  toolMatchesName,
  type ToolUseContext,
} from '../../Tool.js'
import {
  TODO_WRITE_TOOL_NAME,
} from '../../tools/TodoWriteTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../../tools/TaskCreateTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../../tools/TaskUpdateTool/constants.js'
import {
  type Task,
  listTasks,
  getTaskListId,
  isTodoV2Enabled,
} from '../tasks.js'
import { getPlanFilePath, getPlan } from '../plans.js'
import {
  hasExitedPlanModeInSession,
  setHasExitedPlanMode,
  needsPlanModeExitAttachment,
  setNeedsPlanModeExitAttachment,
  needsAutoModeExitAttachment,
  setNeedsAutoModeExitAttachment,
  getSessionId,
  getSdkBetas,
} from '../../bootstrap/state.js'
import { isHumanTurn } from '../messagePredicates.js'
import { isThinkingMessage } from '../messages.js'
import { isEnvTruthy } from '../envUtils.js'
import { feature } from 'bun:bundle'
import type { Message } from 'src/types/message.js'
import type { TodoList } from '../todo/types.js'
import {
  getTodoReminderDelta,
  type TodoSnapshotItem,
} from '../todoReminderDelta.js'
import { getContextWindowForModel } from '../context.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
} from '../../services/compact/autoCompact.js'
import { tokenCountWithEstimation } from '../tokens.js'
import {
  generateTaskAttachments,
  applyTaskOffsetsAndEvictions,
} from '../task/framework.js'
import { getTaskOutputPath } from '../task/diskOutput.js'
import type { Attachment } from './types.js'
import {
  PLAN_MODE_ATTACHMENT_CONFIG,
  AUTO_MODE_ATTACHMENT_CONFIG,
  TODO_REMINDER_CONFIG,
  VERIFY_PLAN_REMINDER_CONFIG,
} from './config.js'
import { hasToolResultContent } from './shared.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('../../tools/BriefTool/prompt.js') as typeof import('../../tools/BriefTool/prompt.js')
      ).BRIEF_TOOL_NAME
    : null
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('../permissions/autoModeState.js') as typeof import('../permissions/autoModeState.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

function getPlanModeAttachmentTurnCount(messages: Message[]): {
  turnCount: number
  foundPlanModeAttachment: boolean
} {
  let turnsSinceLastAttachment = 0
  let foundPlanModeAttachment = false

  // Iterate backwards to find most recent plan_mode attachment.
  // Count HUMAN turns (non-meta, non-tool-result user messages), not assistant
  // messages — the tool loop in query.ts calls getAttachmentMessages on every
  // tool round, so counting assistant messages would fire the reminder every
  // 5 tool calls instead of every 5 human turns.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (
      message?.type === 'user' &&
      !message.isMeta &&
      !hasToolResultContent(message.message.content)
    ) {
      turnsSinceLastAttachment++
    } else if (
      message?.type === 'attachment' &&
      (message.attachment.type === 'plan_mode' ||
        message.attachment.type === 'plan_mode_reentry')
    ) {
      foundPlanModeAttachment = true
      break
    }
  }

  return { turnCount: turnsSinceLastAttachment, foundPlanModeAttachment }
}

/**
 * Count plan_mode attachments since the last plan_mode_exit (or from start if no exit).
 * This ensures the full/sparse cycle resets when re-entering plan mode.
 */
function countPlanModeAttachmentsSinceLastExit(messages: Message[]): number {
  let count = 0
  // Iterate backwards - if we hit a plan_mode_exit, stop counting
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'attachment') {
      if (message.attachment.type === 'plan_mode_exit') {
        break // Stop counting at the last exit
      }
      if (message.attachment.type === 'plan_mode') {
        count++
      }
    }
  }
  return count
}

export async function getPlanModeAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()
  const permissionContext = appState.toolPermissionContext
  if (permissionContext.mode !== 'plan') {
    return []
  }

  // Check if we should attach based on turn count (except for first turn)
  if (messages && messages.length > 0) {
    const { turnCount, foundPlanModeAttachment } =
      getPlanModeAttachmentTurnCount(messages)
    // Only throttle if we've already sent a plan_mode attachment before
    // On first turn in plan mode, always attach
    if (
      foundPlanModeAttachment &&
      turnCount < PLAN_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS
    ) {
      return []
    }
  }

  const planFilePath = getPlanFilePath(toolUseContext.agentId)
  const existingPlan = getPlan(toolUseContext.agentId)

  const attachments: Attachment[] = []

  // Check for re-entry: flag is set AND plan file exists
  if (hasExitedPlanModeInSession() && existingPlan !== null) {
    attachments.push({ type: 'plan_mode_reentry', planFilePath })
    setHasExitedPlanMode(false) // Clear flag - one-time guidance
  }

  // Determine if this should be a full or sparse reminder
  // Full reminder on 1st, 6th, 11th... (every Nth attachment)
  const attachmentCount =
    countPlanModeAttachmentsSinceLastExit(messages ?? []) + 1
  const reminderType: 'full' | 'sparse' =
    attachmentCount %
      PLAN_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS ===
    1
      ? 'full'
      : 'sparse'

  // Always add the main plan_mode attachment
  attachments.push({
    type: 'plan_mode',
    reminderType,
    isSubAgent: !!toolUseContext.agentId,
    planFilePath,
    planExists: existingPlan !== null,
  })

  return attachments
}

/**
 * Returns a plan_mode_exit attachment if we just exited plan mode.
 * This is a one-time notification to tell the model it's no longer in plan mode.
 */
export async function getPlanModeExitAttachment(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // Only trigger if the flag is set (we just exited plan mode)
  if (!needsPlanModeExitAttachment()) {
    return []
  }

  const appState = toolUseContext.getAppState()
  if (appState.toolPermissionContext.mode === 'plan') {
    setNeedsPlanModeExitAttachment(false)
    return []
  }

  // Clear the flag - this is a one-time notification
  setNeedsPlanModeExitAttachment(false)

  const planFilePath = getPlanFilePath(toolUseContext.agentId)
  const planExists = getPlan(toolUseContext.agentId) !== null

  // Note: skill discovery does NOT fire on plan exit. By the time the plan is
  // written, it's too late — the model should have had relevant skills WHILE
  // planning. The user_message signal already fires on the request that
  // triggers planning ("plan how to deploy this"), which is the right moment.
  return [{ type: 'plan_mode_exit', planFilePath, planExists }]
}

function getAutoModeAttachmentTurnCount(messages: Message[]): {
  turnCount: number
  foundAutoModeAttachment: boolean
} {
  let turnsSinceLastAttachment = 0
  let foundAutoModeAttachment = false

  // Iterate backwards to find most recent auto_mode attachment.
  // Count HUMAN turns (non-meta, non-tool-result user messages), not assistant
  // messages — the tool loop in query.ts calls getAttachmentMessages on every
  // tool round, so a single human turn with 100 tool calls would fire ~20
  // reminders if we counted assistant messages. Auto mode's target use case is
  // long agentic sessions, where this accumulated 60-105× per session.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (
      message?.type === 'user' &&
      !message.isMeta &&
      !hasToolResultContent(message.message.content)
    ) {
      turnsSinceLastAttachment++
    } else if (
      message?.type === 'attachment' &&
      message.attachment.type === 'auto_mode'
    ) {
      foundAutoModeAttachment = true
      break
    } else if (
      message?.type === 'attachment' &&
      message.attachment.type === 'auto_mode_exit'
    ) {
      // Exit resets the throttle — treat as if no prior attachment exists
      break
    }
  }

  return { turnCount: turnsSinceLastAttachment, foundAutoModeAttachment }
}

/**
 * Count auto_mode attachments since the last auto_mode_exit (or from start if no exit).
 * This ensures the full/sparse cycle resets when re-entering auto mode.
 */
function countAutoModeAttachmentsSinceLastExit(messages: Message[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'attachment') {
      if (message.attachment.type === 'auto_mode_exit') {
        break
      }
      if (message.attachment.type === 'auto_mode') {
        count++
      }
    }
  }
  return count
}

export async function getAutoModeAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()
  const permissionContext = appState.toolPermissionContext
  const inAuto = permissionContext.mode === 'auto'
  const inPlanWithAuto =
    permissionContext.mode === 'plan' &&
    (autoModeStateModule?.isAutoModeActive() ?? false)
  if (!inAuto && !inPlanWithAuto) {
    return []
  }

  // Check if we should attach based on turn count (except for first turn)
  if (messages && messages.length > 0) {
    const { turnCount, foundAutoModeAttachment } =
      getAutoModeAttachmentTurnCount(messages)
    // Only throttle if we've already sent an auto_mode attachment before
    // On first turn in auto mode, always attach
    if (
      foundAutoModeAttachment &&
      turnCount < AUTO_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS
    ) {
      return []
    }
  }

  // Determine if this should be a full or sparse reminder
  const attachmentCount =
    countAutoModeAttachmentsSinceLastExit(messages ?? []) + 1
  const reminderType: 'full' | 'sparse' =
    attachmentCount %
      AUTO_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS ===
    1
      ? 'full'
      : 'sparse'

  return [{ type: 'auto_mode', reminderType }]
}

/**
 * Returns an auto_mode_exit attachment if we just exited auto mode.
 * This is a one-time notification to tell the model it's no longer in auto mode.
 */
export async function getAutoModeExitAttachment(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!needsAutoModeExitAttachment()) {
    return []
  }

  const appState = toolUseContext.getAppState()
  // Suppress when auto is still active — covers both mode==='auto' and
  // plan-with-auto-active (where mode==='plan' but classifier runs).
  if (
    appState.toolPermissionContext.mode === 'auto' ||
    (autoModeStateModule?.isAutoModeActive() ?? false)
  ) {
    setNeedsAutoModeExitAttachment(false)
    return []
  }

  setNeedsAutoModeExitAttachment(false)
  return [{ type: 'auto_mode_exit' }]
}

/**
 * Build a TodoSnapshotItem[] from v1 TodoList. Exported for tests.
 */
export function todoListToSnapshot(todos: TodoList): TodoSnapshotItem[] {
  return todos.map((t, idx) => ({
    id: `${idx}:${t.content}`,
    status: t.status,
    text: t.content,
  }))
}

/**
 * Build a TodoSnapshotItem[] from v2 Task[]. Exported for tests.
 */
export function taskListToSnapshot(tasks: Task[]): TodoSnapshotItem[] {
  return tasks.map(t => ({
    id: `#${t.id}`,
    status: t.status,
    text: t.subject,
  }))
}

function getTodoReminderTurnCounts(messages: Message[]): {
  turnsSinceLastTodoWrite: number
  turnsSinceLastReminder: number
} {
  let lastTodoWriteIndex = -1
  let lastReminderIndex = -1
  let assistantTurnsSinceWrite = 0
  let assistantTurnsSinceReminder = 0

  // Iterate backwards to find most recent events
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (message?.type === 'assistant') {
      if (isThinkingMessage(message)) {
        // Skip thinking messages
        continue
      }

      // Check for TodoWrite usage BEFORE incrementing counter
      // (we don't want to count the TodoWrite message itself as "1 turn since write")
      if (
        lastTodoWriteIndex === -1 &&
        'message' in message &&
        Array.isArray(message.message?.content) &&
        message.message.content.some(
          block => block.type === 'tool_use' && block.name === 'TodoWrite',
        )
      ) {
        lastTodoWriteIndex = i
      }

      // Count assistant turns before finding events
      if (lastTodoWriteIndex === -1) assistantTurnsSinceWrite++
      if (lastReminderIndex === -1) assistantTurnsSinceReminder++
    } else if (
      lastReminderIndex === -1 &&
      message?.type === 'attachment' &&
      (message.attachment.type === 'todo_reminder' ||
        message.attachment.type === 'todo_reminder_delta')
    ) {
      lastReminderIndex = i
    }

    if (lastTodoWriteIndex !== -1 && lastReminderIndex !== -1) {
      break
    }
  }

  return {
    turnsSinceLastTodoWrite: assistantTurnsSinceWrite,
    turnsSinceLastReminder: assistantTurnsSinceReminder,
  }
}

export async function getTodoReminderAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // Skip if TodoWrite tool is not available
  if (
    !toolUseContext.options.tools.some(t =>
      toolMatchesName(t, TODO_WRITE_TOOL_NAME),
    )
  ) {
    return []
  }

  // When SendUserMessage is in the toolkit, it's the primary communication
  // channel and the model is always told to use it (#20467). TodoWrite
  // becomes a side channel — nudging the model about it conflicts with the
  // brief workflow. The tool itself stays available; this only gates the
  // "you haven't used it in a while" nag.
  if (
    BRIEF_TOOL_NAME &&
    toolUseContext.options.tools.some(t => toolMatchesName(t, BRIEF_TOOL_NAME))
  ) {
    return []
  }

  // Skip if no messages provided
  if (!messages || messages.length === 0) {
    return []
  }

  const { turnsSinceLastTodoWrite, turnsSinceLastReminder } =
    getTodoReminderTurnCounts(messages)

  // Check if we should show a reminder
  if (
    turnsSinceLastTodoWrite >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
    turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  ) {
    const todoKey = toolUseContext.agentId ?? getSessionId()
    const appState = toolUseContext.getAppState()
    const todos = appState.todos[todoKey] ?? []

    // Static-dedup: emit a todo_reminder_delta that only carries
    // added/changed/removed items since the last reminder. The full
    // snapshot is embedded in the attachment so future turns can
    // reconstruct state. See src/utils/todoReminderDelta.ts.
    const delta = getTodoReminderDelta(
      todoListToSnapshot(todos),
      messages as Parameters<typeof getTodoReminderDelta>[1],
    )
    if (!delta) return []
    return [
      {
        type: 'todo_reminder_delta',
        added: delta.added.map(a => ({
          id: a.id,
          status: a.status,
          text: a.text,
        })),
        statusChanged: delta.statusChanged,
        removedIds: delta.removedIds,
        isInitial: delta.isInitial,
        snapshot: delta.snapshot,
      },
    ]
  }

  return []
}

function getTaskReminderTurnCounts(messages: Message[]): {
  turnsSinceLastTaskManagement: number
  turnsSinceLastReminder: number
} {
  let lastTaskManagementIndex = -1
  let lastReminderIndex = -1
  let assistantTurnsSinceTaskManagement = 0
  let assistantTurnsSinceReminder = 0

  // Iterate backwards to find most recent events
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (message?.type === 'assistant') {
      if (isThinkingMessage(message)) {
        // Skip thinking messages
        continue
      }

      // Check for TaskCreate or TaskUpdate usage BEFORE incrementing counter
      if (
        lastTaskManagementIndex === -1 &&
        'message' in message &&
        Array.isArray(message.message?.content) &&
        message.message.content.some(
          block =>
            block.type === 'tool_use' &&
            (block.name === TASK_CREATE_TOOL_NAME ||
              block.name === TASK_UPDATE_TOOL_NAME),
        )
      ) {
        lastTaskManagementIndex = i
      }

      // Count assistant turns before finding events
      if (lastTaskManagementIndex === -1) assistantTurnsSinceTaskManagement++
      if (lastReminderIndex === -1) assistantTurnsSinceReminder++
    } else if (
      lastReminderIndex === -1 &&
      message?.type === 'attachment' &&
      (message.attachment.type === 'task_reminder' ||
        message.attachment.type === 'todo_reminder_delta')
    ) {
      lastReminderIndex = i
    }

    if (lastTaskManagementIndex !== -1 && lastReminderIndex !== -1) {
      break
    }
  }

  return {
    turnsSinceLastTaskManagement: assistantTurnsSinceTaskManagement,
    turnsSinceLastReminder: assistantTurnsSinceReminder,
  }
}

export async function getTaskReminderAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!isTodoV2Enabled()) {
    return []
  }

  // When SendUserMessage is in the toolkit, it's the primary communication
  // channel and the model is always told to use it (#20467). TaskUpdate
  // becomes a side channel — nudging the model about it conflicts with the
  // brief workflow. The tool itself stays available; this only gates the nag.
  if (
    BRIEF_TOOL_NAME &&
    toolUseContext.options.tools.some(t => toolMatchesName(t, BRIEF_TOOL_NAME))
  ) {
    return []
  }

  // Skip if TaskUpdate tool is not available
  if (
    !toolUseContext.options.tools.some(t =>
      toolMatchesName(t, TASK_UPDATE_TOOL_NAME),
    )
  ) {
    return []
  }

  // Skip if no messages provided
  if (!messages || messages.length === 0) {
    return []
  }

  const { turnsSinceLastTaskManagement, turnsSinceLastReminder } =
    getTaskReminderTurnCounts(messages)

  // Check if we should show a reminder
  if (
    turnsSinceLastTaskManagement >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
    turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  ) {
    const tasks = await listTasks(getTaskListId())

    const delta = getTodoReminderDelta(
      taskListToSnapshot(tasks),
      messages as Parameters<typeof getTodoReminderDelta>[1],
    )
    if (!delta) return []
    return [
      {
        type: 'todo_reminder_delta',
        added: delta.added.map(a => ({
          id: a.id,
          status: a.status,
          text: a.text,
        })),
        statusChanged: delta.statusChanged,
        removedIds: delta.removedIds,
        isInitial: delta.isInitial,
        snapshot: delta.snapshot,
      },
    ]
  }

  return []
}

/**
 * Get attachments for all unified tasks using the Task framework.
 * Replaces the old getBackgroundShellAttachments, getBackgroundRemoteSessionAttachments,
 * and getAsyncAgentAttachments functions.
 */
export async function getUnifiedTaskAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()
  const { attachments, updatedTaskOffsets, evictedTaskIds } =
    await generateTaskAttachments(appState)

  applyTaskOffsetsAndEvictions(
    toolUseContext.setAppState,
    updatedTaskOffsets,
    evictedTaskIds,
  )

  // Convert TaskAttachment to Attachment format
  return attachments.map(taskAttachment => ({
    type: 'task_status' as const,
    taskId: taskAttachment.taskId,
    taskType: taskAttachment.taskType,
    status: taskAttachment.status,
    description: taskAttachment.description,
    deltaSummary: taskAttachment.deltaSummary,
    outputFilePath: getTaskOutputPath(taskAttachment.taskId),
  }))
}

export function getVerifyPlanReminderTurnCount(messages: Message[]): number {
  let turnCount = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && isHumanTurn(message)) {
      turnCount++
    }
    // Stop counting at plan_mode_exit attachment (marks when implementation started)
    if (
      message?.type === 'attachment' &&
      message.attachment.type === 'plan_mode_exit'
    ) {
      return turnCount
    }
  }
  // No plan_mode_exit found
  return 0
}

/**
 * Get verify plan reminder attachment if the model hasn't called VerifyPlanExecution yet.
 */
export async function getVerifyPlanReminderAttachment(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_VERIFY_PLAN)) {
    return []
  }

  const appState = toolUseContext.getAppState()
  const pending = appState.pendingPlanVerification

  // Only remind if plan exists and verification not started or completed
  if (
    !pending ||
    pending.verificationStarted ||
    pending.verificationCompleted
  ) {
    return []
  }

  // Only remind every N turns
  if (messages && messages.length > 0) {
    const turnCount = getVerifyPlanReminderTurnCount(messages)
    if (
      turnCount === 0 ||
      turnCount % VERIFY_PLAN_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS !== 0
    ) {
      return []
    }
  }

  return [{ type: 'verify_plan_reminder' }]
}

export function getCompactionReminderAttachment(
  messages: Message[],
  model: string,
): Attachment[] {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_marble_fox', false)) {
    return []
  }

  if (!isAutoCompactEnabled()) {
    return []
  }

  const contextWindow = getContextWindowForModel(model, getSdkBetas())
  if (contextWindow < 1_000_000) {
    return []
  }

  const effectiveWindow = getEffectiveContextWindowSize(model)
  const usedTokens = tokenCountWithEstimation(messages)
  if (usedTokens < effectiveWindow * 0.25) {
    return []
  }

  return [{ type: 'compaction_reminder' }]
}
