/**
 * Characterization of hook-based worktrees, pinned for the clean-base rewrite
 * (docs/tech/rewrite/vcs/worktree.md): when a WorktreeCreate hook is
 * configured it replaces git for creation, and a WorktreeRemove hook replaces
 * it for removal of a hook-made worktree.
 *
 * The hooks are real command hooks in the lab's user settings, run by the real
 * hook engine; each one saves the JSON it receives.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

import {
  failingHook,
  openWorktreeLab,
  recordingHook,
  registeredWorktrees,
  type CommandHook,
  type WorktreeLab,
} from 'src/vcs/git/__testutils__/worktreeLab.js'
import {
  createAgentWorktree,
  createWorktreeForSession,
  getCurrentWorktreeSession,
  removeAgentWorktree,
} from 'src/vcs/git/worktree.js'

let lab: WorktreeLab
let records: string

beforeEach(() => {
  lab = openWorktreeLab()
  records = lab.git.tempDir('hook-records')
})

afterEach(() => {
  lab.close()
})

function configure(hooks: { create?: CommandHook; remove?: CommandHook }): void {
  const settings: Record<string, unknown[]> = {}
  if (hooks.create) settings.WorktreeCreate = [{ hooks: [hooks.create] }]
  if (hooks.remove) settings.WorktreeRemove = [{ hooks: [hooks.remove] }]
  lab.writeSettings({ hooks: settings })
}

function received(name: string): Record<string, unknown> | null {
  const file = join(records, name)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : null
}

/** The rejection message, awaited plainly so the test timeout still applies. */
async function refusal(action: () => Promise<unknown>): Promise<string> {
  try {
    await action()
  } catch (error) {
    return (error as Error).message
  }
  return 'no rejection'
}

describe('a WorktreeCreate hook replaces git', () => {
  test('the session wrapper takes the directory the hook prints', async () => {
    const { clone } = lab.upstream('hook-session')
    const made = join(lab.git.tempDir('vcs'), 'checkout')
    configure({ create: recordingHook(join(records, 'create.json'), made) })
    const session = await lab.inSession(clone, () =>
      createWorktreeForSession('s-hook', 'team/x', 'tmux-name'),
    )
    expect(session).toEqual({
      originalCwd: clone,
      worktreePath: made,
      worktreeName: 'team/x',
      sessionId: 's-hook',
      tmuxSessionName: 'tmux-name',
      hookBased: true,
    })
    expect(session.worktreeBranch).toBeUndefined()
    expect(getCurrentWorktreeSession()).toBe(session)
    expect(received('create.json')).toMatchObject({ hook_event_name: 'WorktreeCreate', name: 'team/x' })
    expect(registeredWorktrees(lab.git, clone)).toEqual([clone])
    expect(existsSync(join(clone, '.claudin'))).toBe(false)
  })

  test('it works outside any git repository', async () => {
    const made = join(lab.git.tempDir('vcs'), 'elsewhere')
    configure({ create: recordingHook(join(records, 'create.json'), made) })
    const session = await lab.inSession(lab.anchor, () => createWorktreeForSession('s-nogit', 'plain'))
    expect(session.worktreePath).toBe(made)
    expect(session.hookBased).toBe(true)
  })

  test('the agent wrapper returns only the path and the hook flag', async () => {
    const { clone } = lab.upstream('hook-agent')
    const made = join(lab.git.tempDir('vcs'), 'agent')
    configure({ create: recordingHook(join(records, 'create.json'), made) })
    const result = await lab.inSession(clone, () => createAgentWorktree('agent-a4444444'))
    expect(result).toEqual({ worktreePath: made, hookBased: true })
    expect(getCurrentWorktreeSession()).toBeNull()
    expect(received('create.json')).toMatchObject({ name: 'agent-a4444444' })
  })

  test('the slug is validated before the hook ever runs', async () => {
    configure({ create: recordingHook(join(records, 'create.json'), join(records, 'never')) })
    const creators: Array<() => Promise<unknown>> = [
      () => createWorktreeForSession('s-bad', 'x/../y'),
      () => createAgentWorktree('x/../y'),
    ]
    for (const create of creators) {
      expect(await refusal(() => lab.inSession(lab.anchor, create))).toContain('"x/../y"')
    }
    expect(received('create.json')).toBeNull()
  })

  test('a failing hook fails creation and publishes nothing', async () => {
    const { clone } = lab.upstream('hook-fail')
    configure({ create: failingHook('no capacity') })
    const creators: Array<() => Promise<unknown>> = [
      () => createWorktreeForSession('s-fail', 'nope'),
      () => createAgentWorktree('nope'),
    ]
    for (const create of creators) {
      expect(await refusal(() => lab.inSession(clone, create))).toContain('WorktreeCreate hook failed')
    }
    expect(getCurrentWorktreeSession()).toBeNull()
    expect(registeredWorktrees(lab.git, clone)).toEqual([clone])
  })
})

describe('removing a hook-made worktree', () => {
  test('runs the WorktreeRemove hook with the path and leaves git alone', async () => {
    const { clone } = lab.upstream('hook-remove')
    const real = await lab.inSession(clone, () => createAgentWorktree('real'))
    configure({ remove: recordingHook(join(records, 'remove.json')) })
    const done = await removeAgentWorktree(real.worktreePath, real.worktreeBranch, clone, true)
    expect(done).toBe(true)
    expect(received('remove.json')).toMatchObject({
      hook_event_name: 'WorktreeRemove',
      worktree_path: real.worktreePath,
    })
    expect(registeredWorktrees(lab.git, clone)).toEqual([clone, real.worktreePath])
  })

  test('reports false when no WorktreeRemove hook is configured', async () => {
    configure({ create: recordingHook(join(records, 'create.json'), join(records, 'made')) })
    expect(await removeAgentWorktree(join(records, 'made'), undefined, undefined, true)).toBe(false)
  })

  test('a WorktreeRemove hook that fails still counts as having run', async () => {
    configure({ remove: failingHook('cannot remove') })
    expect(await removeAgentWorktree('/nowhere/at/all', undefined, undefined, true)).toBe(true)
  })

  test('a git-made worktree is removed through git even when a WorktreeRemove hook exists', async () => {
    const { clone } = lab.upstream('hook-ignored')
    const real = await lab.inSession(clone, () => createAgentWorktree('real'))
    configure({ remove: recordingHook(join(records, 'remove.json')) })
    expect(await removeAgentWorktree(real.worktreePath, real.worktreeBranch, clone)).toBe(true)
    expect(received('remove.json')).toBeNull()
    expect(registeredWorktrees(lab.git, clone)).toEqual([clone])
  })
})
