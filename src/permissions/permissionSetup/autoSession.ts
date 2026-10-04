/**
 * The one interface through which a context change switches auto-mode
 * semantics on or off. Each switch moves three things together: the session's
 * "active" flag, the queued auto-exit notice, and the stash of allow rules
 * that would let a command through before the classifier sees it. Keeping
 * them in one place is what stops a mode change from restoring the rules
 * while leaving the flag on, or the reverse.
 *
 * Without the TRANSCRIPT_CLASSIFIER build flag the bridge is null, so the
 * flag writes fall away and only the notice and the rules move.
 */
import { setNeedsAutoModeExitAttachment } from 'src/platform/bootstrap/state.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { autoModeStateModule } from 'src/permissions/permissionSetup/autoModeStateBridge.js'
import {
  restoreDangerousPermissions,
  stripDangerousPermissionsForAutoMode,
} from 'src/permissions/permissionSetup/dangerousRuleStash.js'

/** Whether this build carries auto mode at all. */
export function autoModeBuiltIn(): boolean {
  return autoModeStateModule !== null
}

export function autoSemanticsActive(): boolean {
  return autoModeStateModule?.isAutoModeActive() ?? false
}

/** Turns auto on and sets the risky allow rules aside. Leaves `mode` alone. */
export function switchAutoOn(context: ToolPermissionContext): ToolPermissionContext {
  autoModeStateModule?.setAutoModeActive(true)
  return stripDangerousPermissionsForAutoMode(context)
}

/** Turns auto off, queues the exit notice, and brings the set-aside rules back. */
export function switchAutoOff(context: ToolPermissionContext): ToolPermissionContext {
  autoModeStateModule?.setAutoModeActive(false)
  setNeedsAutoModeExitAttachment(true)
  return restoreDangerousPermissions(context)
}
