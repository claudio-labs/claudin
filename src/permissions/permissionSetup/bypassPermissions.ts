/**
 * The bypass-permissions killswitch: the sync and async checks, and the
 * context transform that revokes the mode.
 *
 * `tengu_disable_bypass_permissions_mode` is a security restriction in this
 * fork — `src/platform/analytics/growthbook.ts` answers it `false` for every
 * reader and a local flag file cannot set it. The settings half
 * (`disableBypassPermissionsMode`) is still honoured.
 */
import {
  checkSecurityRestrictionGate,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE,
} from 'src/platform/analytics/growthbook.js'
import { getInitialSettings } from 'src/platform/settings/settings.js'
import { logForDebugging } from 'src/shared/debug.js'
import { gracefulShutdown } from 'src/shared/proc/gracefulShutdown.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { applyPermissionUpdate } from 'src/permissions/PermissionUpdate.js'

/**
 * Core logic to check if bypassPermissions should be disabled based on Statsig gate
 */
export function shouldDisableBypassPermissions(): Promise<boolean> {
  return checkSecurityRestrictionGate('tengu_disable_bypass_permissions_mode')
}

/**
 * Checks if bypassPermissions mode is currently disabled by Statsig gate or settings.
 * This is a synchronous version that uses cached Statsig values.
 */
export function isBypassPermissionsModeDisabled(): boolean {
  const growthBookDisableBypassPermissionsMode =
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
      'tengu_disable_bypass_permissions_mode',
    )
  const settings = getInitialSettings() || {}
  const settingsDisableBypassPermissionsMode =
    settings.permissions?.disableBypassPermissionsMode === 'disable'

  return (
    growthBookDisableBypassPermissionsMode ||
    settingsDisableBypassPermissionsMode
  )
}

/**
 * Creates an updated context with bypassPermissions disabled
 */
export function createDisabledBypassPermissionsContext(
  currentContext: ToolPermissionContext,
): ToolPermissionContext {
  let updatedContext = currentContext
  if (currentContext.mode === 'bypassPermissions') {
    updatedContext = applyPermissionUpdate(currentContext, {
      type: 'setMode',
      mode: 'default',
      destination: 'session',
    })
  }

  return {
    ...updatedContext,
    isBypassPermissionsModeAvailable: false,
  }
}

/**
 * Asynchronously checks if the bypassPermissions mode should be disabled based on Statsig gate
 * and returns an updated toolPermissionContext if needed
 */
export async function checkAndDisableBypassPermissions(
  currentContext: ToolPermissionContext,
): Promise<void> {
  // Only proceed if bypassPermissions mode is available
  if (!currentContext.isBypassPermissionsModeAvailable) {
    return
  }

  const shouldDisable = await shouldDisableBypassPermissions()
  if (!shouldDisable) {
    return
  }

  // Gate is enabled, need to disable bypassPermissions mode
  logForDebugging(
    'bypassPermissions mode is being disabled by Statsig gate (async check)',
    { level: 'warn' },
  )

  void gracefulShutdown(1, 'bypass_permissions_disabled')
}
