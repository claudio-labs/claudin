import { basename, join } from 'path'

import type { MemoryFileInfo } from 'src/memory/instructions/claudemd.js'
import {
  findProjectInstructionFilePathInAncestors,
  isProjectInstructionFileName,
  PRIMARY_PROJECT_INSTRUCTION_FILE,
} from 'src/memory/instructions/projectInstructions.js'

/**
 * The two instruction files /memory offers to edit. They are instructions —
 * the context calls them that — and "memory" in /memory is the three memory
 * directories listed right below them.
 */
export const USER_INSTRUCTIONS_LABEL = 'User instructions'
export const PROJECT_INSTRUCTIONS_LABEL = 'Project instructions'

/**
 * What the "Opened …" line calls a file /memory opened in the editor: the
 * label of its row when it is one of the two above, else a plain
 * instructions file (a rule, a nested or imported file).
 */
export function instructionsFileName(
  path: string,
  paths: { user: string; project: string },
): string {
  if (path === paths.user) return USER_INSTRUCTIONS_LABEL.toLowerCase()
  if (path === paths.project) return PROJECT_INSTRUCTIONS_LABEL.toLowerCase()
  return 'instructions file'
}

function isLoadedProjectInstructionFile(file: MemoryFileInfo): boolean {
  return (
    file.type === 'Project' &&
    file.parent === undefined &&
    isProjectInstructionFileName(basename(file.path))
  )
}

export function getProjectMemoryPathForSelector(
  existingMemoryFiles: MemoryFileInfo[],
  cwd: string,
): string {
  const loadedProjectInstructionPaths = new Set(
    existingMemoryFiles
      .filter(isLoadedProjectInstructionFile)
      .map(file => file.path),
  )

  return (
    findProjectInstructionFilePathInAncestors(
      cwd,
      path => loadedProjectInstructionPaths.has(path),
    ) ?? join(cwd, PRIMARY_PROJECT_INSTRUCTION_FILE)
  )
}
