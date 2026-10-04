/**
 * The permission request every route works through: what the call is, and
 * what can be done with it (record, save rules, cancel, build decisions,
 * ask the hooks and the classifier, touch its dialog entry).
 */
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { ToolUseConfirm } from 'src/permissions/ui/PermissionRequest.js'
import type { Tool as ToolType, ToolUseContext } from 'src/tools/Tool.js'
import type { AssistantMessage } from 'src/shared/types/message.js'
import type {
  PendingClassifierCheck,
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
} from 'src/shared/types/permissions.js'
import { setClassifierApproval } from 'src/permissions/classifierApprovals.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import { logPermissionDecision, type PermissionDecisionArgs } from 'src/permissions/toolPermission/permissionLogging.js'
import { routeCapabilities } from 'src/permissions/toolPermission/capabilities.js'
import { classifyPendingBashCall } from 'src/permissions/toolPermission/context/classifierVerdict.js'
import {
  allowDecision,
  cancelDecision,
  cancelEndsTurn,
  denyDecision,
  type AllowOptions,
} from 'src/permissions/toolPermission/context/decisions.js'
import { askPermissionHooks } from 'src/permissions/toolPermission/context/hookVerdict.js'
import { createPermissionQueueOps, type PermissionQueueOps } from 'src/permissions/toolPermission/context/queue.js'
import { createResolveOnce, type ResolveOnce } from 'src/permissions/toolPermission/context/resolveOnce.js'
import { saveRuleUpdates, type SetToolPermissionContext } from 'src/permissions/toolPermission/context/ruleUpdates.js'

type PermissionApprovalSource =
  | { type: 'hook'; permanent?: boolean }
  | { type: 'user'; permanent: boolean }
  | { type: 'classifier' }

type PermissionRejectionSource =
  | { type: 'hook' }
  | { type: 'user_abort' }
  | { type: 'user_reject'; hasFeedback: boolean }

type Input = Record<string, unknown>

type PermissionContext = Readonly<{
  tool: ToolType
  input: Input
  toolUseContext: ToolUseContext
  assistantMessage: AssistantMessage
  messageId: string
  toolUseID: string
  logDecision(args: PermissionDecisionArgs, opts?: { permissionPromptStartTimeMs?: number }): void
  /** Saves and applies the updates; true when one was written to a settings file. */
  persistPermissions(updates: PermissionUpdate[]): Promise<boolean>
  resolveIfAborted(resolve: (decision: PermissionDecision) => void): boolean
  cancelAndAbort(feedback?: string, isAbort?: boolean, contentBlocks?: ContentBlockParam[]): PermissionAskDecision
  /** Present only in a build with the Bash prompt-rule classifier. */
  tryClassifier?: (
    pendingCheck: PendingClassifierCheck | undefined,
    updatedInput: Input | undefined,
  ) => Promise<PermissionDecision | null>
  runHooks(
    mode: string | undefined,
    suggestions: PermissionUpdate[] | undefined,
    updatedInput?: Input,
    permissionPromptStartTimeMs?: number,
  ): Promise<PermissionDecision | null>
  buildAllow(input: Input, opts?: AllowOptions): PermissionAllowDecision
  buildDeny(message: string, reason: PermissionDecisionReason): PermissionDenyDecision
  handleUserAllow(
    input: Input,
    updates: PermissionUpdate[],
    feedback?: string,
    permissionPromptStartTimeMs?: number,
    contentBlocks?: ContentBlockParam[],
    decisionReason?: PermissionDecisionReason,
  ): Promise<PermissionAllowDecision>
  handleHookAllow(input: Input, updates: PermissionUpdate[], permissionPromptStartTimeMs?: number): Promise<PermissionAllowDecision>
  pushToQueue(item: ToolUseConfirm): void
  removeFromQueue(): void
  updateQueueItem(patch: Partial<ToolUseConfirm>): void
}>

const HOOK_REASON = { type: 'hook', hookName: 'PermissionRequest' } as const
const HOOK_DENY_MESSAGE = 'Permission denied by hook'

