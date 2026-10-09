import { isMemoryFileType, isMemoryIndex } from 'src/memory/memdir/memoryScopes.js'
import { describe, expect, test } from 'bun:test'
import { findMemoryDir, promptRoots } from 'src/memory/memdir/memoryDirs.js'
import { testMemoryDirs } from 'src/memory/memdir/__testutils__/memoryDirs.js'

// findMemoryDir is the one answer to "is this a memory, and whose?" — the
// permission carve-outs, the format guard and the forks' tool gate all ask it
// through memoryScopeOf. Pinned here on directories of the test's own.
const DIRS = testMemoryDirs({
  private: '/repo/.claudin/memory',
  team: '/repo/.claudin/memory/team',
  global: '/home/u/.claudin/memory',
})
const scopeOf = (path: string) => findMemoryDir(DIRS, path)?.scope ?? null

describe('findMemoryDir', () => {
  test('a file in each directory is in that directory', () => {
    expect(scopeOf('/home/u/.claudin/memory/user-lang.md')).toBe('global')
    expect(scopeOf('/repo/.claudin/memory/feedback-x.md')).toBe('private')
    expect(scopeOf('/repo/.claudin/memory/team/decisions/x.md')).toBe('team')
  })

  test('team beats private: the deepest root wins, whatever the list order', () => {
    expect(scopeOf('/repo/.claudin/memory/team/x.md')).toBe('team')
    expect(findMemoryDir([...DIRS].reverse(), '/repo/.claudin/memory/team/x.md')?.scope).toBe('team')
  })

  test('a `..` traversal is judged where it lands, not where it starts', () => {
    expect(scopeOf('/repo/.claudin/memory/team/../feedback-x.md')).toBe('private')
    expect(scopeOf('/repo/.claudin/memory/team/../../settings.json')).toBeNull()
    expect(scopeOf('/repo/.claudin/memory/../../src/index.ts')).toBeNull()
    expect(scopeOf('/home/u/.claudin/memory/../settings.json')).toBeNull()
    // and one that starts outside and lands inside is in
    expect(scopeOf('/repo/src/../.claudin/memory/team/x.md')).toBe('team')
  })

  test('a sibling sharing a prefix of the root is not inside it', () => {
    expect(scopeOf('/repo/.claudin/memory-old/x.md')).toBeNull()
    expect(scopeOf('/repo/.claudin/memory/team-notes.md')).toBe('private')
  })

  test('the root itself, without its separator, is not a file in it', () => {
    expect(scopeOf('/repo/.claudin/memory')).toBeNull()
  })

  test('no directories, no memory', () => {
    expect(findMemoryDir([], '/repo/.claudin/memory/x.md')).toBeNull()
  })
})

describe('promptRoots', () => {
  test('names each root without its trailing separator', () => {
    expect(promptRoots(DIRS)).toEqual({
      global: '/home/u/.claudin/memory',
      private: '/repo/.claudin/memory',
      team: '/repo/.claudin/memory/team',
    })
  })

  test('global is null while it is off', () => {
    const off = testMemoryDirs({ private: '/repo/.claudin/memory', team: '/repo/.claudin/memory/team' })
    expect(promptRoots(off).global).toBeNull()
  })
})

describe('isMemoryIndex — the index, not every file of the directory', () => {
  test('a MEMORY.md of a memory type is an index; a path-scoped memory of the same type is not', () => {
    expect(isMemoryIndex({ type: 'TeamMem', path: '/repo/.claudin/memory/team/MEMORY.md' })).toBe(true)
    expect(isMemoryIndex({ type: 'TeamMem', path: '/repo/.claudin/memory/team/bugs/x.md' })).toBe(false)
    expect(isMemoryIndex({ type: 'Project', path: '/repo/MEMORY.md' })).toBe(false)
    expect(isMemoryFileType('TeamMem')).toBe(true)
  })
})
