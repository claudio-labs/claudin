import { realpath } from 'fs/promises'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { logForDebugging } from 'src/shared/debug.js'
import { pathExists, reportUnexpectedFsError } from 'src/vcs/git/repository/entryKind.js'
import { findGitRoot } from 'src/vcs/git/repository/gitRoot.js'
import {
  pathsUnder,
  recordCurrentClone,
  type RepoPathStore,
  withoutPath,
} from 'src/vcs/git/repository/knownClones.js'
import { toGitHubName } from 'src/vcs/git/repository/remoteUrl.js'
import { detectCurrentRepository } from 'src/vcs/git/repository/repositoryDetection.js'
import { runGit } from 'src/vcs/git/repository/runGit.js'

// `githubRepoPaths` in the global config.
const globalConfigStore: RepoPathStore = {
  read: () => getGlobalConfig().githubRepoPaths,
  write: next => saveGlobalConfig(current => ({ ...current, githubRepoPaths: next })),
}

/** Remembers where the session's GitHub repository is cloned. Fire-and-forget: it never rejects. */
export function updateGithubRepoPathMapping(): Promise<void> {
  return recordCurrentClone({
    detectRepository: () => detectCurrentRepository(),
    launchDirectory: () => getOriginalCwd(),
    repositoryRootOf: path => findGitRoot(path),
    resolvePath: resolveRecordedPath,
    store: globalConfigStore,
    log: message => logForDebugging(message),
  })
}

/** A path as it is recorded: symlinks resolved and NFC, or as given when it does not resolve. */
export async function resolveRecordedPath(path: string): Promise<string> {
  try {
    return (await realpath(path)).normalize('NFC')
  } catch (error) {
    reportUnexpectedFsError(path, error)
    return path
  }
}

export function getKnownPathsForRepo(repo: string): string[] {
  return pathsUnder(globalConfigStore.read(), repo)
}

/** The paths that exist, following symlinks, with order and repeats kept. */
export async function filterExistingPaths(paths: string[]): Promise<string[]> {
  const present = await Promise.all(paths.map(path => pathExists(path)))
  return paths.filter((_, index) => present[index])
}

/**
 * Whether the repository holding `path` has an origin naming `expectedRepo`
 * on github.com, in any letter case. A linked worktree answers with the origin
 * it shares; any failure is false.
 */
export async function validateRepoAtPath(path: string, expectedRepo: string): Promise<boolean> {
  const origin = await runGit(['remote', 'get-url', 'origin'], { cwd: { dir: path } })
  const actual = origin.ok ? toGitHubName(origin.stdout.trim()) : null
  return actual !== null && actual.toLowerCase() === expectedRepo.toLowerCase()
}

export function removePathFromRepo(repo: string, pathToRemove: string): void {
  const next = withoutPath(globalConfigStore.read(), repo, pathToRemove)
  if (next !== null) globalConfigStore.write(next)
}
