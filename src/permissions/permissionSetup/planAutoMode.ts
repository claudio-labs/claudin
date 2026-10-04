/**
 * Plan mode's relationship with auto mode: whether plan borrows auto
 * semantics, the centralized plan-mode entry, and the mid-plan reconciliation
 * that runs when settings change.
 */
import { setNeedsAutoModeExitAttachment } from 'src/platform/bootstrap/state.js'
import { getInitialSettings } from 'src/platform/settings/settings.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { isAutoModeGateEnabled } from 'src/permissions/permissionSetup/autoModeAvailability.js'
import {
  autoModeBuiltIn,
  autoSemanticsActive,
  switchAutoOff,
  switchAutoOn,
} from 'src/permissions/permissionSetup/autoSession.js'
import { stripDangerousPermissionsForAutoMode } from 'src/permissions/permissionSetup/dangerousRuleStash.js'
import { anyTrustedLayer } from 'src/permissions/permissionSetup/trustedSettings.js'

export function isDefaultPermissionModeAuto(): boolean {
  if (!autoModeBuiltIn()) return false
  return getInitialSettings().permissions?.defaultMode === 'auto'
}

/**
 * Plan borrows auto only on an opt-in from a trusted layer, while no trusted
 * layer opts plan out, and while the gate is open. The repository's own
 * settings can do neither.
 */
export function shouldPlanUseAutoMode(): boolean {
  if (!autoModeBuiltIn()) return false
  const optedIn = anyTrustedLayer(settings => settings.skipAutoPermissionPrompt === true)
  if (!optedIn) return false
  const optedOutForPlan = anyTrustedLayer(settings => settings.useAutoModeDuringPlan === false)
  return !optedOutForPlan && isAutoModeGateEnabled()
}

/**
 * Remembers the mode plan was entered from, and settles whether plan runs
 * with auto. The caller sets `mode`.
 */
export function prepareContextForPlanMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  if (context.mode === 'plan') return context
  const entering = context.mode
  if (!autoModeBuiltIn() || entering === 'bypassPermissions') {
    return { ...context, prePlanMode: entering }
  }
  const borrow = shouldPlanUseAutoMode()
  if (entering === 'auto') {
    // Already in auto: keep it on when plan may borrow it, end it otherwise.
    const settled = borrow ? context : switchAutoOff(context)
    return { ...settled, prePlanMode: entering }
  }
  const settled = borrow ? switchAutoOn(context) : context
  return { ...settled, prePlanMode: entering }
}

/** Brings a context already in plan in line with a settings change. */
export function transitionPlanAutoMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  if (!autoModeBuiltIn()) return context
  if (context.mode !== 'plan' || context.prePlanMode === 'bypassPermissions') {
    return context
  }
  const wanted = shouldPlanUseAutoMode()
  const running = autoSemanticsActive()
  if (wanted && running) {
    // The reload may have brought risky rules back from disk.
    return stripDangerousPermissionsForAutoMode(context)
  }
  if (wanted) {
    setNeedsAutoModeExitAttachment(false)
    return switchAutoOn(context)
  }
  return running ? switchAutoOff(context) : context
}
