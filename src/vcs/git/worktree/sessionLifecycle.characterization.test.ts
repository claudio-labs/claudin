/**
 * Characterization of entering, leaving and sweeping worktrees, pinned for the
 * clean-base rewrite (docs/tech/rewrite/vcs/worktree.md): attaching to an
 * existing worktree, keeping or removing the session's worktree, the sweep of
 * leaked throwaway worktrees, and the "has anything changed" check.
 *
 * Real repositories and real linked worktrees throughout. keep and cleanup
 * move the process working directory; the lab puts it back after each test.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'

import {
  localBranches,
  openWorktreeLab,
  recordingHook,
  registeredWorktrees,
  type WorktreeLab,
} from 'src/vcs/git/__testutils__/worktreeLab.js'
import {
  attachExistingWorktree,
  cleanupStaleAgentWorktrees,
  cleanupWorktree,
  createWorktreeForSession,
  getCurrentWorktreeSession,
  hasWorktreeChanges,
  keepWorktree,
  restoreWorktreeSession,
  type WorktreeSession,
} from 'src/vcs/git/worktree.js'

let lab: WorktreeLab

beforeEach(() => {
  lab = openWorktreeLab()
})

afterEach(() => {
  lab.close()
})

/** A linked worktree made by git itself, outside `.claudin/worktrees`. */
function linkedWorktree(repo: string, branch: string | null): string {
  const path = join(lab.git.tempDir('linked'), 'checkout')
  if (branch === null) lab.git.run(repo, 'worktree', 'add', '-q', '--detach', path)
  else lab.git.run(repo, 'worktree', 'add', '-q', '-b', branch, path)
  return path
}

