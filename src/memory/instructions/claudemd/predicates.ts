import { basename, sep } from 'path'
import type { InstructionsMemoryType } from 'src/platform/lifecycleHooks/hooks.js'
import type { MemoryType } from 'src/memory/memdir/types.js'
import { isProjectInstructionFileName } from 'src/memory/instructions/projectInstructions.js'
import type { MemoryFileInfo } from 'src/memory/instructions/claudemd/types.js'

export const MAX_MEMORY_CHARACTER_COUNT = 40000

export function isInstructionsMemoryType(
  type: MemoryType,
): type is InstructionsMemoryType {
  return (
    type === 'User' ||
    type === 'Project' ||
    type === 'Local' ||
    type === 'Managed'
  )
}

export function getLargeMemoryFiles(files: MemoryFileInfo[]): MemoryFileInfo[] {
  return files.filter(file => file.content.length > MAX_MEMORY_CHARACTER_COUNT)
}

const LOCAL_INSTRUCTION_FILE_NAME = 'CLAUDE.local.md'
const RULES_SEGMENT = `${sep}.claudin${sep}rules${sep}`

/**
 * Check if a file path is a memory file (AGENTS.md, CLAUDE.md, CLAUDE.local.md, or .claudin/rules/*.md)
 */
export function isMemoryFilePath(filePath: string): boolean {
  const name = basename(filePath)
  if (isProjectInstructionFileName(name) || name === LOCAL_INSTRUCTION_FILE_NAME) return true
  // The leading separator lets a relative `.claudin/rules/x.md` count too.
  return name.endsWith('.md') && `${sep}${filePath}`.includes(RULES_SEGMENT)
}
