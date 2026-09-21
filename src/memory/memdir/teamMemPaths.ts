import { readFileSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { join, resolve, sep } from 'path'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/platform/analytics/growthbook.js'
import { getAutoMemPath, isAutoMemoryEnabled } from 'src/memory/memdir/paths.js'

/**
 * Whether team memory features are enabled.
 * Team memory is a subdirectory of auto memory, so it requires auto memory
 * to be enabled. This keeps all team-memory consumers (prompt, content
 * injection, file detection) consistent when auto memory is disabled via
 * env var or settings.
 */
export function isTeamMemoryEnabled(): boolean {
  if (!isAutoMemoryEnabled()) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_herring_clock', true)
}

/**
 * Returns the team memory path: <autoMemPath>/team/
 * Lives as a subdirectory of the auto-memory directory, scoped per-project.
 * autoMemPath itself may be project-local (<gitRoot>/.claudin/memory/) or
 * the legacy global path — see getAutoMemPath() in paths.ts.
 */
export function getTeamMemPath(): string {
  return (join(getAutoMemPath(), 'team') + sep).normalize('NFC')
}

/**
 * Returns the team memory entrypoint: <autoMemPath>/team/MEMORY.md
 * Lives as a subdirectory of the auto-memory directory, scoped per-project.
 */
export function getTeamMemEntrypoint(): string {
  return join(getAutoMemPath(), 'team', 'MEMORY.md')
}

const BLANKET_CLAUDIN_IGNORE_RE = /^\/?\.claudin\/?$/
const TEAM_MEM_NEGATION_RE = /^!\/?\.claudin\/memory\/team\/?/

/**
 * Best-effort check for the common case where a project's root .gitignore
 * blanket-excludes .claudin/ (e.g. `/.claudin`), which would silently
 * swallow the team memory dir even after it becomes project-local. Patterns
 * are evaluated in file order, last match wins, matching git's own
 * last-pattern-wins semantics for this narrow pair of pattern shapes.
 *
 * Only recognizes this one common pattern shape; anything more elaborate
 * (nested .gitignore, globs, non-root patterns) fails open (returns false)
 * rather than risk a false-positive nag — consistent with the fallback
 * pattern for tools that wrap ambiguous external state.
 */
export const isTeamMemLikelyGitIgnored = memoize((gitRoot: string): boolean => {
  try {
    const content = readFileSync(join(gitRoot, '.gitignore'), 'utf-8')
    let ignored = false
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      if (BLANKET_CLAUDIN_IGNORE_RE.test(line)) {
        ignored = true
      } else if (TEAM_MEM_NEGATION_RE.test(line)) {
        ignored = false
      }
    }
    return ignored
  } catch {
    return false
  }
})

/**
 * Check if a resolved absolute path is within the team memory directory.
 * Uses path.resolve() to convert relative paths and eliminate traversal segments.
 * Does NOT resolve symlinks: a prefix check on the symbolic path is what the
 * secret guard, the permission auto-allow and the memory prompts need. The
 * symlink-resolving validators left with the HTTP sync — nothing writes
 * server-supplied keys into this directory anymore.
 */
export function isTeamMemPath(filePath: string): boolean {
  // SECURITY: resolve() converts to absolute and eliminates .. segments,
  // preventing path traversal attacks (e.g. "team/../../etc/passwd")
  const resolvedPath = resolve(filePath)
  const teamDir = getTeamMemPath()
  return resolvedPath.startsWith(teamDir)
}

/**
 * Check if a file path is within the team memory directory
 * and team memory is enabled.
 */
export function isTeamMemFile(filePath: string): boolean {
  return isTeamMemoryEnabled() && isTeamMemPath(filePath)
}
