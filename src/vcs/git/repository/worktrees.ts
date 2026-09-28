import { runGit } from 'src/vcs/git/repository/runGit.js'
import { currentWorktreeFirst, parseWorktreeList } from 'src/vcs/git/repository/worktreeList.js'

const LIST_WORKTREES = ['worktree', 'list', '--porcelain'] as const

/**
 * The main working tree plus every linked worktree registered with the
 * session cwd's repository, read when called; a registered worktree whose
 * directory is gone counts until it is pruned. Zero outside a repository.
 */
export async function getWorktreeCount(): Promise<number> {
  const listed = await runGit(LIST_WORKTREES, { cwd: 'session' })
  return listed.ok ? parseWorktreeList(listed.stdout).length : 0
}

/** Every working tree of the repository holding `cwd`, that tree first; empty outside a repository or on failure. */
export async function getWorktreePaths(cwd: string): Promise<string[]> {
  const listed = await runGit(LIST_WORKTREES, { cwd: { dir: cwd } })
  return listed.ok ? currentWorktreeFirst(parseWorktreeList(listed.stdout), cwd) : []
}
