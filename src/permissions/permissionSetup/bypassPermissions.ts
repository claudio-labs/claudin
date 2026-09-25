/**
 * The bypass-permissions killswitch: the settings check, and the context
 * transform that revokes the mode. Only settings
 * (`disableBypassPermissionsMode`) can turn it on.
 */
import { getInitialSettings } from 'src/platform/settings/settings.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { applyPermissionUpdate } from 'src/permissions/PermissionUpdate.js'

/**
 * Checks if bypassPermissions mode is currently disabled by settings.
 */
export function isBypassPermissionsModeDisabled(): boolean {
  const settings = getInitialSettings() || {}
  return settings.permissions?.disableBypassPermissionsMode === 'disable'
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
