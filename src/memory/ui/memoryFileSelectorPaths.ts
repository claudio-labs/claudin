import { join } from 'path'

import type { MemoryFileInfo } from 'src/memory/instructions/claudemd.js'
import {
  findProjectInstructionFilePathInAncestors,
  PRIMARY_PROJECT_INSTRUCTION_FILE,
} from 'src/memory/instructions/projectInstructions.js'

/**
 * A project instruction file the loader found on its own walk. One it reached
 * through an `@`-import is content of another file, not the directory's root.
 */
function isWalkedProjectFile(file: MemoryFileInfo): boolean {
  return file.type === 'Project' && file.parent === undefined
}

/**
 * The file the picker offers as "Project memory": the nearest one at or above
 * `cwd` that the session loaded, else a new `AGENTS.md` in `cwd`. Only the
 * list is consulted, never the disk, so the row names what is in context.
 */
export function getProjectMemoryPathForSelector(
  existingMemoryFiles: readonly MemoryFileInfo[],
  cwd: string,
): string {
  const walked = new Set(existingMemoryFiles.filter(isWalkedProjectFile).map(file => file.path))
  const nearest = findProjectInstructionFilePathInAncestors(cwd, path => walked.has(path))
  return nearest ?? join(cwd, PRIMARY_PROJECT_INSTRUCTION_FILE)
}
