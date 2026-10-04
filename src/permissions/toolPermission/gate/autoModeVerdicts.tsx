/**
 * What an auto-mode classifier verdict leaves behind besides the decision:
 * the reason of an allow, for the transcript; a deny in the recent-denials
 * list and, where the session shows notifications, a notice.
 */
import * as React from 'react'
import { recordAutoModeDenial } from 'src/permissions/autoModeDenials.js'
import { setYoloClassifierApproval } from 'src/permissions/classifierApprovals.js'
import type { PermissionDecisionReason } from 'src/shared/types/permissions.js'
import { Text } from 'src/terminal/ink.js'
import type { PermissionContext } from 'src/permissions/toolPermission/PermissionContext.js'

type AutoModeReason = Extract<PermissionDecisionReason, { type: 'classifier' }> & { classifier: 'auto-mode' }

export function isAutoModeVerdict(reason: PermissionDecisionReason | undefined): reason is AutoModeReason {
  return reason?.type === 'classifier' && reason.classifier === 'auto-mode'
}

export function rememberAutoModeAllow(ctx: PermissionContext, reason: AutoModeReason): void {
  setYoloClassifierApproval(ctx.toolUseID, reason.reason)
}

function DeniedNotice({ toolName }: { toolName: string }): React.ReactNode {
  return (
    <Text>
      <Text color="error">{toolName} denied by auto mode</Text>
      <Text dimColor> · /permissions</Text>
    </Text>
  )
}

export function reportAutoModeDenial(ctx: PermissionContext, description: string, reason: AutoModeReason): void {
  // A verdict can arrive without a reason; the list still shows the denial.
  const why: string | undefined = reason.reason
  recordAutoModeDenial({ toolName: ctx.tool.name, display: description, reason: why ?? '', timestamp: Date.now() })
  const toolName = ctx.tool.userFacingName(ctx.input).toLowerCase()
  ctx.toolUseContext.addNotification?.({
    key: 'auto-mode-denied',
    priority: 'immediate',
    jsx: <DeniedNotice toolName={toolName} />,
  })
}
