import { feature } from 'bun:bundle'
import { getTeamMemPath, isTeamMemoryEnabled } from 'src/memory/memdir/teamMemPaths.js'

/**
 * Resolves the team memory dir for a `/memory tidy` run, or null when team
 * memory isn't active. Kept in its own module so tests can mock this boundary
 * — under `bun test` the preload stubs `bun:bundle` with feature() → false
 * (src/stubs/test-preload.ts), so the team-on path is unreachable through
 * tidy.ts directly.
 */
export function resolveTidyTeamRoot(): string | null {
  if (feature('TEAMMEM')) {
    if (isTeamMemoryEnabled()) {
      return getTeamMemPath()
    }
  }
  return null
}
