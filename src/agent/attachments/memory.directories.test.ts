import { describe, expect, test } from 'bun:test'
import { getDirectoriesToProcess, mainCheckoutCounterpart } from 'src/agent/attachments/memory.js'

describe('getDirectoriesToProcess', () => {
  test('lists the directories between the cwd and the target, outermost first', () => {
    const { nestedDirs, cwdLevelDirs } = getDirectoriesToProcess('/work/app/src/a/x.ts', '/work/app')
    expect(nestedDirs).toEqual(['/work/app/src', '/work/app/src/a'])
    expect(cwdLevelDirs).toEqual(['/work', '/work/app'])
  })

  test('a target directly in the cwd has no nested directories', () => {
    expect(getDirectoriesToProcess('/work/app/x.ts', '/work/app').nestedDirs).toEqual([])
  })

  test('a sibling directory that shares the cwd as a name prefix is not nested', () => {
    expect(getDirectoriesToProcess('/work/app-backend/src/x.ts', '/work/app').nestedDirs).toEqual([])
  })
})

describe('mainCheckoutCounterpart', () => {
  test('maps a worktree path to its main-checkout counterpart', () => {
    expect(mainCheckoutCounterpart('/work/app/.claudin/worktrees/feat/AGENTS.md', '/work/app')).toBe('/work/app/AGENTS.md')
    expect(mainCheckoutCounterpart('/work/app/.claudin/worktrees/user+feat/.claudin/rules/a.md', '/work/app')).toBe(
      '/work/app/.claudin/rules/a.md',
    )
  })

  test('a path outside a worktree has no counterpart', () => {
    expect(mainCheckoutCounterpart('/work/app/AGENTS.md', '/work/app')).toBeNull()
    expect(mainCheckoutCounterpart('/work/app/.claudin/rules/a.md', '/work/app')).toBeNull()
    // Another project's worktree, and a sibling that shares the directory's name as a prefix.
    expect(mainCheckoutCounterpart('/work/other/.claudin/worktrees/feat/AGENTS.md', '/work/app')).toBeNull()
    expect(mainCheckoutCounterpart('/work/app/.claudin/worktrees-old/feat/AGENTS.md', '/work/app')).toBeNull()
    // The worktree's root is a directory, not a file inside it.
    expect(mainCheckoutCounterpart('/work/app/.claudin/worktrees/feat', '/work/app')).toBeNull()
    expect(mainCheckoutCounterpart('/work/app/.claudin/worktrees/feat/', '/work/app')).toBeNull()
  })
})
