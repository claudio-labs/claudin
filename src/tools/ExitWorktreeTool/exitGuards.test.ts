import { describe, expect, test } from 'bun:test'
import { describeRemoval } from 'src/tools/ExitWorktreeTool/exitGuards.js'

const PATH = '/repo/.claudin/worktrees/feat'

describe('describeRemoval', () => {
  test('worktree and branch removed', () => {
    expect(
      describeRemoval({ worktreePath: PATH, worktreeBranch: 'worktree-feat', cleanup: { removed: true, branch: 'deleted' } }),
    ).toBe(`Exited and removed worktree at ${PATH} and deleted its branch worktree-feat.`)
  })

  test('git refused the branch delete: the branch is named as kept, with git\'s reason', () => {
    expect(
      describeRemoval({
        worktreePath: PATH,
        worktreeBranch: 'main',
        cleanup: { removed: true, branch: 'refused', branchError: "error: Cannot delete branch 'main'" },
      }),
    ).toBe(
      `Exited and removed worktree at ${PATH}. Git refused to delete branch main, so it is still there: error: Cannot delete branch 'main'`,
    )
    expect(
      describeRemoval({ worktreePath: PATH, worktreeBranch: 'main', cleanup: { removed: true, branch: 'refused' } }),
    ).toEndWith('so it is still there.')
  })

  test('a hook removed its own worktree: the branch is the hook\'s business', () => {
    expect(describeRemoval({ worktreePath: PATH, hookBased: true, cleanup: { removed: true, branch: 'none' } })).toBe(
      `Exited and removed worktree at ${PATH}. A hook made it, so any branch it has was left to the hook.`,
    )
  })

  test('a git worktree with no branch recorded says only what was removed', () => {
    expect(describeRemoval({ worktreePath: PATH, cleanup: { removed: true, branch: 'none' } })).toBe(
      `Exited and removed worktree at ${PATH}.`,
    )
  })

  test('nothing removed: a hook-made worktree with no WorktreeRemove hook', () => {
    expect(describeRemoval({ worktreePath: PATH, hookBased: true, cleanup: { removed: false, branch: 'none' } })).toBe(
      `Exited the worktree, but ${PATH} is still on disk: a hook made this worktree, and no WorktreeRemove hook is configured to remove it.`,
    )
  })

  test('nothing removed: git could not remove it, with or without a reason', () => {
    expect(
      describeRemoval({ worktreePath: PATH, cleanup: { removed: false, removeError: 'fatal: locked', branch: 'none' } }),
    ).toBe(`Exited the worktree, but ${PATH} is still on disk: git could not remove it (fatal: locked).`)
    expect(describeRemoval({ worktreePath: PATH, cleanup: { removed: false, branch: 'none' } })).toBe(
      `Exited the worktree, but ${PATH} is still on disk: git could not remove it.`,
    )
  })
})
