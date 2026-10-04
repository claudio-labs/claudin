/**
 * The decision record: every permission answer lands on the tool-use
 * context under its tool use id, where the permission UI and the headless
 * path read it back.
 */
import type { Tool as ToolType, ToolUseContext } from 'src/tools/Tool.js'
import type {
  PermissionApprovalSource,
  PermissionRejectionSource,
} from 'src/permissions/toolPermission/PermissionContext.js'
import { routeCapabilities } from 'src/permissions/toolPermission/capabilities.js'

type PermissionLogContext = {
  tool: ToolType
  input: unknown
  toolUseContext: ToolUseContext
  messageId: string
  toolUseID: string
}

type PermissionDecisionArgs =
  | { decision: 'accept'; source: PermissionApprovalSource | 'config' }
  | { decision: 'reject'; source: PermissionRejectionSource | 'config' }

type DecisionLabel =
  | 'config'
  | 'hook'
  | 'user_permanent'
  | 'user_temporary'
  | 'user_abort'
  | 'user_reject'
  | 'classifier'
  | 'unknown'

function labelOf(source: PermissionDecisionArgs['source']): DecisionLabel {
  if (source === 'config') return 'config'
  switch (source.type) {
    case 'hook':
    case 'user_abort':
    case 'user_reject':
      return source.type
    case 'user':
      return source.permanent ? 'user_permanent' : 'user_temporary'
    case 'classifier': {
      const built = routeCapabilities()
      return built.bashClassifier || built.autoMode ? 'classifier' : 'unknown'
    }
  }
}

function logPermissionDecision(
  ctx: PermissionLogContext,
  args: PermissionDecisionArgs,
  // Accepted and ignored until the callers stop passing it.
  _permissionPromptStartTimeMs?: number,
): void {
  const record = ctx.toolUseContext.toolDecisions ?? new Map()
  ctx.toolUseContext.toolDecisions = record
  record.set(ctx.toolUseID, { source: labelOf(args.source), decision: args.decision, timestamp: Date.now() })
}

export { logPermissionDecision }
export type { PermissionLogContext, PermissionDecisionArgs }
