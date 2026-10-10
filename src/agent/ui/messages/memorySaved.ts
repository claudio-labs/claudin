import { countMemories, MEMORY_SCOPES } from 'src/memory/memdir/memoryScopes.js'
import type { SystemMemorySavedMessage } from 'src/shared/types/message.js'
import { plural } from 'src/shared/text/stringUtils.js'

/** "3 memories" — a count whose directory the message does not say. */
function unscoped(count: number): string {
  return `${count} ${plural(count, 'memory', 'memories')}`
}

/**
 * The parts of the "Saved …" line, one per memory directory in MEMORY_SCOPES
 * order: ["2 global memories", "1 private memory"].
 *
 * A transcript saved before `memoryCounts` still renders: one with the old
 * `teamCount` says its team share and leaves the rest unscoped (global and
 * private were not told apart then), one with neither says only how many.
 * Plain function (not a React component) so the React Compiler won't hoist
 * the property accesses for memoization.
 */
export function memorySavedParts(message: SystemMemorySavedMessage): string[] {
  const total = message.writtenPaths.length
  const counts = message.memoryCounts
  if (counts) {
    const parts = MEMORY_SCOPES.flatMap(scope => {
      const count = counts[scope] ?? 0
      return count > 0 ? [countMemories(scope, count)] : []
    })
    const scoped = MEMORY_SCOPES.reduce((sum, scope) => sum + (counts[scope] ?? 0), 0)
    return total > scoped ? [...parts, unscoped(total - scoped)] : parts
  }
  const team = message.teamCount ?? 0
  const rest = total - team
  return [...(rest > 0 ? [unscoped(rest)] : []), ...(team > 0 ? [countMemories('team', team)] : [])]
}
