import { resolve } from 'path'
import { getTeamMemPath, isTeamMemFile, isTeamMemoryEnabled } from 'src/memory/memdir/teamMemPaths.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { capitalize } from 'src/shared/text/stringUtils.js'

export { isTeamMemFile }

/** The two path keys a file or search tool may name its target with. */
type PathInput = { file_path?: unknown; path?: unknown }

function isPathInput(toolInput: unknown): toolInput is PathInput {
  return typeof toolInput === 'object' && toolInput !== null
}

const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([FILE_WRITE_TOOL_NAME, FILE_EDIT_TOOL_NAME])

/**
 * The team directory itself. `isTeamMemFile` only accepts paths below it,
 * because resolving drops the trailing separator its prefix test relies on.
 */
function isTeamMemDir(path: string): boolean {
  return isTeamMemoryEnabled() && resolve(path) === resolve(getTeamMemPath())
}

export function isTeamMemorySearch(toolInput: unknown): boolean {
  if (!isPathInput(toolInput)) return false
  const { path } = toolInput
  if (typeof path !== 'string' || path === '') return false
  return isTeamMemFile(path) || isTeamMemDir(path)
}

export function isTeamMemoryWriteOrEdit(
  toolName: string,
  toolInput: unknown,
): boolean {
  if (!WRITE_TOOL_NAMES.has(toolName) || !isPathInput(toolInput)) return false
  const target = toolInput.file_path ?? toolInput.path
  return typeof target === 'string' && isTeamMemFile(target)
}

type TeamMemoryCounts = {
  teamMemoryReadCount?: number
  teamMemorySearchCount?: number
  teamMemoryWriteCount?: number
}

type SummaryPhrase = {
  count: keyof TeamMemoryCounts
  running: string
  done: string
  /** Searches are summarised without their number. */
  showsCount: boolean
}

const SUMMARY_PHRASES: readonly SummaryPhrase[] = [
  { count: 'teamMemoryReadCount', running: 'recalling', done: 'recalled', showsCount: true },
  { count: 'teamMemorySearchCount', running: 'searching', done: 'searched', showsCount: false },
  { count: 'teamMemoryWriteCount', running: 'writing', done: 'wrote', showsCount: true },
]

function phraseFor(phrase: SummaryPhrase, n: number, isActive: boolean, opensLine: boolean): string {
  const verb = isActive ? phrase.running : phrase.done
  const object = !phrase.showsCount
    ? 'team memories'
    : `${n} ${n === 1 ? 'team memory' : 'team memories'}`
  return `${opensLine ? capitalize(verb) : verb} ${object}`
}

export function appendTeamMemorySummaryParts(
  memoryCounts: {
    teamMemoryReadCount?: number
    teamMemorySearchCount?: number
    teamMemoryWriteCount?: number
  },
  isActive: boolean,
  parts: string[],
): void {
  for (const phrase of SUMMARY_PHRASES) {
    const n = memoryCounts[phrase.count] ?? 0
    if (n > 0) parts.push(phraseFor(phrase, n, isActive, parts.length === 0))
  }
}