async function rejection(action: () => Promise<unknown>): Promise<string> {
  try {
    await action()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected a rejection')
}

describe('attachExistingWorktree', () => {
  test('enters a registered linked worktree and marks the session attached', async () => {
    const { clone } = lab.upstream('attach')
    const tree = linkedWorktree(clone, 'topic')
    const head = lab.git.commit(tree, 'work on topic')
    const processDir = process.cwd()
    const session = await lab.inSession(clone, () => attachExistingWorktree(tree, 's-attach'))
    expect(session).toEqual({
      originalCwd: clone,
      worktreePath: tree,
      worktreeName: 'checkout',
      worktreeBranch: 'topic',
      originalBranch: 'main',
      originalHeadCommit: head,
      sessionId: 's-attach',
      hookBased: false,
      attached: true,
    })
    expect(getCurrentWorktreeSession()).toBe(session)
    expect(process.cwd()).toBe(processDir)
    expect(registeredWorktrees(lab.git, clone)).toEqual([clone, tree])
  })

  test('a detached worktree is entered with no branch', async () => {
    const { clone, base } = lab.upstream('attach-detached')
    const tree = linkedWorktree(clone, null)
    const session = await lab.inSession(clone, () => attachExistingWorktree(tree, 's-det'))
    expect(session.worktreeBranch).toBeUndefined()
    expect(session.originalHeadCommit).toBe(base)
  })

  test('a path through a symlink is resolved to the worktree itself', async () => {
    const { clone } = lab.upstream('attach-link')
    const tree = linkedWorktree(clone, 'linked-topic')
    const alias = join(lab.git.tempDir('alias'), 'shortcut')
    symlinkSync(tree, alias)
    const session = await lab.inSession(clone, () => attachExistingWorktree(alias, 's-link'))
    expect(session.worktreePath).toBe(tree)
    expect(session.worktreeName).toBe(basename(tree))
  })

  test('a relative path is read from the process working directory', async () => {
    const { clone } = lab.upstream('attach-relative')
    const tree = linkedWorktree(clone, 'relative-topic')
    process.chdir(dirname(tree))
    const session = await lab.inSession(clone, () => attachExistingWorktree(basename(tree), 's-rel'))
    expect(session.worktreePath).toBe(tree)
  })

  test('works from inside another linked worktree of the same repository', async () => {
    const { clone } = lab.upstream('attach-sibling')
    const here = linkedWorktree(clone, 'here')
    const there = linkedWorktree(clone, 'there')
    const session = await lab.inSession(here, () => attachExistingWorktree(there, 's-sib'))
    expect(session.originalCwd).toBe(here)
    expect(session.worktreeBranch).toBe('there')
    expect(session.originalBranch).toBe('here')
  })

  test('refuses what is not a linked worktree of this repository, publishing nothing', async () => {
    const { clone } = lab.upstream('attach-refuse')
    const other = lab.upstream('attach-other')
    const foreign = linkedWorktree(other.clone, 'foreign')
    const mainAlias = join(lab.git.tempDir('main-alias'), 'main')
    symlinkSync(clone, mainAlias)
    const plain = lab.git.tempDir('plain')
    const cases: Array<[string, string, string[]]> = [
      ['a plain directory', plain, ['not a registered worktree', 'git worktree add', 'name']],
      ['a missing path', join(plain, 'missing'), ['not a registered worktree']],
      ["another repository's worktree", foreign, ['not a registered worktree']],
      ['the main worktree', clone, ['main worktree']],
      ['the main worktree through a symlink', mainAlias, ['main worktree']],
    ]
    for (const [label, path, facts] of cases) {
      const message = await rejection(() =>
        lab.inSession(clone, () => attachExistingWorktree(path, `s-${label}`)),
      )
      expect({ label, starts: message.startsWith(path) }).toEqual({ label, starts: true })
      for (const fact of facts) expect({ label, message }).toEqual({ label, message: expect.stringContaining(fact) })
    }
    expect(getCurrentWorktreeSession()).toBeNull()
  })

  test('refuses outside a git repository', async () => {
    const message = await rejection(() =>
      lab.inSession(lab.anchor, () => attachExistingWorktree('/anything', 's-nogit')),
    )
    expect(message).toContain('not in a git repository')
  })
})

describe('keepWorktree', () => {
  test('goes back to the original directory and forgets the session, keeping the worktree', async () => {
    const { clone } = lab.upstream('keep')
    const session = await lab.inSession(clone, () => createWorktreeForSession('s-keep', 'kept'))
    process.chdir(session.worktreePath)
    await keepWorktree()
    expect(process.cwd()).toBe(clone)
    expect(getCurrentWorktreeSession()).toBeNull()
    expect(registeredWorktrees(lab.git, clone)).toEqual([clone, session.worktreePath])
    expect(localBranches(lab.git, clone)).toEqual(['main', 'worktree-kept'])
  })

  test('does nothing without a session', async () => {
    const processDir = process.cwd()
    await keepWorktree()
    expect(process.cwd()).toBe(processDir)
    expect(getCurrentWorktreeSession()).toBeNull()
  })

  test('when the original directory is gone it gives up quietly and keeps the session', async () => {
    const vanished = join(lab.git.tempDir('vanished'), 'was-here')
    const session: WorktreeSession = {
      originalCwd: vanished,
      worktreePath: lab.anchor,
      worktreeName: 'x',
      sessionId: 's-vanished',
    }
    restoreWorktreeSession(session)
    const processDir = process.cwd()
    await keepWorktree()
    expect(process.cwd()).toBe(processDir)
    expect(getCurrentWorktreeSession()).toBe(session)
  })
})

describe('cleanupWorktree', () => {
  test('removes a dirty worktree and its branch, and goes back to the original directory', async () => {
    const { clone } = lab.upstream('cleanup')
    const session = await lab.inSession(clone, () => createWorktreeForSession('s-clean', 'doomed'))
    writeFileSync(join(session.worktreePath, 'notes.txt'), 'edited\n')
    writeFileSync(join(session.worktreePath, 'fresh.txt'), 'untracked\n')
    process.chdir(session.worktreePath)
    await lab.inSession(lab.anchor, () => cleanupWorktree())
    expect(process.cwd()).toBe(clone)
    expect(getCurrentWorktreeSession()).toBeNull()
    expect(existsSync(session.worktreePath)).toBe(false)
    expect(registeredWorktrees(lab.git, clone)).toEqual([clone])
    expect(localBranches(lab.git, clone)).toEqual(['main'])
  })

  test('a session without a branch removes the worktree and deletes no branch', async () => {
    const { clone } = lab.upstream('cleanup-nobranch')
    const tree = linkedWorktree(clone, 'survivor')
    restoreWorktreeSession({ originalCwd: clone, worktreePath: tree, worktreeName: 'x', sessionId: 's-nb' })
    await cleanupWorktree()
    expect(registeredWorktrees(lab.git, clone)).toEqual([clone])
    expect(localBranches(lab.git, clone)).toEqual(['main', 'survivor'])
  })

  test('a failed removal still forgets the session and still deletes the branch', async () => {
    const { clone } = lab.upstream('cleanup-fail')
    lab.git.run(clone, 'branch', 'orphaned')
    const plain = lab.git.tempDir('not-a-worktree')
    restoreWorktreeSession({
      originalCwd: clone,
      worktreePath: plain,
      worktreeName: 'x',
      worktreeBranch: 'orphaned',
      sessionId: 's-fail',
    })
    await cleanupWorktree()
    expect(getCurrentWorktreeSession()).toBeNull()
    expect(existsSync(plain)).toBe(true)
    expect(localBranches(lab.git, clone)).toEqual(['main'])
  })

  test('a hook-made worktree goes to the WorktreeRemove hook and git is not touched', async () => {
    const { clone } = lab.upstream('cleanup-hook')
    const tree = linkedWorktree(clone, 'hooked')
    const record = join(lab.git.tempDir('records'), 'remove.json')
    lab.writeSettings({ hooks: { WorktreeRemove: [{ hooks: [recordingHook(record)] }] } })
    restoreWorktreeSession({
      originalCwd: clone,
      worktreePath: tree,
      worktreeName: 'hooked',
      worktreeBranch: 'hooked',
      sessionId: 's-hook',
      hookBased: true,
    })
    await cleanupWorktree()
    expect(JSON.parse(readFileSync(record, 'utf8'))).toMatchObject({
      hook_event_name: 'WorktreeRemove',
      worktree_path: tree,
    })
    expect(getCurrentWorktreeSession()).toBeNull()
    expect(registeredWorktrees(lab.git, clone)).toEqual([clone, tree])
    expect(localBranches(lab.git, clone)).toEqual(['hooked', 'main'])
  })

  test('a hook-made worktree with no WorktreeRemove hook is left and the session forgotten', async () => {
    const { clone } = lab.upstream('cleanup-nohook')
    const tree = linkedWorktree(clone, 'unhooked')
    restoreWorktreeSession({
      originalCwd: clone,
      worktreePath: tree,
      worktreeName: 'unhooked',
      sessionId: 's-nohook',
      hookBased: true,
    })
    await cleanupWorktree()
    expect(getCurrentWorktreeSession()).toBeNull()
    expect(existsSync(tree)).toBe(true)
  })

  test('does nothing without a session', async () => {
    const processDir = process.cwd()
    await cleanupWorktree()
    expect(process.cwd()).toBe(processDir)
  })

  test('when the original directory is gone nothing is removed and the session stays', async () => {
    const { clone } = lab.upstream('cleanup-vanished')
    const tree = linkedWorktree(clone, 'stays')
    const vanished = join(lab.git.tempDir('vanished'), 'was-here')
    const session: WorktreeSession = {
      originalCwd: vanished,
      worktreePath: tree,
      worktreeName: 'stays',
      worktreeBranch: 'stays',
      sessionId: 's-gone',
    }
    restoreWorktreeSession(session)
    await cleanupWorktree()
    expect(getCurrentWorktreeSession()).toBe(session)
    expect(registeredWorktrees(lab.git, clone)).toEqual([clone, tree])
  })
})

describe('cleanupStaleAgentWorktrees', () => {
  const LONG_AGO = new Date('2001-01-01T00:00:00Z')
  const CUTOFF = new Date('2020-01-01T00:00:00Z')

  type Fixture = { clone: string; dir: string }

  function sweepable(label: string): Fixture {
    const { clone } = lab.upstream(label)
    const dir = join(clone, '.claudin', 'worktrees')
    mkdirSync(dir, { recursive: true })
    return { clone, dir }
  }

  /** A worktree at <dir>/<slug> on worktree-<slug>, based on origin/main. */
  function plant(fixture: Fixture, slug: string): string {
    const path = join(fixture.dir, slug)
    lab.git.run(fixture.clone, 'worktree', 'add', '-q', '-b', `worktree-${slug}`, path, 'origin/main')
    return path
  }

  const age = (path: string, when: Date): void => utimesSync(path, when, when)

  test('removes old, clean throwaway worktrees and keeps every other name', async () => {
    const fixture = sweepable('sweep-names')
    const verdicts: Array<[string, boolean]> = [
      ['agent-a0123456', true],
      ['agent-afedcba9', true],
      ['wf_0123abcd-4ef-7', true],
      ['wf_0123abcd-4ef-12', true],
      ['wf-12', true],
      ['bridge-sess_01', true],
      ['bridge-sess_01-abc_2', true],
      ['job-nightly.build-89abcdef', true],
      ['feature', false],
      ['agent-b0123456', false],
      ['agent-a012345', false],
      ['agent-a01234567', false],
      ['agent-a012345g', false],
      ['wf-myfeature', false],
      ['wf_0123abcd-4ef-x', false],
      ['wf_0123abc-4ef-1', false],
      ['bridge-a--b', false],
      ['job-nightly-89ABCDEF', false],
      ['job--89abcdef', false],
    ]
    for (const [slug] of verdicts) age(plant(fixture, slug), LONG_AGO)
    const removed = await lab.inSession(fixture.clone, () => cleanupStaleAgentWorktrees(CUTOFF))
    expect(removed).toBe(verdicts.filter(([, gone]) => gone).length)
    const branches = localBranches(lab.git, fixture.clone)
    for (const [slug, gone] of verdicts) {
      const state = { slug, dir: existsSync(join(fixture.dir, slug)), branch: branches.includes(`worktree-${slug}`) }
      expect(state).toEqual({ slug, dir: !gone, branch: !gone })
    }
  })

  test('keeps what is recent, dirty, unpushed, current or not a worktree', async () => {
    const fixture = sweepable('sweep-guards')
    const recent = plant(fixture, 'agent-a1000001')
    const atCutoff = plant(fixture, 'agent-a1000002')
    const dirty = plant(fixture, 'agent-a1000003')
    writeFileSync(join(dirty, 'notes.txt'), 'changed\n')
    const untrackedOnly = plant(fixture, 'agent-a1000004')
    writeFileSync(join(untrackedOnly, 'build.log'), 'artifact\n')
    const unpushed = plant(fixture, 'agent-a1000005')
    lab.git.commit(unpushed, 'never pushed')
    const current = plant(fixture, 'agent-a1000006')
    const notWorktree = join(fixture.dir, 'agent-a1000007')
    mkdirSync(notWorktree)
    for (const path of [dirty, untrackedOnly, unpushed, current, notWorktree]) age(path, LONG_AGO)
    age(atCutoff, CUTOFF)
    restoreWorktreeSession({
      originalCwd: fixture.clone,
      worktreePath: current,
      worktreeName: 'agent-a1000006',
      sessionId: 's-current',
    })
    const removed = await lab.inSession(fixture.clone, () => cleanupStaleAgentWorktrees(CUTOFF))
    expect(removed).toBe(1)
    const survivors = [recent, atCutoff, dirty, unpushed, current, notWorktree]
    expect(survivors.filter(path => !existsSync(path))).toEqual([])
    expect(existsSync(untrackedOnly)).toBe(false)
  })

  test('a removal also prunes registrations whose directories are gone; no removal prunes nothing', async () => {
    const pruned = sweepable('sweep-prune')
    const vanished = plant(pruned, 'feature-gone')
    rmSync(vanished, { recursive: true, force: true })
    age(plant(pruned, 'agent-a2000001'), LONG_AGO)
    expect(await lab.inSession(pruned.clone, () => cleanupStaleAgentWorktrees(CUTOFF))).toBe(1)
    expect(registeredWorktrees(lab.git, pruned.clone)).toEqual([pruned.clone])

    const untouched = sweepable('sweep-noprune')
    const alsoVanished = plant(untouched, 'feature-gone')
    rmSync(alsoVanished, { recursive: true, force: true })
    expect(await lab.inSession(untouched.clone, () => cleanupStaleAgentWorktrees(CUTOFF))).toBe(0)
    expect(registeredWorktrees(lab.git, untouched.clone)).toEqual([untouched.clone, alsoVanished])
  })

  test('from inside a linked worktree it sweeps the main repository', async () => {
    const fixture = sweepable('sweep-canonical')
    age(plant(fixture, 'agent-a3000001'), LONG_AGO)
    const inside = linkedWorktree(fixture.clone, 'elsewhere')
    expect(await lab.inSession(inside, () => cleanupStaleAgentWorktrees(CUTOFF))).toBe(1)
  })

  test('answers 0 outside a repository and when there is no worktrees directory', async () => {
    const { clone } = lab.upstream('sweep-empty')
    expect(await lab.inSession(lab.anchor, () => cleanupStaleAgentWorktrees(CUTOFF))).toBe(0)
    expect(await lab.inSession(clone, () => cleanupStaleAgentWorktrees(CUTOFF))).toBe(0)
  })
})

describe('hasWorktreeChanges', () => {
  type Case = [label: string, prepare: (tree: string, base: string) => string, changed: boolean]
  const cases: Case[] = [
    ['clean, at the base', (_tree, base) => base, false],
    [
      'a tracked edit',
      (tree, base) => {
        writeFileSync(join(tree, 'notes.txt'), 'edited\n')
        return base
      },
      true,
    ],
    [
      'an untracked file',
      (tree, base) => {
        writeFileSync(join(tree, 'new.txt'), 'new\n')
        return base
      },
      true,
    ],
    [
      'a staged edit',
      (tree, base) => {
        writeFileSync(join(tree, 'notes.txt'), 'staged\n')
        lab.git.run(tree, 'add', 'notes.txt')
        return base
      },
      true,
    ],
    [
      'a commit since the base',
      (tree, base) => {
        lab.git.commit(tree, 'progress')
        return base
      },
      true,
    ],
    [
      'the base moved past HEAD',
      tree => {
        const ahead = lab.git.commit(tree, 'later')
        lab.git.run(tree, 'reset', '-q', '--hard', 'HEAD~1')
        return ahead
      },
      false,
    ],
    ['a base git does not know', () => '0123456789abcdef0123456789abcdef01234567', true],
  ]

  for (const [label, prepare, changed] of cases) {
    test(`${label}: ${changed}`, async () => {
      const { clone, base } = lab.upstream(`changes-${label.replaceAll(' ', '-')}`)
      const tree = linkedWorktree(clone, 'probe')
      const headCommit = prepare(tree, base)
      expect(await hasWorktreeChanges(tree, headCommit)).toBe(changed)
    })
  }

  test('a directory that is not a repository, or no directory at all, counts as changed', async () => {
    const plain = lab.git.tempDir('plain')
    expect(await hasWorktreeChanges(plain, 'HEAD')).toBe(true)
    expect(await hasWorktreeChanges(join(plain, 'missing'), 'HEAD')).toBe(true)
  })
})
