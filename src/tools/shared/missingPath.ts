/**
 * The "Did you mean …?" a tool appends when a path it was given does not exist.
 *
 * A missing path was the most common tool error of 2026-10..11 — Grep 37 and
 * Read 7 times, nearly all in sub-agents guessing where a file lives — and the
 * two hints there were fired on none of them: the guesses named an old layout
 * (`src/utils/frontmatterParser.ts`), a sibling directory
 * (`src/platform/shell/Shell.ts`) or a name cut short (`FileReadTool/batch.ts`).
 * The first of these that answers is the hint:
 *
 *  1. the same path under the cwd, when the cwd's own folder was dropped
 *     (`suggestPathUnderCwd`);
 *  2. the same name with another extension in the same directory
 *     (`findSimilarFile`, a bare file name);
 *  3. the entries of the same directory whose name starts with the missing
 *     stem (`batch.ts` → `batchRead.ts`), tests left out unless a test was
 *     asked for;
 *  4. the files or directories with the same name anywhere under the cwd,
 *     from `rg --files` (gitignore-aware, untracked included).
 *
 * 3 and 4 name at most three paths, and more than three is no guess at all.
 * Only a path under the cwd gets them, and a listing that fails or runs past
 * its budget gives no hint: a hint is worth one call, never a stall.
 *
 * A path the session's Read deny rules hide is never named: the listing
 * comes from the filesystem, not from what the session may read.
 */
import { readdir } from 'fs/promises'
import { basename, dirname, extname, join, sep } from 'path'
import { matchingRuleForInput } from 'src/permissions/filePermissions.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { findSimilarFile, suggestPathUnderCwd } from 'src/shared/fs/file.js'
import { ripGrep } from 'src/shared/fs/ripgrep.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

const MAX_GUESSES = 3
const LISTING_TIMEOUT_MS = 3_000
const TEST_FILE_RE = /\.(test|spec)\.[^.]+$/

/** Every file under `root`, absolute; [] when it cannot be listed in time. */
export type ListFiles = (root: string) => Promise<string[]>

async function listProjectFiles(root: string): Promise<string[]> {
  try {
    return await ripGrep(['--files', '--hidden', '--glob', '!.git/'], root, AbortSignal.timeout(LISTING_TIMEOUT_MS))
  } catch {
    return []
  }
}

async function siblingsStartingWith(fullPath: string): Promise<string[]> {
  const name = basename(fullPath)
  const stem = basename(name, extname(name))
  if (!stem) return []
  let entries: string[]
  try {
    entries = await readdir(dirname(fullPath))
  } catch {
    return []
  }
  const keepTests = TEST_FILE_RE.test(name)
  return entries
    .filter(entry => entry !== name && entry.startsWith(stem) && (keepTests || !TEST_FILE_RE.test(entry)))
    .sort()
    .map(entry => join(dirname(fullPath), entry))
}

async function sameNameUnder(cwd: string, fullPath: string, listFiles: ListFiles): Promise<string[]> {
  const name = basename(fullPath)
  const found = new Set<string>()
  for (const file of await listFiles(cwd)) {
    if (basename(file) === name) found.add(file)
    for (let dir = dirname(file); dir.startsWith(cwd + sep); dir = dirname(dir)) {
      if (basename(dir) === name) found.add(dir)
    }
  }
  return [...found].sort((a, b) => a.length - b.length || a.localeCompare(b))
}

function nameGuesses(paths: readonly string[]): string | undefined {
  if (paths.length === 0 || paths.length > MAX_GUESSES) return undefined
  if (paths.length === 1) return paths[0]
  return `${paths.slice(0, -1).join(', ')} or ${paths[paths.length - 1]}`
}

/** ` Did you mean <path>?` for a missing absolute path, or '' when nothing fits. */
export async function missingPathHint(
  fullPath: string,
  permissions: ToolPermissionContext,
  listFiles: ListFiles = listProjectFiles,
): Promise<string> {
  const readable = (path: string) => matchingRuleForInput(path, permissions, 'read', 'deny') === null
  const underCwd = await suggestPathUnderCwd(fullPath)
  const similar = findSimilarFile(fullPath)
  const guess =
    (underCwd && readable(underCwd) ? underCwd : undefined) ??
    (similar && readable(join(dirname(fullPath), similar)) ? similar : undefined) ??
    (await likelyPaths(fullPath, listFiles, readable))
  return guess ? ` Did you mean ${guess}?` : ''
}

async function likelyPaths(
  fullPath: string,
  listFiles: ListFiles,
  readable: (path: string) => boolean,
): Promise<string | undefined> {
  const cwd = getCwd()
  if (!fullPath.startsWith(cwd + sep)) return undefined
  const siblings = (await siblingsStartingWith(fullPath)).filter(readable)
  if (siblings.length > 0) return nameGuesses(siblings)
  return nameGuesses((await sameNameUnder(cwd, fullPath, listFiles)).filter(readable))
}
