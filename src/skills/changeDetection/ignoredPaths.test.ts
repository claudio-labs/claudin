import { describe, expect, test } from 'bun:test'
import { join } from 'path'

import { type EntryKind, isIgnoredPath } from 'src/skills/changeDetection/ignoredPaths.js'

const root = join('/', 'home', 'me', '.claudin', 'skills')

function kind(special: keyof EntryKind | undefined): EntryKind {
  return {
    isFIFO: () => special === 'isFIFO',
    isSocket: () => special === 'isSocket',
    isBlockDevice: () => special === 'isBlockDevice',
    isCharacterDevice: () => special === 'isCharacterDevice',
  }
}

describe('isIgnoredPath', () => {
  test('anything with a .git segment is ignored; a name that only starts with .git is not', () => {
    expect(isIgnoredPath(join(root, '.git'))).toBe(true)
    expect(isIgnoredPath(join(root, 'vendored', '.git', 'config'))).toBe(true)
    expect(isIgnoredPath(join(root, 'submodule', '.git'), kind(undefined))).toBe(true)
    expect(isIgnoredPath(join(root, '.gitignore'))).toBe(false)
    expect(isIgnoredPath(join(root, '.github', 'workflows', 'ci.yml'))).toBe(false)
  })

  test('editor temporaries are ignored by name', () => {
    for (const name of ['SKILL.md~', '.SKILL.md.swp', '.SKILL.md.swx', '.subl3f2a.tmp']) {
      expect({ name, ignored: isIgnoredPath(join(root, name)) }).toEqual({ name, ignored: true })
    }
    for (const name of ['SKILL.md', 'notes.swp', '.hidden.md', 'sublime.tmp']) {
      expect({ name, ignored: isIgnoredPath(join(root, name)) }).toEqual({ name, ignored: false })
    }
  })

  test('special files are ignored once their stats are known; regular files, directories and symlinks are not', () => {
    const pipe = join(root, 'pipe')
    for (const special of ['isFIFO', 'isSocket', 'isBlockDevice', 'isCharacterDevice'] as const) {
      expect({ special, ignored: isIgnoredPath(pipe, kind(special)) }).toEqual({ special, ignored: true })
    }
    expect(isIgnoredPath(pipe)).toBe(false)
    expect(isIgnoredPath(join(root, 'linked-skill'), kind(undefined))).toBe(false)
  })
})
