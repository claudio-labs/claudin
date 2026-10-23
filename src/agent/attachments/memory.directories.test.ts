import { describe, expect, test } from 'bun:test'
import { getDirectoriesToProcess } from 'src/agent/attachments/memory.js'

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
