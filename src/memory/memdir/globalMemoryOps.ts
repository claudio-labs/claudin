import { normalize } from 'path'
import {
  getGlobalMemPath,
  isGlobalMemoryEnabled,
  isGlobalMemPath,
} from 'src/memory/memdir/paths.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'

/**
 * The global-memory half of the collapsed read/search badge, beside
 * teamMemoryOps.ts. Not feature-gated: the global directory is on whenever
 * auto memory is (CLAUDIN_GLOBAL_MEMORY=0 turns it off), and every predicate
 * here goes false with it through isGlobalMemPath / isGlobalMemoryEnabled.
 */

const TRAILING_SEP_RE = /[/\\]+$/

/**
 * Check if a search tool use targets the global memory directory by its path.
 * Unlike a file check, the bare directory (no trailing separator) counts too:
 * a Grep/Glob over the whole global dir names it that way.
 */
export function isGlobalMemorySearch(toolInput: unknown): boolean {
  const input = toolInput as { path?: string } | undefined
  if (!input?.path) {
    return false
  }
  if (isGlobalMemPath(input.path)) {
    return true
  }
  return (
    isGlobalMemoryEnabled() &&
    normalize(input.path).replace(TRAILING_SEP_RE, '') ===
      getGlobalMemPath().replace(TRAILING_SEP_RE, '')
  )
}

/**
 * Check if a Write or Edit tool use targets a global memory file.
 */
export function isGlobalMemoryWriteOrEdit(
  toolName: string,
  toolInput: unknown,
): boolean {
  if (toolName !== FILE_WRITE_TOOL_NAME && toolName !== FILE_EDIT_TOOL_NAME) {
    return false
  }
  const input = toolInput as { file_path?: string; path?: string } | undefined
  const filePath = input?.file_path ?? input?.path
  return filePath !== undefined && isGlobalMemPath(filePath)
}

function verbFor(
  isActive: boolean,
  isFirst: boolean,
  active: string,
  done: string,
): string {
  const verb = isActive ? active : done
  return isFirst ? verb[0]!.toUpperCase() + verb.slice(1) : verb
}

/**
 * Append the global memory summary parts to `parts`, for
 * getSearchReadSummaryText — "Recalled 1 global memory", "searched global
 * memories", "wrote 2 global memories".
 */
export function appendGlobalMemorySummaryParts(
  memoryCounts: {
    globalMemoryReadCount?: number
    globalMemorySearchCount?: number
    globalMemoryWriteCount?: number
  },
  isActive: boolean,
  parts: string[],
): void {
  const readCount = memoryCounts.globalMemoryReadCount ?? 0
  const searchCount = memoryCounts.globalMemorySearchCount ?? 0
  const writeCount = memoryCounts.globalMemoryWriteCount ?? 0
  if (readCount > 0) {
    const verb = verbFor(isActive, parts.length === 0, 'recalling', 'recalled')
    parts.push(
      `${verb} ${readCount} global ${readCount === 1 ? 'memory' : 'memories'}`,
    )
  }
  if (searchCount > 0) {
    const verb = verbFor(isActive, parts.length === 0, 'searching', 'searched')
    parts.push(`${verb} global memories`)
  }
  if (writeCount > 0) {
    const verb = verbFor(isActive, parts.length === 0, 'writing', 'wrote')
    parts.push(
      `${verb} ${writeCount} global ${writeCount === 1 ? 'memory' : 'memories'}`,
    )
  }
}
