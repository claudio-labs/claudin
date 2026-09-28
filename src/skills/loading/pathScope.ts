/**
 * What a skill's `paths:` frontmatter means: the patterns it keeps, and how a
 * touched file is matched against them, with gitignore semantics relative to
 * the cwd. A rule's `paths:` reads the same way.
 */
import ignore from 'ignore'
import { isAbsolute, relative } from 'path'

import { splitPathInFrontmatter } from 'src/shared/frontmatterParser.js'

const TRAILING_GLOBSTAR = '/**'
const EVERYTHING = '**'
const PARENT_DIRECTORY = '..'

/** The patterns that scope a skill, or undefined when it applies everywhere. */
export function parseSkillPaths(value: unknown): string[] | undefined {
  const written = writtenPatterns(value)
  if (written === undefined) return undefined
  const patterns = splitPathInFrontmatter(written)
    // `ignore` matches what is inside a directory through the directory itself.
    .map(pattern =>
      pattern.endsWith(TRAILING_GLOBSTAR)
        ? pattern.slice(0, -TRAILING_GLOBSTAR.length)
        : pattern,
    )
    .filter(pattern => pattern.length > 0)
  return patterns.every(pattern => pattern === EVERYTHING) ? undefined : patterns
}

export function createPathScope(
  patterns: readonly string[],
): (scopePath: string) => boolean {
  const matcher = ignore().add(patterns)
  return scopePath => matcher.ignores(scopePath)
}

/**
 * A touched file in the form it is matched in: relative to the cwd. There is
 * none for what can never match: an empty path, the cwd itself, and anything
 * outside the cwd, whether above it or on another Windows drive, where the
 * relative form stays absolute.
 */
export function toScopePath(filePath: string, cwd: string): string | undefined {
  const scopePath = isAbsolute(filePath) ? relative(cwd, filePath) : filePath
  if (
    scopePath === '' ||
    scopePath.startsWith(PARENT_DIRECTORY) ||
    isAbsolute(scopePath)
  ) {
    return undefined
  }
  return scopePath
}

/** A comma-separated string or a list; anything else scopes nothing. */
function writtenPatterns(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
  }
  return undefined
}
