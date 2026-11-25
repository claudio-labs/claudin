/**
 * ExitWorktree's own logic, apart from the tool so it is testable without a
 * worktree: what a `remove` result says it removed.
 */
import type { WorktreeCleanup } from 'src/vcs/git/worktree.js'

/**
 * The first sentence of a `remove` result. It names only what is gone: a
 * worktree a hook made is removed by a WorktreeRemove hook or not at all,
 * and a branch git refuses to delete stays.
 */
export function describeRemoval({
  worktreePath,
  worktreeBranch,
  hookBased,
  cleanup,
}: {
  worktreePath: string
  worktreeBranch?: string
  hookBased?: boolean
  cleanup: WorktreeCleanup
}): string {
  if (!cleanup.removed) {
    const why = hookBased
      ? 'a hook made this worktree, and no WorktreeRemove hook is configured to remove it'
      : `git could not remove it${cleanup.removeError ? ` (${cleanup.removeError})` : ''}`
    return `Exited the worktree, but ${worktreePath} is still on disk: ${why}.`
  }
  if (cleanup.branch === 'deleted') {
    return `Exited and removed worktree at ${worktreePath} and deleted its branch ${worktreeBranch}.`
  }
  if (cleanup.branch === 'refused') {
    return `Exited and removed worktree at ${worktreePath}. Git refused to delete branch ${worktreeBranch}, so it is still there${cleanup.branchError ? `: ${cleanup.branchError}` : '.'}`
  }
  const hookNote = hookBased ? ' A hook made it, so any branch it has was left to the hook.' : ''
  return `Exited and removed worktree at ${worktreePath}.${hookNote}`
}
