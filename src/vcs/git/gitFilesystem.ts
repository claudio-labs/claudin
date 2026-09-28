/**
 * Answers about a git repository read straight from its .git directory,
 * without starting git. The parts live in ./gitFilesystem/; this file wires
 * them to the disk, to the session's working directory and to shutdown.
 */
import { waitForScrollIdle } from 'src/platform/bootstrap/state.js'
import { registerCleanup } from 'src/shared/cleanupRegistry.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { findGitRoot } from 'src/vcs/git/git.js'
import { createFilePoller } from 'src/vcs/git/gitFilesystem/filePoller.js'
import {
  createGitDirLocator,
  type GitDirLocator,
  readCommonDir,
  readGitFile,
} from 'src/vcs/git/gitFilesystem/gitDir.js'
import { diskGitFiles, fileStamp } from 'src/vcs/git/gitFilesystem/gitFiles.js'
import { headCommit, resolveHead } from 'src/vcs/git/gitFilesystem/head.js'
import { FALLBACK_DEFAULT_BRANCH, readOriginUrl } from 'src/vcs/git/gitFilesystem/origin.js'
import { filesRefStore, resolveRefToId } from 'src/vcs/git/gitFilesystem/refStore.js'
import {
  createRepoStateCache,
  NO_BRANCH,
  NO_COMMIT,
  type RepoStateCache,
  type RepoValues,
} from 'src/vcs/git/gitFilesystem/repoState.js'
import { countWorktrees } from 'src/vcs/git/gitFilesystem/worktreeCount.js'

const REMEMBERED_START_PATHS = 100
const WATCHED_REPOSITORIES = 8

type Wiring = { gitDirs: GitDirLocator; repositories: RepoStateCache }

let wiring: Wiring | undefined

/**
 * Built on first use rather than at import. This module and git.ts import
 * each other, so at import time some of the modules below may not have run.
 */
function wired(): Wiring {
  wiring ??= {
    gitDirs: createGitDirLocator({
      files: diskGitFiles,
      findRoot: startPath => findGitRoot(startPath),
      defaultStart: () => getCwd(),
      maxRemembered: REMEMBERED_START_PATHS,
    }),
    repositories: createRepoStateCache({
      files: diskGitFiles,
      // Tests wait for the cache to notice changes, so they poll faster.
      watchFile: createFilePoller(process.env.NODE_ENV === 'test' ? 10 : 1000, fileStamp),
      waitForScrollIdle: () => waitForScrollIdle(),
      registerCleanup: cleanup => registerCleanup(cleanup),
      maxRepositories: WATCHED_REPOSITORIES,
    }),
  }
  return wiring
}

/**
 * The git directory of the repository holding `startPath`, by default the
 * session's working directory. Answers are remembered per start path, a null
 * among them, until clearResolveGitDirCache().
 */
export function resolveGitDir(startPath?: string): Promise<string | null> {
  return wired().gitDirs.locate(startPath)
}

export function clearResolveGitDirCache(): void {
  wired().gitDirs.forget()
}

/** Where a linked worktree's shared refs and config live; null for any other repository. */
export function getCommonDir(gitDir: string): Promise<string | null> {
  return readCommonDir(gitDir, diskGitFiles)
}

/** `ref` is trusted: callers pass constants or names that passed the ref-name rule. */
export function resolveRef(gitDir: string, ref: string): Promise<string | null> {
  return resolveRefToId(filesRefStore(gitDir, diskGitFiles), ref)
}

/** The commit HEAD stands on, for the repository holding `cwd`. */
export async function getHeadForDir(cwd: string): Promise<string | null> {
  const gitDir = await resolveGitDir(cwd)
  return gitDir === null ? null : headCommit(await resolveHead(gitDir, diskGitFiles))
}

/** HEAD of the worktree whose `.git` file sits in `worktreePath`. No walking up, no memory. */
export async function readWorktreeHeadSha(worktreePath: string): Promise<string | null> {
  const gitDir = await readGitFile(worktreePath, diskGitFiles)
  return gitDir === null ? null : headCommit(await resolveHead(gitDir, diskGitFiles))
}

export async function getRemoteUrlForDir(cwd: string): Promise<string | null> {
  const gitDir = await resolveGitDir(cwd)
  if (gitDir === null) return null
  return readOriginUrl(gitDir, await getCommonDir(gitDir), diskGitFiles)
}

/** The repository of the working directory at this call, runWithCwdOverride included. */
async function repositoryOfCwd(): Promise<RepoValues | null> {
  const gitDir = await resolveGitDir()
  return gitDir === null ? null : wired().repositories.valuesFor(gitDir)
}

export async function getCachedBranch(): Promise<string> {
  const repository = await repositoryOfCwd()
  return repository === null ? NO_BRANCH : repository.branch()
}

export async function getCachedHead(): Promise<string> {
  const repository = await repositoryOfCwd()
  return repository === null ? NO_COMMIT : repository.head()
}

export async function getCachedRemoteUrl(): Promise<string | null> {
  const repository = await repositoryOfCwd()
  return repository === null ? null : repository.remoteUrl()
}

export async function getCachedDefaultBranch(): Promise<string> {
  const repository = await repositoryOfCwd()
  return repository === null ? FALLBACK_DEFAULT_BRANCH : repository.defaultBranch()
}

/** 0 outside a repository. */
export async function getWorktreeCountFromFs(): Promise<number> {
  const gitDir = await resolveGitDir()
  return gitDir === null ? 0 : countWorktrees(gitDir, diskGitFiles)
}
