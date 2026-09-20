/**
 * Git worktrees: creation, attachment, cleanup and the tmux integration.
 *
 * This file is a BARREL — the implementation lives in worktree/: slugNaming
 * (the slug allowlist and the name/path mapping), session (the ONE
 * `currentWorktreeSession` binding, reached only through its accessors),
 * mutationLock (the per-repo `git worktree add/remove` lock), includeFiles
 * (.worktreeinclude copies and the symlinks), postCreationSetup, createWorktree
 * (the git core plus the session- and agent-scoped wrappers), sessionLifecycle
 * (attach, keep, cleanup, the stale sweep) and tmuxSession. Edit the sibling,
 * not this file.
 *
 * Two consumers — `resumeSession.test.ts` and `useReplExit.test.tsx` —
 * `mock.module` this specifier to stub `getCurrentWorktreeSession`. That keeps
 * working because the modules under test import from HERE; no sibling may
 * import this barrel, which would both be a cycle and put a sibling behind
 * those mocks.
 */

export {
  createAgentWorktree,
  createWorktreeForSession,
  parsePRReference,
  removeAgentWorktree,
} from 'src/vcs/git/worktree/createWorktree.js'
export { copyWorktreeIncludeFiles } from 'src/vcs/git/worktree/includeFiles.js'
export {
  _resetGitWorktreeMutationLocksForTesting,
  withGitWorktreeMutationLock,
} from 'src/vcs/git/worktree/mutationLock.js'
export {
  getCurrentWorktreeSession,
  restoreWorktreeSession,
  type WorktreeSession,
} from 'src/vcs/git/worktree/session.js'
export {
  attachExistingWorktree,
  cleanupStaleAgentWorktrees,
  cleanupWorktree,
  hasWorktreeChanges,
  keepWorktree,
} from 'src/vcs/git/worktree/sessionLifecycle.js'
export {
  validateWorktreeSlug,
  worktreeBranchName,
} from 'src/vcs/git/worktree/slugNaming.js'
export {
  createTmuxSessionForWorktree,
  execIntoTmuxWorktree,
  generateTmuxSessionName,
  getTmuxInstallInstructions,
  isTmuxAvailable,
  killTmuxSession,
} from 'src/vcs/git/worktree/tmuxSession.js'
