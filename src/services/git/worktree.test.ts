import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getCwd } from 'src/utils/fs/cwd.js'
import { setCwd } from 'src/utils/proc/Shell.js'
import {
  _resetGitWorktreeMutationLocksForTesting,
  attachExistingWorktree,
  restoreWorktreeSession,
  withGitWorktreeMutationLock,
} from './worktree.js'

afterEach(() => {
  _resetGitWorktreeMutationLocksForTesting()
})

test('withGitWorktreeMutationLock serializes mutations for the same repo', async () => {
  const order: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = resolve
  })

  const first = withGitWorktreeMutationLock('/repo', async () => {
    order.push('first:start')
    await firstGate
    order.push('first:end')
  })

  const second = withGitWorktreeMutationLock('/repo', async () => {
    order.push('second:start')
    order.push('second:end')
  })

  await Promise.resolve()
  await Promise.resolve()
  expect(order).toEqual(['first:start'])

  releaseFirst()
  await Promise.all([first, second])

  expect(order).toEqual([
    'first:start',
    'first:end',
    'second:start',
    'second:end',
  ])
})

test('withGitWorktreeMutationLock does not serialize different repos', async () => {
  const order: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = resolve
  })

  const first = withGitWorktreeMutationLock('/repo-a', async () => {
    order.push('a:start')
    await firstGate
    order.push('a:end')
  })

  const second = withGitWorktreeMutationLock('/repo-b', async () => {
    order.push('b:start')
    order.push('b:end')
  })

  await Promise.resolve()
  await Promise.resolve()
  expect(order).toEqual(['a:start', 'b:start', 'b:end'])

  releaseFirst()
  await Promise.all([first, second])
})

// attachExistingWorktree — rejection paths only. These throw BEFORE any global
// state mutation or config write (findIndex/matchIdx checks happen before the
// session is built and persisted), so they're side-effect free and safe to unit
// test. The ExitWorktree remove→keep coercion is covered at the validateInput
// gate-skip level in ExitWorktreeTool.test.ts (also side-effect free). Only the
// attach HAPPY path (which mutates currentWorktreeSession + writes project
// config + chdir) is left to the manual e2e steps in the plan.
test('attachExistingWorktree rejects a path that is not a registered worktree', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'claudin-wt-'))
  const prevCwd = getCwd()
  try {
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    git('init')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    git('commit', '--allow-empty', '-m', 'init')
    setCwd(repo)

    await expect(
      attachExistingWorktree(join(repo, 'does-not-exist'), 'sess-1'),
    ).rejects.toThrow('not a registered worktree')
  } finally {
    restoreWorktreeSession(null)
    setCwd(prevCwd)
    rmSync(repo, { recursive: true, force: true })
  }
})

test('attachExistingWorktree rejects the main worktree', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'claudin-wt-'))
  const prevCwd = getCwd()
  try {
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    git('init')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    git('commit', '--allow-empty', '-m', 'init')
    setCwd(repo)

    await expect(attachExistingWorktree(repo, 'sess-1')).rejects.toThrow(
      'main worktree',
    )
  } finally {
    restoreWorktreeSession(null)
    setCwd(prevCwd)
    rmSync(repo, { recursive: true, force: true })
  }
})
