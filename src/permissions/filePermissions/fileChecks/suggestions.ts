import { createReadRuleSuggestion } from 'src/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import { pathInAllowedWorkingPath } from 'src/permissions/filePermissions/workingDirs.js'
import { getPathsForPermissionCheck } from 'src/shared/fs/fsOperations.js'
import { expandPath, getDirectoryForPath } from 'src/shared/fs/path.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import type { ResolvedPaths } from 'src/permissions/filePermissions/fileChecks/target.js'

export type SuggestionOperation = 'read' | 'write' | 'create'

type Mode = ToolPermissionContext['mode']

/** Modes in which switching to acceptEdits is still worth offering. */
const MODES_OFFERING_ACCEPT_EDITS: ReadonlySet<Mode> = new Set<Mode>(['default', 'plan'])

/**
 * What a prompt about `filePath` offers to remember. Inside the working
 * directories that is acceptEdits; outside, a read gets a Read rule per
 * spelling of the directory, and a write the directory itself.
 */
export function suggestionsFor(
  filePath: string,
  operation: SuggestionOperation,
  context: ToolPermissionContext,
  resolved?: ResolvedPaths,
): PermissionUpdate[] {
  const path = expandPath(filePath)
  const offerAcceptEdits = MODES_OFFERING_ACCEPT_EDITS.has(context.mode)
  const acceptEdits: PermissionUpdate[] = offerAcceptEdits
    ? [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
    : []
  if (pathInAllowedWorkingPath(path, context, resolved)) return acceptEdits

  // A symlinked directory is offered in both spellings, the link first.
  const directories = getPathsForPermissionCheck(getDirectoryForPath(path))
  if (operation === 'read') {
    return directories.flatMap(directory => createReadRuleSuggestion(directory) ?? [])
  }
  return [...acceptEdits, { type: 'addDirectories', directories, destination: 'session' }]
}
