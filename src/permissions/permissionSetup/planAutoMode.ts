/**
 * Plan mode's relationship with auto mode: whether plan borrows auto
 * semantics, the centralized plan-mode entry, and the mid-plan reconciliation
 * that runs when settings change.
 */
import { feature } from 'bun:bundle'
import { setNeedsAutoModeExitAttachment } from 'src/platform/bootstrap/state.js'
import {
  getInitialSettings,
  getUseAutoModeDuringPlan,
  hasAutoModeOptIn,
} from 'src/platform/settings/settings.js'
import { logForDebugging } from 'src/shared/debug.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { autoModeStateModule } from 'src/permissions/permissionSetup/autoModeStateBridge.js'
import { isAutoModeGateEnabled } from 'src/permissions/permissionSetup/autoModeAvailability.js'
import {
  restoreDangerousPermissions,
  stripDangerousPermissionsForAutoMode,
} from 'src/permissions/permissionSetup/dangerousRuleStash.js'

export function isDefaultPermissionModeAuto(): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const settings = getInitialSettings() || {}
    return settings.permissions?.defaultMode === 'auto'
  }
  return false
}

/**
 * Whether plan mode should use auto mode semantics (classifier runs during
 * plan). True when the user has opted in to auto mode and the gate is enabled.
 * Evaluated at permission-check time so it's reactive to config changes.
 */
export function shouldPlanUseAutoMode(): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    return (
      hasAutoModeOptIn() &&
      isAutoModeGateEnabled() &&
      getUseAutoModeDuringPlan()
    )
  }
  return false
}

/**
 * Centralized plan-mode entry. Stashes the current mode as prePlanMode so
 * ExitPlanMode can restore it. When the user has opted in to auto mode,
 * auto semantics stay active during plan mode.
 */
export function prepareContextForPlanMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const currentMode = context.mode
  if (currentMode === 'plan') return context
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const planAutoMode = shouldPlanUseAutoMode()
    if (currentMode === 'auto') {
      if (planAutoMode) {
        return { ...context, prePlanMode: 'auto' }
      }
      autoModeStateModule?.setAutoModeActive(false)
      setNeedsAutoModeExitAttachment(true)
      return {
        ...restoreDangerousPermissions(context),
        prePlanMode: 'auto',
      }
    }
    if (planAutoMode && currentMode !== 'bypassPermissions') {
      autoModeStateModule?.setAutoModeActive(true)
      return {
        ...stripDangerousPermissionsForAutoMode(context),
        prePlanMode: currentMode,
      }
    }
  }
  logForDebugging(
    `[prepareContextForPlanMode] plain plan entry, prePlanMode=${currentMode}`,
    { level: 'info' },
  )
  return { ...context, prePlanMode: currentMode }
}

/**
 * Reconciles auto-mode state during plan mode after a settings change.
 * Compares desired state (shouldPlanUseAutoMode) against actual state
 * (isAutoModeActive) and activates/deactivates auto accordingly. No-op when
 * not in plan mode. Called from applySettingsChange so that toggling
 * useAutoModeDuringPlan mid-plan takes effect immediately.
 */
export function transitionPlanAutoMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  if (!feature('TRANSCRIPT_CLASSIFIER')) return context
  if (context.mode !== 'plan') return context
  // Mirror prepareContextForPlanMode's entry-time exclusion — never activate
  // auto mid-plan when the user entered from a dangerous mode.
  if (context.prePlanMode === 'bypassPermissions') {
    return context
  }

  const want = shouldPlanUseAutoMode()
  const have = autoModeStateModule?.isAutoModeActive() ?? false

  if (want && have) {
    // syncPermissionRulesFromDisk (called before us in applySettingsChange)
    // re-adds dangerous rules from disk without touching strippedDangerousRules.
    // Re-strip so the classifier isn't bypassed by prefix-rule allow matches.
    return stripDangerousPermissionsForAutoMode(context)
  }
  if (!want && !have) return context

  if (want) {
    autoModeStateModule?.setAutoModeActive(true)
    setNeedsAutoModeExitAttachment(false)
    return stripDangerousPermissionsForAutoMode(context)
  }
  autoModeStateModule?.setAutoModeActive(false)
  setNeedsAutoModeExitAttachment(true)
  return restoreDangerousPermissions(context)
}
