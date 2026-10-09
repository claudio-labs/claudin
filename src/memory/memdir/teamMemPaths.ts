import { readFileSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { join, resolve, sep } from 'path'
import { getPrivateMemPath } from 'src/memory/memdir/paths.js'

/**
 * Returns the team memory path: <privateMemPath>/team/
 * Lives as a subdirectory of the private memory directory, scoped per-project.
 * That directory may be project-local (<gitRoot>/.claudin/memory/) or
 * the legacy per-project one under the config home — see getPrivateMemPath().
 */
export function getTeamMemPath(): string {
  return (join(getPrivateMemPath(), 'team') + sep).normalize('NFC')
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
 * secret guard needs. The symlink-resolving validators left with the HTTP
 * sync — nothing writes server-supplied keys into this directory anymore.
 *
 * Unlike memoryDirs.ts memoryScopeOf, it holds whether or not memory is on:
 * the team dir is git-tracked, so the secret guard scans a write to it either way.
 */
export function isTeamMemPath(filePath: string): boolean {
  // SECURITY: resolve() converts to absolute and eliminates .. segments,
  // preventing path traversal attacks (e.g. "team/../../etc/passwd")
  const resolvedPath = resolve(filePath)
  const teamDir = getTeamMemPath()
  return resolvedPath.startsWith(teamDir)
}
