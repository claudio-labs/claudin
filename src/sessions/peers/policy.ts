import type { PermissionMode } from 'src/shared/types/permissions.js'
import type { PermissionClass } from 'src/sessions/peers/frames.js'

/**
 * The side of the permission line a session is on: `bypass` runs tools
 * without asking anyone, every other mode still stops for its user.
 */
export function permissionClassOf(mode: PermissionMode): PermissionClass {
  return mode === 'bypassPermissions' ? 'bypass' : 'prompting'
}
