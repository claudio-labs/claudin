import { findGitRoot } from 'src/vcs/git/git.js'

/** A `.git` directory or file (a worktree) in `cwd` or above it; runs no git. */
export function projectIsInGitRepo(cwd: string): boolean {
  return findGitRoot(cwd) !== null
}
