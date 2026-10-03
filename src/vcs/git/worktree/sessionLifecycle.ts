/**
 * Entering, leaving and sweeping worktrees — everything that reads or clears
 * the session recorded by createWorktree.
 *
 * The session binding itself lives in session.ts; this module only reaches it
 * through getCurrentWorktreeSession/restoreWorktreeSession, which is what keeps
 * the "which tree am I in" answer single-valued on the removal path.
 */

import { readdir, realpath, stat } from 'fs/promises'
import { basename, join, resolve } from 'path'
import { executeWorktreeRemoveHook } from 'src/platform/lifecycleHooks/hooks.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { findCanonicalGitRoot, findGitRoot, getBranch } from 'src/vcs/git/git.js'
import { removeAgentWorktree } from 'src/vcs/git/worktree/createWorktree.js'
import { complaintOf, git } from 'src/vcs/git/worktree/gitCommand.js'
import {
  getCurrentWorktreeSession,
  restoreWorktreeSession,
  type WorktreeSession,
} from 'src/vcs/git/worktree/session.js'
import {
  worktreeBranchName,
  worktreesDir,
} from 'src/vcs/git/worktree/slugNaming.js'
import { isThrowawayName } from 'src/vcs/git/worktree/throwawayNames.js'
import { parseWorktreeList, type ListedWorktree } from 'src/vcs/git/worktree/worktreeList.js'

/**
 * Normalize a path for comparison, resolving symlinks when the path exists.
 * Falls back to the raw path if realpath fails (e.g. path doesn't exist).
 */
