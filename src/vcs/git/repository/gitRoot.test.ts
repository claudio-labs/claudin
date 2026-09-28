import { describe, expect, test } from 'bun:test'
import { resolve } from 'path'
import type { EntryKind } from 'src/vcs/git/repository/entryKind.js'
import { climbToGitRoot } from 'src/vcs/git/repository/gitRoot.js'

function fakeDisk(entries: Record<string, EntryKind>): {
  probe: (path: string) => EntryKind
  asked: string[]
} {
  const asked: string[] = []
  return {
    asked,
    probe: path => {
      asked.push(path)
      return entries[path] ?? 'missing'
    },
  }
}

describe('climbToGitRoot', () => {
  test('climbs one directory at a time and examines the filesystem root last', () => {
    const disk = fakeDisk({ '/.git': 'directory' })
    expect(climbToGitRoot('/srv/app/src', disk.probe)).toBe('/')
    expect(disk.asked).toEqual(['/srv/app/src/.git', '/srv/app/.git', '/srv/.git', '/.git'])
  })

  test('a .git that is neither a directory nor a regular file does not stop the climb', () => {
    const disk = fakeDisk({ '/srv/app/.git': 'other', '/srv/.git': 'file' })
    expect(climbToGitRoot('/srv/app', disk.probe)).toBe('/srv')
  })

  test('null when nothing up to the filesystem root holds .git', () => {
    expect(climbToGitRoot('/a/b', fakeDisk({}).probe)).toBeNull()
  })

  test('a relative start is resolved against the process working directory', () => {
    const here = process.cwd()
    const disk = fakeDisk({ [resolve(here, '.git')]: 'directory' })
    expect(climbToGitRoot('nested/dir', disk.probe)).toBe(here.normalize('NFC'))
  })
})
