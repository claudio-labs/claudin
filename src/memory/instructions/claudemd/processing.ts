import { normalizePathForComparison } from 'src/shared/fs/file.js'
import { getFsImplementation, safeResolvePath } from 'src/shared/fs/fsOperations.js'
import type { MemoryType } from 'src/memory/memdir/types.js'
import { MAX_INCLUDE_DEPTH } from 'src/memory/instructions/claudemd/includes.js'
import { isClaudeMdExcluded } from 'src/memory/instructions/claudemd/exclusions.js'
import {
  pathInOriginalCwd,
  safelyReadMemoryFileAsync,
} from 'src/memory/instructions/claudemd/parsing.js'
import { listRuleFiles } from 'src/memory/instructions/claudemd/rulesDirectory.js'
import type { MemoryFileInfo } from 'src/memory/instructions/claudemd/types.js'

/**
 * One file, then the files it includes, depth-first. A path enters
 * `processedPaths` before it is read, missing or not, so each file loads once
 * per set and include cycles end.
 */
export async function processMemoryFile(
  filePath: string,
  type: MemoryType,
  processedPaths: Set<string>,
  includeExternal: boolean,
  depth: number = 0,
  parent?: string,
): Promise<MemoryFileInfo[]> {
  const key = normalizePathForComparison(filePath)
  if (processedPaths.has(key) || depth >= MAX_INCLUDE_DEPTH) return []
  if (isClaudeMdExcluded(filePath, type)) return []
  processedPaths.add(key)

  // A link is reported under its own path, but its includes resolve next to
  // the target, and the target counts as seen too.
  const { resolvedPath, isSymlink } = safeResolvePath(getFsImplementation(), filePath)
  if (isSymlink) processedPaths.add(normalizePathForComparison(resolvedPath))

  const { info, includePaths } = await safelyReadMemoryFileAsync(filePath, type, resolvedPath)
  if (info === null || info.content.trim() === '') return []

  const loaded: MemoryFileInfo[] = [parent === undefined ? info : { ...info, parent }]
  for (const target of includePaths) {
    // The reference's own path is judged, not where a link at it points.
    if (!includeExternal && !pathInOriginalCwd(target)) continue
    loaded.push(...(await processMemoryFile(target, type, processedPaths, includeExternal, depth + 1, filePath)))
  }
  return loaded
}

export type RulesDirectoryRequest = {
  rulesDir: string
  type: MemoryType
  processedPaths: Set<string>
  includeExternal: boolean
  visitedDirs?: Set<string>
}

/**
 * Every rule of a directory with its includes, scoped or not. Every rule file
 * read lands in `processedPaths`, whichever half the caller keeps.
 */
export async function loadRulesDirectory({
  rulesDir,
  type,
  processedPaths,
  includeExternal,
  visitedDirs = new Set(),
}: RulesDirectoryRequest): Promise<MemoryFileInfo[]> {
  const loaded: MemoryFileInfo[] = []
  for (const ruleFile of await listRuleFiles(rulesDir, visitedDirs)) {
    loaded.push(...(await processMemoryFile(ruleFile, type, processedPaths, includeExternal)))
  }
  return loaded
}

export function isScopedRule(file: MemoryFileInfo): boolean {
  return (file.globs?.length ?? 0) > 0
}

export async function processMdRules({
  rulesDir,
  type,
  processedPaths,
  includeExternal,
  conditionalRule,
  visitedDirs = new Set(),
}: {
  rulesDir: string
  type: MemoryType
  processedPaths: Set<string>
  includeExternal: boolean
  conditionalRule: boolean
  visitedDirs?: Set<string>
}): Promise<MemoryFileInfo[]> {
  const loaded = await loadRulesDirectory({ rulesDir, type, processedPaths, includeExternal, visitedDirs })
  return loaded.filter(file => isScopedRule(file) === conditionalRule)
}
