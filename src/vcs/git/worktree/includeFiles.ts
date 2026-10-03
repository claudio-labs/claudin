/**
 * Populating a fresh worktree with the things git will not carry over:
 * gitignored files listed in `.worktreeinclude`, and symlinks for the big
 * directories (node_modules and friends) that would otherwise be duplicated.
 */

import { copyFile, mkdir, readFile, symlink } from 'fs/promises'
import { dirname, join } from 'path'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage, getErrnoCode } from 'src/shared/errors.js'
import { containsPathTraversal } from 'src/shared/fs/path.js'
import { git } from 'src/vcs/git/worktree/gitCommand.js'
import {
  isDirectoryEntry,
  isIncluded,
  readIncludeRules,
  shouldOpenDirectory,
  splitNulListing,
} from 'src/vcs/git/worktree/includeSelection.js'

const INCLUDE_FILE = '.worktreeinclude'

/** Untracked files that the standard exclude sources ignore, NUL-separated so no name is quoted. */
const IGNORED_UNTRACKED = ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']

export async function mkdirRecursive(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true })
}

export async function symlinkDirectories(
  repoRootPath: string,
  worktreePath: string,
  dirsToSymlink: string[],
): Promise<void> {
  for (const entry of dirsToSymlink) {
    if (containsPathTraversal(entry)) {
      logForDebugging(`worktree: not linking "${entry}", it climbs out of the repository`)
      continue
    }
    // join() keeps an absolute entry below the root: '/x' becomes <root>/x.
    const source = join(repoRootPath, entry)
    const link = join(worktreePath, entry)
    try {
      await symlink(source, link, 'dir')
    } catch (error) {
      // EEXIST: the checkout already has something there. ENOENT: its parent
      // is missing in the worktree. Either way the entry is left alone.
      logForDebugging(`worktree: not linking "${entry}" (${getErrnoCode(error) ?? errorMessage(error)})`)
    }
  }
}

async function readIncludeText(repoRoot: string): Promise<string | null> {
  try {
    return await readFile(join(repoRoot, INCLUDE_FILE), 'utf8')
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') {
      logForDebugging(`worktree: cannot read ${INCLUDE_FILE}: ${errorMessage(error)}`)
    }
    return null
  }
}

/** The relative paths to copy: git's own entries first, then what opened directories hold. */
async function chooseIncludedFiles(repoRoot: string, text: string): Promise<string[]> {
  const rules = readIncludeRules(text)
  if (rules.patterns.length === 0) return []

  const listed = await git(repoRoot, ...IGNORED_UNTRACKED, '--directory')
  if (!listed.ok) return []

  const chosen: string[] = []
  const toOpen: string[] = []
  for (const entry of splitNulListing(listed.stdout)) {
    if (!isDirectoryEntry(entry)) {
      if (isIncluded(rules, entry)) chosen.push(entry)
    } else if (shouldOpenDirectory(rules, entry)) {
      toOpen.push(entry)
    }
  }
  for (const dir of toOpen) {
    const inside = await git(repoRoot, '--literal-pathspecs', ...IGNORED_UNTRACKED, '--', dir)
    if (!inside.ok) continue
    chosen.push(...splitNulListing(inside.stdout).filter(path => isIncluded(rules, path)))
  }
  return chosen
}

async function copyOne(repoRoot: string, worktreePath: string, path: string): Promise<boolean> {
  const target = join(worktreePath, path)
  try {
    await mkdirRecursive(dirname(target))
    await copyFile(join(repoRoot, path), target)
    return true
  } catch (error) {
    logForDebugging(`worktree: could not copy ${path}: ${errorMessage(error)}`, { level: 'warn' })
    return false
  }
}

export async function copyWorktreeIncludeFiles(
  repoRoot: string,
  worktreePath: string,
): Promise<string[]> {
  const text = await readIncludeText(repoRoot)
  if (text === null) return []
  const copied: string[] = []
  for (const path of await chooseIncludedFiles(repoRoot, text)) {
    if (await copyOne(repoRoot, worktreePath, path)) copied.push(path)
  }
  return copied
}
