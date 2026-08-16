import { basename, dirname, isAbsolute, join, relative, sep } from 'path'
import picomatch from 'picomatch'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import {
  getFileReadIgnorePatterns,
  normalizePatternsToPath,
} from 'src/permissions/filesystem.js'
import { getPlatform } from 'src/shared/proc/platform.js'
import { getGlobExclusionsForPluginCache } from 'src/plugins/orphanedPluginFilter.js'
import type { RipgrepIncompleteReason } from 'src/shared/fs/ripgrep.js'
import { ripGrepWithStatus } from 'src/shared/fs/ripgrep.js'

/**
 * Extracts the static base directory from a glob pattern.
 * The base directory is everything before the first glob special character (* ? [ {).
 * Returns the directory portion and the remaining relative pattern.
 */
export function extractGlobBaseDirectory(pattern: string): {
  baseDir: string
  relativePattern: string
} {
  // Find the first glob special character: *, ?, [, {
  const globChars = /[*?[{]/
  const match = pattern.match(globChars)

  if (!match || match.index === undefined) {
    // No glob characters - this is a literal path
    // Return the directory portion and filename as pattern
    const dir = dirname(pattern)
    const file = basename(pattern)
    return { baseDir: dir, relativePattern: file }
  }

  // Get everything before the first glob character
  const staticPrefix = pattern.slice(0, match.index)

  // Find the last path separator in the static prefix
  const lastSepIndex = Math.max(
    staticPrefix.lastIndexOf('/'),
    staticPrefix.lastIndexOf(sep),
  )

  if (lastSepIndex === -1) {
    // No path separator before the glob - pattern is relative to cwd
    return { baseDir: '', relativePattern: pattern }
  }

  let baseDir = staticPrefix.slice(0, lastSepIndex)
  const relativePattern = pattern.slice(lastSepIndex + 1)

  // Handle root directory patterns (e.g., /*.txt on Unix or C:/*.txt on Windows)
  // When lastSepIndex is 0, baseDir is empty but we need to use '/' as the root
  if (baseDir === '' && lastSepIndex === 0) {
    baseDir = '/'
  }

  // Handle Windows drive root paths (e.g., C:/*.txt)
  // 'C:' means "current directory on drive C" (relative), not root
  // We need 'C:/' or 'C:\' for the actual drive root
  if (getPlatform() === 'windows' && /^[A-Za-z]:$/.test(baseDir)) {
    baseDir = baseDir + sep
  }

  return { baseDir, relativePattern }
}

/** Ordering ripgrep applies to the walk. `path` is what `find … | sort` asked for. */
export type GlobSort = 'modified' | 'path'

/** What the walk lists. Directories are DERIVED — see deriveDirectories. */
export type GlobEntryType = 'file' | 'dir'

/**
 * ripgrep prints `./a/b.ts` when it is given `.` as its path. `join()` folds
 * that away for a file path, so nothing noticed until directories were derived
 * from the same strings and `.` came out as an ancestor of everything.
 */
const LEADING_DOT_SLASH_RE = /^\.\//

export type GlobOptions = {
  limit: number
  offset: number
  caseInsensitive?: boolean
  /** `find -maxdepth`: how far below the search root to walk. */
  maxDepth?: number
  sort?: GlobSort
  type?: GlobEntryType
  /** Paths to leave out, in glob form (`**\/node_modules\/**`). */
  exclude?: string[]
}

/**
 * The directories that contain the files ripgrep listed, and match `pattern`.
 *
 * `rg --files` cannot list a directory, and this fork ships no second walker —
 * so a directory is evidenced by a file inside it. What that misses is an EMPTY
 * directory, and one whose every file an ignore pattern removed; callers say so
 * in their result rather than presenting the listing as complete.
 *
 * ripgrep's globset cannot report WHICH segment matched, so the match is redone
 * here with picomatch against each ancestor. A pattern with no `/` is matched
 * against the segment name at any depth, which is how both `find -name` and
 * `rg --glob` read it; one with a `/` is anchored at the search root, as in
 * ripgrep.
 */
export function deriveDirectories(
  relativePaths: string[],
  pattern: string,
  { caseInsensitive, maxDepth }: { caseInsensitive?: boolean; maxDepth?: number },
): string[] {
  const isMatch = picomatch(pattern, { dot: true, nocase: caseInsensitive })
  const anchored = pattern.includes('/')
  const seen = new Set<string>()
  const directories: string[] = []
  for (const path of relativePaths) {
    const segments = path.replace(LEADING_DOT_SLASH_RE, '').split('/')
    segments.pop() // the file itself is not a directory
    for (let depth = 1; depth <= segments.length; depth++) {
      if (maxDepth !== undefined && depth > maxDepth) break
      const directory = segments.slice(0, depth).join('/')
      if (seen.has(directory)) continue
      seen.add(directory)
      const name = segments[depth - 1]!
      if (isMatch(directory) || (!anchored && isMatch(name))) {
        directories.push(directory)
      }
    }
  }
  return directories
}

export async function glob(
  filePattern: string,
  cwd: string,
  {
    limit,
    offset,
    caseInsensitive,
    maxDepth,
    sort = 'modified',
    type = 'file',
    exclude,
  }: GlobOptions,
  abortSignal: AbortSignal,
  toolPermissionContext: ToolPermissionContext,
): Promise<{
  files: string[]
  truncated: boolean
  incomplete: RipgrepIncompleteReason
}> {
  let searchDir = cwd
  let searchPattern = filePattern

  // Handle absolute paths by extracting the base directory and converting to relative pattern
  // ripgrep's --glob flag only works with relative patterns
  if (isAbsolute(filePattern)) {
    const { baseDir, relativePattern } = extractGlobBaseDirectory(filePattern)
    if (baseDir) {
      searchDir = baseDir
      searchPattern = relativePattern
    }
  }

  const ignorePatterns = normalizePatternsToPath(
    getFileReadIgnorePatterns(toolPermissionContext),
    searchDir,
  )

  // A directory is searched for by the files under it, so the glob handed to
  // ripgrep matches those files, and the depth allowance grows by the one level
  // that separates a directory from its contents.
  const walkPattern =
    type === 'dir'
      ? searchPattern.includes('/')
        ? `${searchPattern}/**`
        : `**/${searchPattern}/**`
      : searchPattern
  const walkDepth =
    maxDepth === undefined ? undefined : type === 'dir' ? maxDepth + 1 : maxDepth

  // Use ripgrep for better memory performance
  // --files: list files instead of searching content
  // --glob: filter by pattern
  // --iglob: the same filter matched case-insensitively. Only the CALLER's
  //   pattern switches — the exclusions appended below are ours and are already
  //   written in the case they occur in, so widening them would drop paths the
  //   caller asked for.
  // --sortr=modified: sort by modification time, NEWEST first. The caller caps
  //   the list (GlobTool keeps the first 100), so the cap has to keep the files
  //   most likely to matter — the same ranking GrepTool's files_with_matches
  //   mode applies. Plain --sort=modified is ascending, which made a truncated
  //   result the 100 LEAST recently modified matches.
  // --sort=path: name order, ASCENDING, which is the one ordering a caller can
  //   ask for instead. It is what `find … | sort` means, and unlike the mtime
  //   ranking it makes a truncated listing a stable prefix.
  // --max-depth: how far below the search root to walk. Equal to find's
  //   `-maxdepth` for files, since the root itself is a directory and never
  //   appears in `--files` output.
  // --no-ignore: don't respect .gitignore (default true, set CLAUDIN_GLOB_NO_IGNORE=false to respect .gitignore)
  // --hidden: include hidden files (default true, set CLAUDIN_GLOB_HIDDEN=false to exclude)
  // Note: use || instead of ?? to treat empty string as unset (defaulting to true)
  const noIgnore = isEnvTruthy(process.env.CLAUDIN_GLOB_NO_IGNORE || 'true')
  const hidden = isEnvTruthy(process.env.CLAUDIN_GLOB_HIDDEN || 'true')
  const args = [
    '--files',
    caseInsensitive ? '--iglob' : '--glob',
    walkPattern,
    ...(sort === 'path' ? ['--sort=path'] : ['--sortr=modified']),
    ...(walkDepth === undefined ? [] : ['--max-depth', String(walkDepth)]),
    ...(noIgnore ? ['--no-ignore'] : []),
    ...(hidden ? ['--hidden'] : []),
  ]

  // Caller exclusions go in before ours: both are negative globs and ripgrep
  // applies the last matching one, so the order only matters against a positive
  // glob, which these are not.
  for (const pattern of exclude ?? []) {
    args.push('--glob', `!${pattern}`)
  }

  // Add ignore patterns
  for (const pattern of ignorePatterns) {
    args.push('--glob', `!${pattern}`)
  }

  // Exclude orphaned plugin version directories
  for (const exclusion of await getGlobExclusionsForPluginCache(searchDir)) {
    args.push('--glob', exclusion)
  }

  // `truncated` is this function's own cap; `incomplete` is ripgrep giving up
  // partway through the walk. They are different facts, and a caller that
  // conflates them pages through a list that was never fully enumerated.
  const { lines: allPaths, incomplete } = await ripGrepWithStatus(
    args,
    searchDir,
    abortSignal,
  )

  if (type === 'dir') {
    // ripgrep is handed the search directory as its path argument, so it prints
    // absolute paths; the derivation counts depth from the search root and has
    // to see them the way the caller's pattern is written.
    const relativePaths = allPaths.map(p =>
      isAbsolute(p) ? relative(searchDir, p) : p,
    )
    // Derived from the walk's own order, so the mtime ranking carries over as
    // "the directory holding the most recently modified file first". Path order
    // is re-applied here because a parent and its child arrive interleaved.
    const directories = deriveDirectories(relativePaths, searchPattern, {
      caseInsensitive,
      maxDepth,
    })
    if (sort === 'path') directories.sort()
    const absoluteDirectories = directories.map(p =>
      isAbsolute(p) ? p : join(searchDir, p),
    )
    return {
      files: absoluteDirectories.slice(offset, offset + limit),
      truncated: absoluteDirectories.length > offset + limit,
      incomplete,
    }
  }

  // ripgrep returns relative paths, convert to absolute
  const absolutePaths = allPaths.map(p =>
    isAbsolute(p) ? p : join(searchDir, p),
  )

  const truncated = absolutePaths.length > offset + limit
  const files = absolutePaths.slice(offset, offset + limit)

  return { files, truncated, incomplete }
}
