import { basename, dirname, join, sep } from 'path'
import picomatch from 'picomatch'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import type { MemoryType } from 'src/memory/memdir/types.js'
import { getInitialSettings } from 'src/platform/settings/settings.js'

/** Policy files and the memory indexes are outside the user's reach. */
const EXCLUDABLE_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>(['User', 'Project', 'Local'])

/** A segment holding one of these is where a pattern stops being a literal path. */
const GLOB_SYNTAX_RE = /[*?[\]{}()]/
const DRIVE_ROOT_RE = /^[A-Za-z]:\//
const TRAILING_SLASH_RE = /\/$/

const MATCH_OPTIONS = { dot: true }

export function isClaudeMdExcluded(filePath: string, type: MemoryType): boolean {
  if (!EXCLUDABLE_TYPES.has(type)) return false
  const patterns = (getInitialSettings().claudeMdExcludes ?? []).filter(pattern => pattern !== '')
  if (patterns.length === 0) return false
  return picomatch.isMatch(withForwardSlashes(filePath), resolveExcludePatterns(patterns), MATCH_OPTIONS)
}

/**
 * Each pattern, plus a copy whose literal directories are resolved through
 * links, so a pattern written through a linked directory also matches the
 * real paths the loader reports.
 */
function resolveExcludePatterns(patterns: string[]): string[] {
  const resolved = new Set<string>()
  for (const pattern of patterns) {
    const written = withForwardSlashes(pattern)
    resolved.add(written)
    const real = throughLinks(written)
    if (real !== null) resolved.add(real)
  }
  return [...resolved]
}

function throughLinks(pattern: string): string | null {
  if (!pattern.startsWith('/') && !DRIVE_ROOT_RE.test(pattern)) return null
  const segments = pattern.split('/')
  const firstGlob = segments.findIndex(segment => GLOB_SYNTAX_RE.test(segment))
  // Without a wildcard the last segment is the file name, not a directory.
  const literalCount = firstGlob === -1 ? segments.length - 1 : firstGlob
  const literal = segments.slice(0, literalCount).join('/') || '/'
  const real = realpathOfDeepestExisting(literal)
  if (real === null || real === literal) return null
  return [real.replace(TRAILING_SLASH_RE, ''), ...segments.slice(literalCount)].join('/')
}

/** The real path of `path`, resolving its deepest existing ancestor when the rest is missing. */
function realpathOfDeepestExisting(path: string): string | null {
  const fs = getFsImplementation()
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      return withForwardSlashes(join(fs.realpathSync(current), ...missing))
    } catch {
      const up = dirname(current)
      if (up === current) return null
      missing.unshift(basename(current))
      current = up
    }
  }
}

function withForwardSlashes(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}
