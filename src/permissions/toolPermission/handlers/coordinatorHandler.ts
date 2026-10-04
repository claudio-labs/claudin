import type { PendingClassifierCheck } from 'src/shared/types/permissions.js'
import { logError } from 'src/shared/log.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import type { PermissionContext } from 'src/permissions/toolPermission/PermissionContext.js'

type CoordinatorPermissionParams = {
  ctx: PermissionContext
  pendingClassifierCheck?: PendingClassifierCheck | undefined
  updatedInput: Record<string, unknown> | undefined
  suggestions: PermissionUpdate[] | undefined
  permissionMode: string | undefined
}

/**
 * A coordinator worker settles what it can without a person: its
 * PermissionRequest hooks, then the Bash prompt-rule classifier. Null hands
 * the call on, and a failing check is no decision, so the user still decides.
 */
async function handleCoordinatorPermission(
  params: CoordinatorPermissionParams,
): Promise<PermissionDecision | null> {
  const { ctx } = params
  try {
    const fromHooks = await ctx.runHooks(params.permissionMode, params.suggestions, params.updatedInput)
    if (fromHooks) return fromHooks
    return (await ctx.tryClassifier?.(params.pendingClassifierCheck, params.updatedInput)) ?? null
  } catch (error) {
    logError(error instanceof Error ? error : new Error(`Automated permission check failed: ${String(error)}`))
    return null
  }
}

export { handleCoordinatorPermission }
export type { CoordinatorPermissionParams }
