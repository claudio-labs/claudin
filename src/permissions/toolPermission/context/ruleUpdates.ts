import { applyPermissionUpdates, persistPermissionUpdates, supportsPersistence } from 'src/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

export type SetToolPermissionContext = (context: ToolPermissionContext, options?: { preserveMode?: boolean }) => void

/** Whether any update is written to a settings file, so it outlives the session. */
export function writesSettingsFile(updates: readonly PermissionUpdate[]): boolean {
  return updates.some(update => supportsPersistence(update.destination))
}

/**
 * Saves the updates where their destinations say and applies them to the
 * session. Only an explicit mode update may move the mode: the session's
 * context can come from a sub-agent running in a mode of its own.
 */
export function saveRuleUpdates(
  updates: PermissionUpdate[],
  current: ToolPermissionContext,
  setContext: SetToolPermissionContext,
): boolean {
  if (updates.length === 0) return false
  persistPermissionUpdates(updates)
  const movesMode = updates.some(update => update.type === 'setMode')
  setContext(applyPermissionUpdates(current, updates), { preserveMode: !movesMode })
  return writesSettingsFile(updates)
}
