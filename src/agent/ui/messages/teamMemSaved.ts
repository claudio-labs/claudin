import type { SystemMemorySavedMessage } from 'src/shared/types/message.js'

/**
 * Returns the team-memory segment for the memory-saved UI, plus the count so
 * the caller can derive the private count without accessing teamCount itself.
 * Plain function (not a React component) so the React Compiler won't hoist
 * the teamCount property access for memoization. This module is only loaded
 * when feature('TEAMMEM') is true.
 */
export function teamMemSavedPart(
  // teamCount is set ad-hoc on the message when feature('TEAMMEM') is on
  // (see extractMemories.ts), but SystemMemorySavedMessage doesn't declare
  // it — widen locally rather than editing the shared message type.
  message: SystemMemorySavedMessage & { teamCount?: number },
): { segment: string; count: number } | null {
  const count = message.teamCount ?? 0
  if (count === 0) return null
  return {
    segment: `${count} team ${count === 1 ? 'memory' : 'memories'}`,
    count,
  }
}
