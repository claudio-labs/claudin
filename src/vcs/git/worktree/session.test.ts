import { afterEach, expect, test } from 'bun:test'

import { getWorktreeEnteredAt, restoreWorktreeSession } from 'src/vcs/git/worktree.js'

afterEach(() => restoreWorktreeSession(null))

// ExitWorktree reads it to tell the tasks that may run in the worktree.
test('the entered-at stamp: set on entering, kept when the same worktree is set again, cleared on leaving', async () => {
  const session = { originalCwd: '/o', worktreePath: '/tmp/stamp-wt', worktreeName: 'w', sessionId: 's' }
  const before = Date.now()
  restoreWorktreeSession(session)
  const entered = getWorktreeEnteredAt()
  expect(entered).toBeGreaterThanOrEqual(before)
  await new Promise(r => setTimeout(r, 5))
  restoreWorktreeSession({ ...session, tmuxSessionName: 'tmux-1' })
  expect(getWorktreeEnteredAt()).toBe(entered)
  restoreWorktreeSession({ ...session, worktreePath: '/tmp/stamp-other' })
  expect(getWorktreeEnteredAt()).toBeGreaterThan(entered)
  restoreWorktreeSession(null)
  expect(getWorktreeEnteredAt()).toBe(0)
})
