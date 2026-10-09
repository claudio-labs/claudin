/**
 * Text for the "Loaded …" line a collapsed read/search group renders when it
 * read memory files — the third of the three transcript lines memory can
 * produce, beside memoryIndexLine.ts (the session-start indexes) and
 * nestedMemoryBatchLabel (a `paths:` match). Kept out of the `.tsx` for the
 * same reason memoryIndexLine.ts is: a module whose imports reach
 * `src/terminal/ink.js` is unimportable under `bun test`.
 */
import {
  countMemories,
  MEMORY_SCOPES,
  type MemoryScope,
} from 'src/memory/memdir/memoryScopes.js'

/**
 * The counts clause of a recall line: "1 private memory", "2 team memories",
 * or "2 global memories, 1 private memory, 3 team memories" — one part per
 * scope, in MEMORY_SCOPES order (general to specific). It cannot break the
 * team side down by category the way nestedMemoryBatchLabel does: the
 * collapsed group carries counts, not the paths a category would come from.
 *
 * Returns undefined when nothing was recalled, so a caller renders no line at
 * all rather than an empty one.
 */
export function formatMemoryRecallCounts(
  memoryOps: Partial<Record<MemoryScope, { read: number }>> | undefined,
): string | undefined {
  const parts: string[] = []
  for (const scope of MEMORY_SCOPES) {
    const read = memoryOps?.[scope]?.read ?? 0
    if (read > 0) {
      parts.push(countMemories(scope, read))
    }
  }
  return parts.length > 0 ? parts.join(', ') : undefined
}
