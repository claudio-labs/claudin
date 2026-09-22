/**
 * Path-scoped memories — the on-demand half of the memory directory.
 *
 * Only `MEMORY.md` (the index) is in context every session. A memory file
 * whose frontmatter carries `paths:` — the same key, syntax and semantics as a
 * rule in `.claudin/rules/` (ruleFrontmatter.ts) — is attached the first time
 * a Read touches a file matching one of its globs, through the same
 * `nested_memory` pipeline the rules use (src/agent/attachments/memory.ts). A
 * memory without `paths:` stays index-only; the model reaches it by following
 * the index link. That is the one difference from rules, where no `paths:`
 * means always-on.
 *
 * The globs' base directory follows the rule convention verbatim
 * (claudemd/nestedDirectories.ts): a project-local memdir
 * (`<root>/.claudin/memory/`) matches relative to the directory containing
 * `.claudin/`, exactly like the project's own rules; any other memdir location
 * (the legacy global path, a settings override) matches relative to the
 * original cwd, like Managed/User rules.
 *
 * The `{path, globs}` index is memoized per process and re-read only when the
 * mtime of a directory walked by the last scan changes — a Write, rm or
 * `git mv` inside the memdir bumps its parent's mtime, so the invalidation is
 * automatic and needs no hook into clearMemoryFileCaches. The cost per Read is
 * one stat per memory directory (five or six), not one open per memory file.
 * Known limit: editing the `paths:` of an EXISTING file in place leaves its
 * directory's mtime alone, so that change is picked up by the next scan
 * trigger (any other write in the directory, or a new process), not
 * immediately.
 *
 * Matched files go through processMemoryFile, so they get the same
 * frontmatter strip, `contentDiffersFromDisk` bookkeeping and read-gate cache
 * entry as a rule — and the AutoMem/TeamMem entrypoint cap (200 lines / 25 KB,
 * memdir.ts) as a bound on what one Read can pull in.
 */

