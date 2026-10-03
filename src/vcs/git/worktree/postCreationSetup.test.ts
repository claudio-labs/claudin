/**
 * Post-creation steps are independent and best effort: one that throws is
 * logged, and the steps after it still run.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'fs'
import { join } from 'path'

import { openWorktreeLab, type WorktreeLab } from 'src/vcs/git/__testutils__/worktreeLab.js'
import { createAgentWorktree } from 'src/vcs/git/worktree.js'

let lab: WorktreeLab

beforeEach(() => {
  lab = openWorktreeLab()
})

afterEach(() => {
  lab.close()
})

test('a step that throws does not stop creation or the steps after it', async () => {
  const repo = lab.git.repo('setup-throws')
  // The commit holds a directory where the local settings file would be copied to.
  const settings = join('.claudin', 'settings.local.json')
  lab.git.put(repo, join(settings, 'keep'), 'x\n')
  lab.git.run(repo, 'add', '.')
  lab.git.run(repo, 'commit', '-q', '-m', 'a directory in the way')
  rmSync(join(repo, settings), { recursive: true, force: true })
  writeFileSync(join(repo, settings), '{}\n')

  const made = await lab.inSession(repo, () => createAgentWorktree('blocked'))
  expect(lab.git.run(repo, 'config', '--get', 'core.hooksPath')).toBe(join(repo, '.git', 'hooks'))
  expect(lab.git.run(made.worktreePath, 'rev-parse', '--is-inside-work-tree')).toBe('true')
})
