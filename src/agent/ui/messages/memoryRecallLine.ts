/**
 * Text for the memory-recall "Loaded …" line — the one the collapsed
 * read/search group and the standalone `relevant_memories` attachment share.
 * Kept out of the `.tsx` for the same reason memoryIndexLine.ts is: a module
 * whose imports reach `src/terminal/ink.js` is unimportable under `bun test`.
 */
import { plural } from 'src/shared/text/stringUtils.js'

/**
 * The counts clause of a recall line: "1 memory", "2 team memories", or
 * "1 memory, 2 team memories". Private precedes team, the same order
 * formatMemoryIndexCounts uses for the MEMORY.md indexes.
 *
 * Returns undefined when nothing was recalled, so a caller renders no line at
 * all rather than an empty one.
 */
export function formatMemoryRecallCounts(
  privateCount: number,
  teamCount: number,
): string | undefined {
  const parts: string[] = []
  if (privateCount > 0) {
    parts.push(`${privateCount} ${plural(privateCount, 'memory', 'memories')}`)
  }
  if (teamCount > 0) {
    parts.push(`${teamCount} team ${plural(teamCount, 'memory', 'memories')}`)
  }
  return parts.length > 0 ? parts.join(', ') : undefined
}
