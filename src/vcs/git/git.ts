/**
 * The git layer the CLI leans on: repository roots and identities, the
 * session's repository, and the commands that read or tidy a working tree.
 *
 * A facade over repository/, where each concern has its own module. Suites
 * mock.module this path, so nothing in repository/ imports it: a module
 * behind the mock would see the stub.
 */

export {
  dedupeCanonicalRoots,
  findCanonicalGitRoot,
  resolveWorkspaceRoots,
} from 'src/vcs/git/repository/canonicalRoot.js'
export { dirIsInGitRepo, findGitRoot } from 'src/vcs/git/repository/gitRoot.js'
export { findNestedGitRoots } from 'src/vcs/git/repository/nestedRoots.js'
export { gitExe } from 'src/vcs/git/repository/gitExecutable.js'
export { isCurrentDirectoryBareGitRepo } from 'src/vcs/git/repository/bareRepository.js'
export {
  findRemoteBase,
  getAheadBehind,
  getIsHeadOnRemote,
} from 'src/vcs/git/repository/branches.js'
export type { GitFileStatus } from 'src/vcs/git/repository/statusPorcelain.js'
export {
  getFileStatus,
  getIsClean,
  stashToCleanState,
} from 'src/vcs/git/repository/workingTree.js'
export { getWorktreeCount } from 'src/vcs/git/repository/worktrees.js'
export type { GitRepoState } from 'src/vcs/git/repository/sessionRepository.js'
export {
  getBranch,
  getDefaultBranch,
  getGitDir,
  getGitState,
  getGithubRepo,
  getHead,
  getIsGit,
  getRemoteUrl,
} from 'src/vcs/git/repository/sessionRepository.js'
