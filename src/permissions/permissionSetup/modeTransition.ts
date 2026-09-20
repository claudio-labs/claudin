/**
 * The one place every permission-mode change goes through, so that CLI
 * shift+tab, SDK control messages and the plan tools all produce the same
 * side effects.
 */
import { feature } from 'bun:bundle'
import {
  handleAutoModeTransition,
  handlePlanModeTransition,
  setHasExitedPlanMode,
  setNeedsAutoModeExitAttachment,
} from 'src/platform/bootstrap/state.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { autoModeStateModule } from 'src/permissions/permissionSetup/autoModeStateBridge.js'
import { isAutoModeGateEnabled } from 'src/permissions/permissionSetup/autoModeAvailability.js'
import {
  restoreDangerousPermissions,
  stripDangerousPermissionsForAutoMode,
} from 'src/permissions/permissionSetup/dangerousRuleStash.js'
import { prepareContextForPlanMode } from 'src/permissions/permissionSetup/planAutoMode.js'

/**
 * Handles all state transitions when switching permission modes.
 * Centralises side-effects so that every activation path (CLI Shift+Tab,
 * SDK control messages, etc.) behaves identically.
 *
 * Currently handles:
 * - Plan mode enter/exit attachments (via handlePlanModeTransition)
 * - Auto mode activation: setAutoModeActive, stripDangerousPermissionsForAutoMode
 *
 * Returns the (possibly modified) context. Caller is responsible for setting
 * the mode on the returned context.
 *
 * @param fromMode The current permission mode
 * @param toMode The target permission mode
 * @param context The current tool permission context
 */
export function transitionPermissionMode(
  fromMode: string,
  toMode: string,
  context: ToolPermissionContext,
): ToolPermissionContext {
  // plan→plan (SDK set_permission_mode) would wrongly hit the leave branch below
  if (fromMode === toMode) return context

  handlePlanModeTransition(fromMode, toMode)
  handleAutoModeTransition(fromMode, toMode)

  if (fromMode === 'plan' && toMode !== 'plan') {
    setHasExitedPlanMode(true)
  }

  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (toMode === 'plan' && fromMode !== 'plan') {
      return prepareContextForPlanMode(context)
    }

    // Plan with auto active counts as using the classifier (for the leaving side).
    // isAutoModeActive() is the authoritative signal — prePlanMode/strippedDangerousRules
    // are unreliable proxies because auto can be deactivated mid-plan (non-opt-in
    // entry, transitionPlanAutoMode) while those fields remain set/unset.
    const fromUsesClassifier =
      fromMode === 'auto' ||
      (fromMode === 'plan' &&
        (autoModeStateModule?.isAutoModeActive() ?? false))
    const toUsesClassifier = toMode === 'auto' // plan entry handled above

    if (toUsesClassifier && !fromUsesClassifier) {
      if (!isAutoModeGateEnabled()) {
        throw new Error('Cannot transition to auto mode: gate is not enabled')
      }
      autoModeStateModule?.setAutoModeActive(true)
      context = stripDangerousPermissionsForAutoMode(context)
    } else if (fromUsesClassifier && !toUsesClassifier) {
      autoModeStateModule?.setAutoModeActive(false)
      setNeedsAutoModeExitAttachment(true)
      context = restoreDangerousPermissions(context)
    }
  }

  // Only spread if there's something to clear (preserves ref equality)
  if (fromMode === 'plan' && toMode !== 'plan' && context.prePlanMode) {
    return { ...context, prePlanMode: undefined }
  }

  return context
}
