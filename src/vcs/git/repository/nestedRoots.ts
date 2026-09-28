import { readdir } from 'fs/promises'
import { join } from 'path'
import { canonicalRootOfRepository } from 'src/vcs/git/repository/canonicalRoot.js'
import { pathExists, reportUnexpectedFsError } from 'src/vcs/git/repository/entryKind.js'

const DEFAULT_MAX_DEPTH = 3
const DEFAULT_MAX_DIRS = 1500
// Dependency, build-output and environment directories: a repository inside
// one is a vendored copy, not the user's work. Names starting with a dot
// (.git, .next, .turbo, .cache, .venv, ...) are skipped by rule.
const SKIPPED_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'coverage',
  'venv',
  '__pycache__',
])

/**
 * The canonical roots of the repositories below `baseDir`, breadth first. A
 * directory with a `.git` of its own is reported and not entered, and
 * `baseDir` itself is never reported. Its children are depth 1; symlinked
 * directories are not followed, and at most `maxDirs` directories are
 * examined in all.
 */
export async function findNestedGitRoots(
  baseDir: string,
  opts: { maxDepth?: number; maxDirs?: number } = {},
): Promise<string[]> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH
  let budget = opts.maxDirs ?? DEFAULT_MAX_DIRS
  const found = new Set<string>()
  let level = await scannableChildren(baseDir)
  for (let depth = 1; depth <= maxDepth && level.length > 0; depth++) {
    const nextLevel: string[] = []
    for (const dir of level) {
      if (budget <= 0) return [...found]
      budget--
      if (await pathExists(join(dir, '.git'))) found.add(canonicalRootOfRepository(dir))
      else if (depth < maxDepth) nextLevel.push(...(await scannableChildren(dir)))
    }
    level = nextLevel
  }
  return [...found]
}

async function scannableChildren(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter(
        entry =>
          entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_NAMES.has(entry.name),
      )
      .map(entry => join(dir, entry.name))
      .sort()
  } catch (error) {
    reportUnexpectedFsError(dir, error)
    return []
  }
}
