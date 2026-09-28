/**
 * Characterization of what happens right after a worktree is first created,
 * pinned for the clean-base rewrite (docs/tech/rewrite/vcs/worktree.md):
 * local settings are carried over, git hooks are pointed at the main
 * repository, configured directories are linked, and `.worktreeinclude` is
 * applied. None of it happens when an existing worktree is resumed.
 *
 * Driven through the creation entry points, against real repositories.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync } from 'fs'
import { join } from 'path'

import { openWorktreeLab, type WorktreeLab } from 'src/vcs/git/__testutils__/worktreeLab.js'
import { createAgentWorktree, createWorktreeForSession } from 'src/vcs/git/worktree.js'

let lab: WorktreeLab

beforeEach(() => {
  lab = openWorktreeLab()
})

afterEach(() => {
  lab.close()
})

const LOCAL_SETTINGS = '{\n  "env": { "API_TOKEN": "local-only" }\n}\n'

function hooksPathOf(repo: string): string | null {
  const outcome = lab.git.attempt(repo, 'config', '--get', 'core.hooksPath')
  return outcome.ok ? outcome.stdout : null
}

type Entry = 'absent' | 'file' | 'dir' | `link:${string}`

function entryAt(path: string): Entry {
  try {
    const stats = lstatSync(path)
    if (stats.isSymbolicLink()) return `link:${readlinkSync(path)}`
    return stats.isDirectory() ? 'dir' : 'file'
  } catch {
    return 'absent'
  }
}

describe('local settings', () => {
  test('.claudin/settings.local.json is copied into the new worktree byte for byte', async () => {
    const repo = lab.git.repo('local-settings')
    lab.git.put(repo, '.claudin/settings.local.json', LOCAL_SETTINGS)
    for (const create of [
      () => createAgentWorktree('agent-copy'),
      () => createWorktreeForSession('s-copy', 'session-copy'),
    ]) {
      const made = await lab.inSession(repo, create)
      expect(readFileSync(join(made.worktreePath, '.claudin', 'settings.local.json'), 'utf8')).toBe(
        LOCAL_SETTINGS,
      )
    }
  })

  test('without one, the worktree gets none and creation succeeds', async () => {
    const repo = lab.git.repo('no-local-settings')
    const made = await lab.inSession(repo, () => createAgentWorktree('bare'))
    expect(existsSync(join(made.worktreePath, '.claudin', 'settings.local.json'))).toBe(false)
    expect(existsSync(join(made.worktreePath, 'notes.txt'))).toBe(true)
  })

  test('a settings file that cannot be copied does not stop creation', async () => {
    const repo = lab.git.repo('odd-local-settings')
    mkdirSync(join(repo, '.claudin', 'settings.local.json'), { recursive: true })
    const made = await lab.inSession(repo, () => createAgentWorktree('odd'))
    expect(existsSync(join(made.worktreePath, 'notes.txt'))).toBe(true)
  })
})

describe('git hooks', () => {
  test('the shared config points core.hooksPath at the main .git/hooks', async () => {
    const repo = lab.git.repo('hooks-default')
    expect(hooksPathOf(repo)).toBeNull()
    const made = await lab.inSession(repo, () => createAgentWorktree('hooked'))
    expect(hooksPathOf(repo)).toBe(join(repo, '.git', 'hooks'))
    expect(hooksPathOf(made.worktreePath)).toBe(join(repo, '.git', 'hooks'))
  })

  test('a .husky directory is preferred', async () => {
    const repo = lab.git.repo('hooks-husky')
    mkdirSync(join(repo, '.husky'))
    await lab.inSession(repo, () => createAgentWorktree('husky'))
    expect(hooksPathOf(repo)).toBe(join(repo, '.husky'))
  })

  test('a .husky that is not a directory is passed over', async () => {
    const repo = lab.git.repo('hooks-husky-file')
    lab.git.put(repo, '.husky', 'not a directory\n')
    await lab.inSession(repo, () => createAgentWorktree('husky-file'))
    expect(hooksPathOf(repo)).toBe(join(repo, '.git', 'hooks'))
  })

  test('a relative hooks path naming the chosen directory is made absolute', async () => {
    const repo = lab.git.repo('hooks-relative')
    mkdirSync(join(repo, '.husky'))
    lab.git.run(repo, 'config', 'core.hooksPath', '.husky')
    await lab.inSession(repo, () => createAgentWorktree('relative'))
    expect(hooksPathOf(repo)).toBe(join(repo, '.husky'))
  })

  test('with neither .husky nor .git/hooks the setting is left alone', async () => {
    const repo = lab.git.repo('hooks-none')
    rmSync(join(repo, '.git', 'hooks'), { recursive: true, force: true })
    await lab.inSession(repo, () => createAgentWorktree('unhooked'))
    expect(hooksPathOf(repo)).toBeNull()
  })
})

describe('linked directories', () => {
  test('settings.worktree.symlinkDirectories links each entry from the main checkout', async () => {
    const repo = lab.git.repo('links')
    lab.git.put(repo, 'node_modules/pkg/index.js', 'module\n')
    lab.git.put(repo, 'cache/deep/blob', 'blob\n')
    lab.writeSettings({
      worktree: {
        symlinkDirectories: ['node_modules', 'not-there-yet', 'cache/deep', '../escape', '/rooted', 'notes.txt'],
      },
    })
    const made = await lab.inSession(repo, () => createAgentWorktree('linked'))
    const tree = made.worktreePath
    const expected: Array<[string, Entry, string]> = [
      ['node_modules', `link:${join(repo, 'node_modules')}`, 'an existing directory is linked'],
      ['not-there-yet', `link:${join(repo, 'not-there-yet')}`, 'a missing source still gets a link'],
      ['cache', 'absent', 'no link when the parent is missing in the worktree'],
      ['rooted', `link:${join(repo, 'rooted')}`, 'an absolute entry is taken below the repository'],
      ['notes.txt', 'file', 'an existing entry in the worktree is kept'],
      ['../escape', 'absent', 'an entry that climbs out is skipped'],
    ]
    for (const [name, entry, why] of expected) {
      expect({ name, why, entry: entryAt(join(tree, name)) }).toEqual({ name, why, entry })
    }
    expect(readFileSync(join(tree, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('module\n')
  })

  test('nothing is linked unless configured', async () => {
    const repo = lab.git.repo('no-links')
    lab.git.put(repo, 'node_modules/pkg/index.js', 'module\n')
    const made = await lab.inSession(repo, () => createAgentWorktree('unlinked'))
    expect(entryAt(join(made.worktreePath, 'node_modules'))).toBe('absent')
  })
})

describe('.worktreeinclude', () => {
  test('its files are copied into a new worktree', async () => {
    const repo = lab.git.repo('include')
    lab.git.put(repo, '.gitignore', '.env\n')
    lab.git.run(repo, 'add', '.gitignore')
    lab.git.run(repo, 'commit', '-q', '-m', 'ignore')
    lab.git.put(repo, '.env', 'SECRET=1\n')
    lab.git.put(repo, '.worktreeinclude', '.env\n')
    const made = await lab.inSession(repo, () => createAgentWorktree('included'))
    expect(readFileSync(join(made.worktreePath, '.env'), 'utf8')).toBe('SECRET=1\n')
  })
})

describe('resuming', () => {
  test('none of the setup runs again for an existing worktree', async () => {
    const repo = lab.git.repo('resume-setup')
    lab.git.put(repo, '.claudin/settings.local.json', LOCAL_SETTINGS)
    lab.git.put(repo, 'node_modules/pkg/index.js', 'module\n')
    lab.writeSettings({ worktree: { symlinkDirectories: ['node_modules'] } })
    const made = await lab.inSession(repo, () => createWorktreeForSession('s-first', 'resumed'))
    rmSync(join(made.worktreePath, '.claudin'), { recursive: true, force: true })
    rmSync(join(made.worktreePath, 'node_modules'))
    lab.git.run(repo, 'config', '--unset', 'core.hooksPath')
    const hooksDirBefore = statSync(join(repo, '.git', 'hooks')).isDirectory()
    const resumers: Array<() => Promise<unknown>> = [
      () => createWorktreeForSession('s-again', 'resumed'),
      () => createAgentWorktree('resumed'),
    ]
    for (const resume of resumers) {
      await lab.inSession(repo, resume)
    }
    expect(hooksDirBefore).toBe(true)
    expect(existsSync(join(made.worktreePath, '.claudin'))).toBe(false)
    expect(entryAt(join(made.worktreePath, 'node_modules'))).toBe('absent')
    expect(hooksPathOf(repo)).toBeNull()
  })
})
