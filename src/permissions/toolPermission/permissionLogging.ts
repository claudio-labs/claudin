// Centralized logging for tool permission decisions.
// All permission approve/reject decisions flow through logPermissionDecision().
// It used to fan out to a code-edit OTel counter as well; that counter had no
// producer. What survives is the tool-use context's decision store, which
// toolExecution copies onto the call's tool_result message — the transcript's
// record of every prompt, rule hit and classifier verdict.
import { feature } from 'bun:bundle'
import { permissionRuleValueToString } from 'src/permissions/permissionRuleParser.js'
import type { PermissionDecisionReason } from 'src/shared/types/permissions.js'
import type { Tool as ToolType, ToolUseContext } from 'src/tools/Tool.js'
import type {
  PermissionApprovalSource,
  PermissionRejectionSource,
} from 'src/permissions/toolPermission/PermissionContext.js'

type PermissionLogContext = {
  tool: ToolType
  input: unknown
  toolUseContext: ToolUseContext
  messageId: string
  toolUseID: string
}

// Discriminated union: 'accept' pairs with approval sources, 'reject' with
// rejection sources. `reason` is the decision's own, when it has one.
type PermissionDecisionArgs =
  | { decision: 'accept'; source: PermissionApprovalSource | 'config'; reason?: PermissionDecisionReason }
  | { decision: 'reject'; source: PermissionRejectionSource | 'config'; reason?: PermissionDecisionReason }

/** Enough of a classifier's or hook's words to tell verdicts apart in a census. */
const DETAIL_MAX_CHARS = 200

// Flattens structured source into a string label for the decision store.
function sourceToString(
  source: PermissionApprovalSource | PermissionRejectionSource,
): string {
  if (
    (feature('BASH_CLASSIFIER') || feature('TRANSCRIPT_CLASSIFIER')) &&
    source.type === 'classifier'
  ) {
    return 'classifier'
  }
  switch (source.type) {
    case 'hook':
      return 'hook'
    case 'user':
      return source.permanent ? 'user_permanent' : 'user_temporary'
    case 'user_abort':
      return 'user_abort'
    case 'user_reject':
      return 'user_reject'
    default:
      return 'unknown'
  }
}

/**
 * Who made a decision nobody was asked about. `config` covered all of them,
 * so an auto-mode denial looked like a deny rule; the reason tells them apart.
 */
function automaticSource(reason: PermissionDecisionReason | undefined): string {
  if (reason?.type === 'classifier') return 'classifier'
  if (reason?.type === 'hook') return 'hook'
  return 'config'
}

function reasonDetail(reason: PermissionDecisionReason): string | undefined {
  switch (reason.type) {
    case 'rule':
      return permissionRuleValueToString(reason.rule.ruleValue)
    case 'mode':
      return reason.mode
    case 'hook':
      return reason.reason ?? reason.hookName
    case 'classifier':
    case 'asyncAgent':
    case 'workingDir':
    case 'safetyCheck':
    case 'other':
      return reason.reason
    default:
      return undefined
  }
}

// Single entry point for all permission decision logging. Called by permission
// handlers after every approve/reject; records the decision on the context.
function logPermissionDecision(
  ctx: PermissionLogContext,
  args: PermissionDecisionArgs,
  // When the prompt was shown, for the wait the record keeps.
  permissionPromptStartTimeMs?: number,
): void {
  const { toolUseContext, toolUseID } = ctx
  const { decision, source, reason } = args
  const detail = reason ? reasonDetail(reason) : undefined

  // Persist decision on the context so downstream code can inspect what happened
  if (!toolUseContext.toolDecisions) {
    toolUseContext.toolDecisions = new Map()
  }
  toolUseContext.toolDecisions.set(toolUseID, {
    decision,
    source: source === 'config' ? automaticSource(reason) : sourceToString(source),
    ...(reason ? { reason: reason.type } : {}),
    ...(detail ? { detail: detail.slice(0, DETAIL_MAX_CHARS) } : {}),
    ...(permissionPromptStartTimeMs !== undefined
      ? { waitMs: Date.now() - permissionPromptStartTimeMs }
      : {}),
    timestamp: Date.now(),
  })
}

export { logPermissionDecision }
export type { PermissionLogContext, PermissionDecisionArgs }
