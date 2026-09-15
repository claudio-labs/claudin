// Centralized logging for tool permission decisions.
// All permission approve/reject decisions flow through logPermissionDecision().
// It used to fan out to a code-edit OTel counter as well; that counter had no
// producer, so the only surviving consumer is the tool-use context decision
// store, which the permission UI and the headless path both read back.
import { feature } from 'bun:bundle'
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

// Discriminated union: 'accept' pairs with approval sources, 'reject' with rejection sources
type PermissionDecisionArgs =
  | { decision: 'accept'; source: PermissionApprovalSource | 'config' }
  | { decision: 'reject'; source: PermissionRejectionSource | 'config' }

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

// Single entry point for all permission decision logging. Called by permission
// handlers after every approve/reject; records the decision on the context.
function logPermissionDecision(
  ctx: PermissionLogContext,
  args: PermissionDecisionArgs,
  // Unused: the prompt wait time only ever fed the removed analytics payload.
  // Kept so the existing call sites still type-check.
  permissionPromptStartTimeMs?: number,
): void {
  const { toolUseContext, toolUseID } = ctx
  const { decision, source } = args

  const sourceString = source === 'config' ? 'config' : sourceToString(source)

  // Persist decision on the context so downstream code can inspect what happened
  if (!toolUseContext.toolDecisions) {
    toolUseContext.toolDecisions = new Map()
  }
  toolUseContext.toolDecisions.set(toolUseID, {
    source: sourceString,
    decision,
    timestamp: Date.now(),
  })
}

export { logPermissionDecision }
export type { PermissionLogContext, PermissionDecisionArgs }