function createPermissionContext(
  tool: ToolType,
  input: Input,
  toolUseContext: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
  setToolPermissionContext: SetToolPermissionContext,
  queueOps?: PermissionQueueOps,
): PermissionContext {
  const forSubAgent = Boolean(toolUseContext.agentId)
  const messageId = assistantMessage.message.id
  const turn = toolUseContext.abortController

  const logDecision = (args: PermissionDecisionArgs, opts?: { permissionPromptStartTimeMs?: number }): void =>
    logPermissionDecision({ tool, input, toolUseContext, messageId, toolUseID }, args, opts?.permissionPromptStartTimeMs)

  const persistPermissions = async (updates: PermissionUpdate[]): Promise<boolean> =>
    saveRuleUpdates(updates, toolUseContext.getAppState().toolPermissionContext, setToolPermissionContext)

  const cancelAndAbort = (feedback?: string, isAbort?: boolean, contentBlocks?: ContentBlockParam[]): PermissionAskDecision => {
    const request = { feedback, contentBlocks, abort: isAbort, forSubAgent }
    if (cancelEndsTurn(request)) turn.abort()
    return cancelDecision(request)
  }

  const handleHookAllow = async (allowed: Input, updates: PermissionUpdate[], startMs?: number): Promise<PermissionAllowDecision> => {
    const permanent = await persistPermissions(updates)
    logDecision({ decision: 'accept', source: { type: 'hook', permanent } }, { permissionPromptStartTimeMs: startMs })
    return allowDecision(allowed, { decisionReason: HOOK_REASON })
  }

  const runHooks = async (
    mode: string | undefined,
    suggestions: PermissionUpdate[] | undefined,
    updatedInput?: Input,
    startMs?: number,
  ): Promise<PermissionDecision | null> => {
    const verdict = await askPermissionHooks({ toolName: tool.name, toolUseID, input, toolUseContext, mode, suggestions })
    if (!verdict) return null
    if (verdict.behavior === 'allow') {
      return handleHookAllow(verdict.updatedInput ?? updatedInput ?? input, verdict.updatedPermissions ?? [], startMs)
    }
    logDecision({ decision: 'reject', source: { type: 'hook' } }, { permissionPromptStartTimeMs: startMs })
    if (verdict.interrupt) turn.abort()
    return denyDecision(verdict.message ?? HOOK_DENY_MESSAGE, {
      ...HOOK_REASON,
      ...(verdict.message !== undefined ? { reason: verdict.message } : {}),
    })
  }

  const tryClassifier = async (pending: PendingClassifierCheck | undefined, updatedInput: Input | undefined): Promise<PermissionDecision | null> => {
    const match = await classifyPendingBashCall(tool.name, pending, turn.signal, toolUseContext.options.isNonInteractiveSession)
    if (!match) return null
    setClassifierApproval(toolUseID, match.rule)
    logDecision({ decision: 'accept', source: { type: 'classifier' } })
    return allowDecision(updatedInput ?? input, { decisionReason: match.reason })
  }

  const context: PermissionContext = {
    tool,
    input,
    toolUseContext,
    assistantMessage,
    messageId,
    toolUseID,
    logDecision,
    persistPermissions,
    resolveIfAborted(resolve) {
      if (!turn.signal.aborted) return false
      resolve(cancelAndAbort(undefined, true))
      return true
    },
    cancelAndAbort,
    ...(routeCapabilities().bashClassifier ? { tryClassifier } : {}),
    runHooks,
    buildAllow: allowDecision,
    buildDeny: denyDecision,
    async handleUserAllow(allowed, updates, feedback, startMs, contentBlocks, decisionReason) {
      const permanent = await persistPermissions(updates)
      logDecision({ decision: 'accept', source: { type: 'user', permanent } }, { permissionPromptStartTimeMs: startMs })
      const userModified = tool.inputsEquivalent ? !tool.inputsEquivalent(input, allowed) : false
      return allowDecision(allowed, {
        userModified,
        decisionReason,
        acceptFeedback: feedback?.trim() || undefined,
        contentBlocks,
      })
    },
    handleHookAllow,
    pushToQueue: item => queueOps?.push(item),
    removeFromQueue: () => queueOps?.remove(toolUseID),
    updateQueueItem: patch => queueOps?.update(toolUseID, patch),
  }
  return Object.freeze(context)
}

export { createPermissionContext, createPermissionQueueOps, createResolveOnce }
export type {
  PermissionContext,
  PermissionApprovalSource,
  PermissionQueueOps,
  PermissionRejectionSource,
  ResolveOnce,
}
