import { existsSync } from 'fs'
import { join } from 'path'
import { getCwd } from 'src/shared/fs/cwd.js'
import { findGitRoot, getGitDir } from 'src/vcs/git/git.js'

/** Left in a git directory while a merge, rebase, cherry-pick or revert waits for the user. */
const STOPPED_OPERATION_FILES = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'] as const

/**
 * The top-level directory of the repository around `root`, or around the
 * session's current directory when no root is given, or null outside any.
 * Asked at every call: the session may have moved since the last one.
 */
export function repositoryRoot(root?: string): string | null {
  return findGitRoot(root ?? getCwd())
}

/**
 * Whether an operation is stopped half-way, judged by the repository's own
 * git directory, which for a linked worktree is the worktree's. A git
 * directory that cannot be found stops nothing.
 */
export async function hasStoppedOperation(root: string): Promise<boolean> {
  const gitDir = await getGitDir(root)
  if (gitDir === null) return false
  return STOPPED_OPERATION_FILES.some(name => existsSync(join(gitDir, name)))
}
