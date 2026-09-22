/**
 * Text for the "Loaded …" line a collapsed read/search group renders when it
 * read memory files — the third of the three transcript lines memory can
 * produce, beside memoryIndexLine.ts (the session-start indexes) and
 * nestedMemoryBatchLabel (a `paths:` match). Kept out of the `.tsx` for the
 * same reason memoryIndexLine.ts is: a module whose imports reach
 * `src/terminal/ink.js` is unimportable under `bun test`.
 */
import { plural } from 'src/shared/text/stringUtils.js'

/**
 * The counts clause of a recall line: "1 memory", "2 team memories", or
 * "1 memory, 2 team memories" — the nouns and the private-first order
 * nestedMemoryBatchLabel already uses for a `paths:` match. It cannot break
 * the team side down by category the way that one does: the collapsed group
 * carries counts, not the paths a category would come from.
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
