import type {
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionMetadata,
  PermissionResult,
} from 'src/shared/types/permissions.js'

export type {
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionMetadata,
  PermissionResult,
}

/** The verb a hook message uses for an outcome: `Hook … <verb> this tool`. */
export function getRuleBehaviorDescription(
  permissionResult: PermissionResult['behavior'],
): string {
  if (permissionResult === 'allow') return 'allowed'
  if (permissionResult === 'deny') return 'denied'
  return 'asked for confirmation for'
}
