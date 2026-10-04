/**
 * The bypass-permissions killswitch: the settings check, and the context
 * transform that revokes the mode. Only settings
 * (`disableBypassPermissionsMode`) can turn it on.
 */
import { getInitialSettings } from 'src/platform/settings/settings.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

/**
 * Checks if bypassPermissions mode is currently disabled by settings.
 */
export function isBypassPermissionsModeDisabled(): boolean {
  const settings = getInitialSettings() || {}
  return settings.permissions?.disableBypassPermissionsMode === 'disable'
}

/**
 * Revokes bypass for a running session: a session sitting in it falls back to
 * `default`, every other mode and every rule stays, and the input is left as
 * it was.
 */
export function createDisabledBypassPermissionsContext(
  currentContext: ToolPermissionContext,
): ToolPermissionContext {
  const wasBypassing = currentContext.mode === 'bypassPermissions'
  return {
    ...currentContext,
    mode: wasBypassing ? 'default' : currentContext.mode,
    isBypassPermissionsModeAvailable: false,
  }
}
