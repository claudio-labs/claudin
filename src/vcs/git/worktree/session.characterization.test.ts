/**
 * Characterization of the process-wide "current worktree session", pinned for
 * the clean-base rewrite (docs/tech/rewrite/vcs/worktree.md), and of the
 * barrel every caller imports the unit through.
 *
 * Which operations publish or clear the session is pinned where they are
 * driven: the creation and lifecycle suites.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import * as barrel from 'src/vcs/git/worktree.js'
import {
  getCurrentWorktreeSession,
  restoreWorktreeSession,
  type WorktreeSession,
} from 'src/vcs/git/worktree.js'

afterEach(() => {
  restoreWorktreeSession(null)
})

const created: WorktreeSession = {
  originalCwd: '/work/app',
  worktreePath: '/work/app/.claudin/worktrees/docs',
  worktreeName: 'docs',
  worktreeBranch: 'worktree-docs',
  originalBranch: 'main',
  originalHeadCommit: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00',
  sessionId: 'session-created',
  tmuxSessionName: 'app_worktree-docs',
  creationDurationMs: 12,
  usedSparsePaths: false,
}

const attached: WorktreeSession = {
  originalCwd: '/work/app',
  worktreePath: '/elsewhere/checkout',
  worktreeName: 'checkout',
  sessionId: 'session-attached',
  hookBased: false,
  attached: true,
}

describe('the current worktree session', () => {
  test('is null once cleared', () => {
    restoreWorktreeSession(null)
    expect(getCurrentWorktreeSession()).toBeNull()
  })

  test('hands back the very object that was published', () => {
    for (const session of [created, attached]) {
      restoreWorktreeSession(session)
      expect(getCurrentWorktreeSession()).toBe(session)
    }
  })

  test('the last publication wins, and clearing ends it', () => {
    restoreWorktreeSession(created)
    restoreWorktreeSession(attached)
    expect(getCurrentWorktreeSession()?.sessionId).toBe('session-attached')
    restoreWorktreeSession(null)
    expect(getCurrentWorktreeSession()).toBeNull()
  })

  test('is shared by every import of the barrel', async () => {
    const again = await import('src/vcs/git/worktree.js')
    restoreWorktreeSession(created)
    expect(again.getCurrentWorktreeSession()).toBe(created)
  })

  test('is stored as given, not copied or validated', () => {
    const partial = { worktreePath: '', originalCwd: '', worktreeName: '', sessionId: '' }
    restoreWorktreeSession(partial)
    expect(getCurrentWorktreeSession()).toBe(partial)
  })
})

describe('the barrel src/vcs/git/worktree.ts', () => {
  const contract = [
    'createAgentWorktree',
    'createWorktreeForSession',
    'parsePRReference',
    'removeAgentWorktree',
    'copyWorktreeIncludeFiles',
    '_resetGitWorktreeMutationLocksForTesting',
    'withGitWorktreeMutationLock',
    'getCurrentWorktreeSession',
    'restoreWorktreeSession',
    'attachExistingWorktree',
    'cleanupStaleAgentWorktrees',
    'cleanupWorktree',
    'hasWorktreeChanges',
    'keepWorktree',
    'validateWorktreeSlug',
    'worktreeBranchName',
    'createTmuxSessionForWorktree',
    'execIntoTmuxWorktree',
    'generateTmuxSessionName',
    'getTmuxInstallInstructions',
    'isTmuxAvailable',
    'killTmuxSession',
  ]

  for (const name of contract) {
    test(`exports ${name} as a function`, () => {
      expect(typeof (barrel as Record<string, unknown>)[name]).toBe('function')
    })
  }
})