import { feature } from 'bun:bundle'
import { readdir, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'path'
import ignore from 'ignore'
import { readFileInRange } from 'src/shared/fs/readFileInRange.js'
import { inspectRuleFrontmatter } from 'src/memory/instructions/ruleFrontmatter.js'
import { processMemoryFile } from 'src/memory/instructions/claudemd/processing.js'
import type { MemoryFileInfo } from 'src/memory/instructions/claudemd/types.js'
import type { MemoryType } from 'src/memory/memdir/types.js'
import { getAutoMemPath, isAutoMemoryEnabled } from 'src/memory/memdir/paths.js'
import { isTeamMemPath } from 'src/memory/memdir/teamMemPaths.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'

export type PathScopedEntry = {
  path: string
  globs: string[]
}

/** The filesystem surface the index scan touches — injectable for tests. */
export type PathScopedScanFs = {
  readdir(dir: string): Promise<
    { name: string; isFile(): boolean; isDirectory(): boolean }[]
  >
  /** The head of a memory file — enough lines to hold its frontmatter. */
  readHead(filePath: string): Promise<string>
  dirMtimeMs(dir: string): Promise<number>
}

// Same bounds as scanMemoryFiles (memoryScan.ts): frontmatter lives in the
// first lines, and three levels covers `team/<category>/`.
const FRONTMATTER_MAX_LINES = 30
const MAX_DEPTH = 3
const ENTRYPOINT_NAME = 'MEMORY.md'
const CLAUDIN_DIR_NAME = '.claudin'
const TRAILING_SEP_RE = /[/\\]+$/

export const defaultPathScopedScanFs: PathScopedScanFs = {
  readdir: dir => readdir(dir, { withFileTypes: true }),
  readHead: async filePath =>
    (await readFileInRange(filePath, 0, FRONTMATTER_MAX_LINES)).content,
  dirMtimeMs: async dir => (await stat(dir)).mtimeMs,
}

type IndexCache = {
  memoryDir: string
  dirMtimes: Map<string, number>
  entries: PathScopedEntry[]
}

let cache: IndexCache | null = null

/** Test hook: forget the memoized index. */
export function resetPathScopedMemoryCache(): void {
  cache = null
}

/**
 * Where a memory's `paths:` globs are anchored. `.claudin/memory/` under a
 * project root anchors at that root, like the project's rules; anywhere else
 * anchors at the original cwd, like Managed/User rules.
 */
export function resolveGlobBaseDir(
  memoryDir: string,
  originalCwd: string,
): string {
  const root = memoryDir.replace(TRAILING_SEP_RE, '')
  const parent = dirname(root)
  return basename(parent) === CLAUDIN_DIR_NAME ? dirname(parent) : originalCwd
}

/**
 * The same match a conditional rule gets (nestedDirectories.ts): the target
 * is made relative to the base dir, and a path that escapes it, is empty, or
 * stays absolute can never match a base-relative glob.
 */
export function matchesPathScope(
  globs: string[],
  baseDir: string,
  targetPath: string,
): boolean {
  const relativePath = isAbsolute(targetPath)
    ? relative(baseDir, targetPath)
    : targetPath
  if (
    !relativePath ||
    relativePath.startsWith('..') ||
    isAbsolute(relativePath)
  ) {
    return false
  }
  return ignore().add(globs).ignores(relativePath)
}

async function walk(
  dir: string,
  depth: number,
  fs: PathScopedScanFs,
  dirMtimes: Map<string, number>,
  entries: PathScopedEntry[],
): Promise<void> {
  let dirents: Awaited<ReturnType<PathScopedScanFs['readdir']>>
  try {
    dirMtimes.set(dir, await fs.dirMtimeMs(dir))
    dirents = await fs.readdir(dir)
  } catch {
    // A missing or unreadable directory holds no memories. A subdirectory
    // that appears later bumps its parent's mtime, which IS in the map, so
    // the next Read rescans; a missing root has no parent here and is
    // handled by the caller, which does not cache an empty map.
    return
  }

  for (const dirent of dirents) {
    const entryPath = join(dir, dirent.name)
    if (dirent.isDirectory()) {
      if (depth + 1 < MAX_DEPTH) {
        await walk(entryPath, depth + 1, fs, dirMtimes, entries)
      }
      continue
    }
    if (
      !dirent.isFile() ||
      !dirent.name.endsWith('.md') ||
      dirent.name === ENTRYPOINT_NAME
    ) {
      continue
    }
    let head: string
    try {
      head = await fs.readHead(entryPath)
    } catch {
      continue
    }
    const { paths } = inspectRuleFrontmatter(head)
    if (paths !== undefined) {
      entries.push({ path: entryPath, globs: paths })
    }
  }
}

async function isCacheFresh(
  cached: IndexCache,
  fs: PathScopedScanFs,
): Promise<boolean> {
  for (const [dir, mtimeMs] of cached.dirMtimes) {
    try {
      if ((await fs.dirMtimeMs(dir)) !== mtimeMs) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * The `{path, globs}` index of the memory directory, memoized until a walked
 * directory's mtime changes. Files without `paths:` are not in it.
 */
export async function getPathScopedIndex(
  memoryDir: string,
  fs: PathScopedScanFs = defaultPathScopedScanFs,
): Promise<PathScopedEntry[]> {
  if (
    cache !== null &&
    cache.memoryDir === memoryDir &&
    (await isCacheFresh(cache, fs))
  ) {
    return cache.entries
  }
  const dirMtimes = new Map<string, number>()
  const entries: PathScopedEntry[] = []
  await walk(memoryDir.replace(TRAILING_SEP_RE, ''), 0, fs, dirMtimes, entries)
  // A root that could not be stat'ed leaves the map empty, and an empty map
  // is vacuously fresh — caching it would pin "no memories" for the rest of
  // the process. Left uncached, the next Read re-stats the root (one stat)
  // and picks the directory up once it exists.
  cache = dirMtimes.size === 0 ? null : { memoryDir, dirMtimes, entries }
  return entries
}

/**
 * Memory files whose `paths:` match `targetPath`, fully read and ready for
 * memoryFilesToAttachments. `processedPaths` is the caller's dedupe set, the
 * same one the rule loaders share within a trigger.
 */
export async function findPathScopedMemoryFiles(options: {
  targetPath: string
  memoryDir: string
  originalCwd: string
  processedPaths: Set<string>
  fs?: PathScopedScanFs
}): Promise<MemoryFileInfo[]> {
  const { targetPath, memoryDir, originalCwd, processedPaths } = options
  const entries = await getPathScopedIndex(memoryDir, options.fs)
  if (entries.length === 0) return []

  const baseDir = resolveGlobBaseDir(memoryDir, originalCwd)
  const result: MemoryFileInfo[] = []
  for (const entry of entries) {
    if (!matchesPathScope(entry.globs, baseDir, targetPath)) continue
    const type: MemoryType =
      feature('TEAMMEM') && isTeamMemPath(entry.path) ? 'TeamMem' : 'AutoMem'
    result.push(
      ...(await processMemoryFile(entry.path, type, processedPaths, false)),
    )
  }
  return result
}

/** The production entry point: the session's memdir and original cwd. */
export async function getPathScopedMemoryFiles(
  targetPath: string,
  processedPaths: Set<string>,
): Promise<MemoryFileInfo[]> {
  if (!isAutoMemoryEnabled()) return []
  return findPathScopedMemoryFiles({
    targetPath,
    memoryDir: getAutoMemPath(),
    originalCwd: getOriginalCwd(),
    processedPaths,
  })
}
