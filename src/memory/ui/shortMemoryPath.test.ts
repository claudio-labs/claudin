import { describe, expect, test } from 'bun:test'

import { isPathWithin, shortenMemoryPath } from 'src/memory/ui/shortMemoryPath.js'

describe('shortenMemoryPath', () => {
  const cases: Array<{ name: string; cwd: string; home: string; path: string; shown: string }> = [
    // Fix: a bare prefix test showed these as `~ser2/x` and `./../project/x`.
    { name: 'a sibling of home that shares its prefix', cwd: '/srv', home: '/home/u', path: '/home/user2/x', shown: '/home/user2/x' },
    { name: 'a sibling of the working directory that shares its prefix', cwd: '/a/pro', home: '/home/u', path: '/a/project/x', shown: '/a/project/x' },
    { name: 'the working directory itself', cwd: '/a/pro', home: '/home/u', path: '/a/pro', shown: './' },
    { name: 'the home directory itself', cwd: '/srv', home: '/home/u', path: '/home/u', shown: '~' },
    { name: 'a home with a trailing separator', cwd: '/srv', home: '/home/u/', path: '/home/u/notes.md', shown: '~/notes.md' },
    { name: 'under both, the working directory shorter', cwd: '/home/u/w/app', home: '/home/u', path: '/home/u/w/app/A.md', shown: './A.md' },
    { name: 'under both, a tie goes to home', cwd: '/home/u', home: '/home/u', path: '/home/u/A.md', shown: '~/A.md' },
    { name: 'under both, home shorter', cwd: '/', home: '/home/u', path: '/home/u/A.md', shown: '~/A.md' },
  ]
  for (const { name, cwd, home, path, shown } of cases) {
    test(name, () => {
      expect(shortenMemoryPath(path, { cwd, home })).toBe(shown)
    })
  }
})

describe('isPathWithin', () => {
  const cases: Array<[string, string, boolean]> = [
    ['/a', '/a', true],
    ['/a', '/a/b', true],
    ['/a/', '/a/b', true],
    ['/a', '/ab', false],
    ['/a/b', '/a', false],
    ['/', '/x', true],
  ]
  for (const [dir, path, within] of cases) {
    test(`${path} in ${dir}: ${within}`, () => {
      expect(isPathWithin(dir, path)).toBe(within)
    })
  }
})
