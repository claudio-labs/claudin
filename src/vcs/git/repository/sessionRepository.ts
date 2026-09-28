import { getCwd } from 'src/shared/fs/cwd.js'
import { logError } from 'src/shared/log.js'
import {
  getCachedBranch,
  getCachedDefaultBranch,
  getCachedHead,
  getCachedRemoteUrl,
  resolveGitDir,
} from 'src/vcs/git/gitFilesystem.js'
import { getIsHeadOnRemote, readBranchIn } from 'src/vcs/git/repository/branches.js'
import { findGitRoot } from 'src/vcs/git/repository/gitRoot.js'
import { gitHubNameOf, parseGitRemote } from 'src/vcs/git/repository/remoteUrl.js'
import { getIsClean } from 'src/vcs/git/repository/workingTree.js'
import { getWorktreeCount } from 'src/vcs/git/repository/worktrees.js'

export type GitRepoState = {
  commitHash: string
  branchName: string
  remoteUrl: string | null
  isHeadOnRemote: boolean
  isClean: boolean
  worktreeCount: number
}

let sessionIsGit: Promise<boolean> | undefined

/**
 * Whether the session cwd lies in a repository, judged at the first call and
 * kept for the process even after the cwd moves; `getIsGit.cache.clear()`
 * makes the next call judge again, as a reroot does.
 */
export const getIsGit = Object.assign(
  (): Promise<boolean> => {
    sessionIsGit ??= Promise.resolve(findGitRoot(getCwd()) !== null)
    return sessionIsGit
  },
  {
    cache: {
      clear: (): void => {
        sessionIsGit = undefined
      },
    },
  },
)

// Head, branch, default branch and origin come from the one process-wide cache
// in gitFilesystem.ts, which follows commits, checkouts and remote changes
// without spawning git.

export function getHead(): Promise<string> {
  return getCachedHead()
}

/** Asks git in `cwd` when one is given; otherwise the session's cached branch. */
export function getBranch(cwd?: string): Promise<string> {
  return cwd ? readBranchIn(cwd) : getCachedBranch()
}

export function getDefaultBranch(): Promise<string> {
  return getCachedDefaultBranch()
}

export function getRemoteUrl(): Promise<string | null> {
  return getCachedRemoteUrl()
}

/** A checkout's `.git` directory, or the administrative directory a linked worktree's `.git` file names. */
export function getGitDir(cwd: string): Promise<string | null> {
  return resolveGitDir(cwd)
}

/** The six facts the feedback report carries, read concurrently; null if any read throws. */
export async function getGitState(): Promise<GitRepoState | null> {
  try {
    const [commitHash, branchName, remoteUrl, isHeadOnRemote, isClean, worktreeCount] =
      await Promise.all([
        getHead(),
        getBranch(),
        getRemoteUrl(),
        getIsHeadOnRemote(),
        getIsClean(),
        getWorktreeCount(),
      ])
    return { commitHash, branchName, remoteUrl, isHeadOnRemote, isClean, worktreeCount }
  } catch (error) {
    logError(error)
    return null
  }
}

/** `owner/name` when the session's origin is a github.com remote. */
export async function getGithubRepo(): Promise<string | null> {
  const remoteUrl = await getRemoteUrl()
  return remoteUrl === null ? null : gitHubNameOf(parseGitRemote(remoteUrl))
}