async function normalizePath(p: string): Promise<string> {
  try {
    return await realpath(p)
  } catch {
    return p
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function notRegistered(path: string): Error {
  return new Error(
    `${path} is not a registered worktree of this repository. ` +
      'Create one with `git worktree add`, or pass EnterWorktree a `name` to make a fresh one.',
  )
}

/** The listed worktree at `resolvedPath` and whether it is the main one, or null. */
async function findListed(
  listed: readonly ListedWorktree[],
  resolvedPath: string,
): Promise<{ worktree: ListedWorktree; isMain: boolean } | null> {
  for (const [index, worktree] of listed.entries()) {
    if ((await normalizePath(worktree.path)) === resolvedPath) return { worktree, isMain: index === 0 }
  }
  return null
}

/**
 * Enter a PRE-EXISTING git worktree (e.g. one created by `git worktree add`)
 * instead of creating a new one. The path must be a registered worktree of the
 * current repository (it must appear in `git worktree list`); the main worktree
 * itself is rejected. The resulting session is marked `attached: true` so
 * ExitWorktree never removes it.
 */
export async function attachExistingWorktree(
  path: string,
  sessionId: string,
): Promise<WorktreeSession> {
  const originalCwd = getCwd()
  if (findGitRoot(originalCwd) === null) {
    throw new Error('Cannot attach to a worktree: not in a git repository')
  }
  const listing = await git(originalCwd, 'worktree', 'list', '--porcelain', '-z')
  if (!listing.ok) throw new Error(`Cannot list the worktrees of this repository: ${complaintOf(listing)}`)

  const resolvedPath = await normalizePath(resolve(path))
  const found = await findListed(parseWorktreeList(listing.stdout), resolvedPath)
  // A registration whose directory is gone cannot be entered either.
  if (found === null || !(await isDirectory(resolvedPath))) throw notRegistered(path)
  if (found.isMain) {
    throw new Error(`${path} is the main worktree of this repository, not a linked one; it cannot be attached.`)
  }

  const session: WorktreeSession = {
    originalCwd,
    worktreePath: resolvedPath,
    worktreeName: basename(resolvedPath),
    worktreeBranch: found.worktree.branch ?? undefined,
    originalBranch: await getBranch(),
    originalHeadCommit: found.worktree.head ?? undefined,
    sessionId,
    hookBased: false,
    attached: true,
  }
  restoreWorktreeSession(session)
  return session
}

/** Moves the process back where the session came from; false when that directory is gone. */
function returnToOriginalDirectory(session: WorktreeSession): boolean {
  try {
    process.chdir(session.originalCwd)
    return true
  } catch (error) {
    logForDebugging(`worktree: cannot return to ${session.originalCwd}: ${errorMessage(error)}`, { level: 'warn' })
    return false
  }
}

export async function keepWorktree(): Promise<void> {
  const session = getCurrentWorktreeSession()
  if (session === null || !returnToOriginalDirectory(session)) return
  restoreWorktreeSession(null)
}

async function removeSessionWorktree(session: WorktreeSession): Promise<void> {
  if (session.hookBased) {
    try {
      await executeWorktreeRemoveHook(session.worktreePath)
    } catch (error) {
      logForDebugging(`worktree: WorktreeRemove hook failed: ${errorMessage(error)}`, { level: 'warn' })
    }
    return
  }
  const removed = await git(session.originalCwd, 'worktree', 'remove', '--force', session.worktreePath)
  if (!removed.ok) logForDebugging(`worktree: could not remove ${session.worktreePath}: ${complaintOf(removed)}`)
}

export async function cleanupWorktree(): Promise<void> {
  const session = getCurrentWorktreeSession()
  if (session === null || !returnToOriginalDirectory(session)) return
  await removeSessionWorktree(session)
  restoreWorktreeSession(null)
  // Removing means discarding, so the branch goes even if the removal failed.
  if (!session.hookBased && session.worktreeBranch) {
    const deleted = await git(session.originalCwd, 'branch', '-D', session.worktreeBranch)
    if (!deleted.ok) logForDebugging(`worktree: kept branch ${session.worktreeBranch}: ${complaintOf(deleted)}`)
  }
}

/** Whether a throwaway worktree may go: old, clean in tracked files, nothing unpushed. */
async function isAbandoned(path: string, cutoffDate: Date): Promise<boolean> {
  try {
    if ((await stat(path)).mtime.getTime() >= cutoffDate.getTime()) return false
  } catch {
    return false
  }
  // A plain directory would answer for whatever repository encloses it.
  const top = await git(path, 'rev-parse', '--show-toplevel')
  if (!top.ok || (await normalizePath(top.stdout.trim())) !== (await normalizePath(path))) return false
  const status = await git(path, 'status', '--porcelain', '--untracked-files=no')
  if (!status.ok || status.stdout.trim() !== '') return false
  const unpushed = await git(path, 'rev-list', '--max-count=1', 'HEAD', '--not', '--remotes')
  return unpushed.ok && unpushed.stdout.trim() === ''
}

export async function cleanupStaleAgentWorktrees(
  cutoffDate: Date,
): Promise<number> {
  const repoRoot = findCanonicalGitRoot(getCwd())
  if (repoRoot === null) return 0
  const dir = worktreesDir(repoRoot)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }

  const current = getCurrentWorktreeSession()?.worktreePath
  let removed = 0
  for (const name of names.filter(isThrowawayName)) {
    const path = join(dir, name)
    if (path === current || !(await isAbandoned(path, cutoffDate))) continue
    if (await removeAgentWorktree(path, worktreeBranchName(name), repoRoot)) removed += 1
  }
  if (removed > 0) {
    const pruned = await git(repoRoot, 'worktree', 'prune')
    if (!pruned.ok) logForDebugging(`worktree: prune failed: ${complaintOf(pruned)}`)
  }
  return removed
}

/** Fail-closed: anything git cannot answer counts as a change. */
export async function hasWorktreeChanges(
  worktreePath: string,
  headCommit: string,
): Promise<boolean> {
  const status = await git(worktreePath, 'status', '--porcelain')
  if (!status.ok || status.stdout.trim() !== '') return true
  const ahead = await git(worktreePath, 'rev-list', '--count', `${headCommit}..HEAD`)
  if (!ahead.ok) return true
  return Number.parseInt(ahead.stdout.trim(), 10) !== 0
}
