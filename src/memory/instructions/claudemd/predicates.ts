import { basename, sep } from 'path'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/platform/analytics/growthbook.js'
import type { InstructionsMemoryType } from 'src/platform/lifecycleHooks/hooks.js'
import type { MemoryType } from 'src/memory/memdir/types.js'
import { isProjectInstructionFileName } from 'src/memory/instructions/projectInstructions.js'
import type { MemoryFileInfo } from 'src/memory/instructions/claudemd/types.js'

// Recommended max character count for a memory file
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
  return files.filter(f => f.content.length > MAX_MEMORY_CHARACTER_COUNT)
}

/**
 * When tengu_moth_copse is on, the findRelevantMemories prefetch surfaces
 * memory files via attachments, so the MEMORY.md index is no longer injected
 * into the system prompt. Callsites that care about "what's actually in
 * context" (context builder, /context viz) should filter through this.
 */
export function filterInjectedMemoryFiles(
  files: MemoryFileInfo[],
): MemoryFileInfo[] {
  const skipMemoryIndex = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_moth_copse',
    false,
  )
  if (!skipMemoryIndex) return files
  return files.filter(f => f.type !== 'AutoMem' && f.type !== 'TeamMem')
}

/**
 * Check if a file path is a memory file (AGENTS.md, CLAUDE.md, CLAUDE.local.md, or .claudin/rules/*.md)
 */
export function isMemoryFilePath(filePath: string): boolean {
  const name = basename(filePath)

  // Root instruction files or CLAUDE.local.md anywhere
  if (isProjectInstructionFileName(name) || name === 'CLAUDE.local.md') {
    return true
  }

  // .md files in .claudin/rules/ directories
  if (
    name.endsWith('.md') &&
    filePath.includes(`${sep}.claudin${sep}rules${sep}`)
  ) {
    return true
  }

  return false
}
