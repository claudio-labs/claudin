/**
 * Characterization of WorktreeExitDialog, what `/exit` shows when the session
 * is inside a worktree it created: keep the worktree, or remove it (and its
 * branch). Written before the clean-base rewrite of permissions/sessionDialogs;
 * the spec is docs/tech/rewrite/permissions/sessionDialogs.md.
 *
 * Each test builds a real repository with a real linked worktree in the vcs
 * worktree lab (git isolated from the user's configuration, a private config
 * directory), publishes the session the way the worktree slice does, and
 * starts the session inside the worktree. tmux is a recording stand-in on
 * PATH, so no real tmux server is ever touched.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as React from 'react'
import { getCached, setCached } from 'src/agent/tools/toolResultCache.js'
import { WorktreeExitDialog } from 'src/permissions/ui/WorktreeExitDialog.js'
import { flat, KEYS, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { getCwdState, setCwdState } from 'src/platform/bootstrap/state.js'
import { openWorktreeLab, type WorktreeLab } from 'src/vcs/git/__testutils__/worktreeLab.js'
import { getCurrentWorktreeSession, restoreWorktreeSession, type WorktreeSession } from 'src/vcs/git/worktree.js'

const BRANCH = 'wt-branch'
const CACHED_QUERY = { pattern: '**/*.ts', path: '/somewhere' }

type Calls = { done: unknown[][]; cancel: number }

type Tree = { repo: string; path: string; session: WorktreeSession; tmuxLog: string }

type Shape = { dirty?: number; commits?: number; tmux?: string }

describe('WorktreeExitDialog', () => {
  let lab: WorktreeLab
  let savedCwdState = ''

  beforeEach(() => {
    savedCwdState = getCwdState()
    lab = openWorktreeLab()
    // A tmux that only writes down how it was called.
    const bin = lab.git.tempDir('bin')
    const tmuxLog = join(bin, 'tmux.log')
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${tmuxLog}'\n`)
    chmodSync(join(bin, 'tmux'), 0o755)
    lab.env.set('PATH', `${bin}:${process.env.PATH}`)
    lab.env.set('TMUX', undefined)
    setCached('Glob', CACHED_QUERY, ['a.ts'])
  })
  afterEach(() => {
    lab.close()
    setCwdState(savedCwdState)
  })

  /** A repository with a linked worktree on BRANCH, the session inside it. */
  function enterWorktree(shape: Shape = {}): Tree {
    const repo = lab.git.repo('repo')
    const path = join(lab.git.tempDir('trees'), 'feature')
    lab.git.run(repo, 'worktree', 'add', '-q', '-b', BRANCH, path)
    const start = lab.git.run(path, 'rev-parse', 'HEAD')
    for (let n = 0; n < (shape.commits ?? 0); n++) lab.git.commit(path, `work ${n}`)
    for (let n = 0; n < (shape.dirty ?? 0); n++) lab.git.put(path, `scratch-${n}.txt`, 'unsaved\n')
    const session: WorktreeSession = {
      originalCwd: repo,
      worktreePath: path,
      worktreeName: 'feature',
      worktreeBranch: BRANCH,
      originalBranch: 'main',
      originalHeadCommit: start,
      sessionId: 'session-under-test',
      ...(shape.tmux ? { tmuxSessionName: shape.tmux } : {}),
    }
    restoreWorktreeSession(session)
    process.chdir(path)
    setCwdState(path)
    const tmuxLog = join(process.env.PATH!.split(':')[0]!, 'tmux.log')
    return { repo, path, session, tmuxLog }
  }

  function open(calls: Calls, withCancel = true) {
    return mount(
      <WorktreeExitDialog
        onDone={(...args: unknown[]) => calls.done.push(args)}
        {...(withCancel ? { onCancel: () => (calls.cancel += 1) } : {})}
      />,
      { columns: 120, ready: () => true },
    )
  }

  const fresh = (): Calls => ({ done: [], cancel: 0 })

  const NO_SESSION = ['No active worktree session found', { display: 'system' }]
  /**
   * What the dialog reported as the outcome. Once it has ended the worktree
   * session, today's dialog also reports NO_SESSION from its re-renders, before
   * and after the outcome; that is finding 6 of the spec (fix), so it is
   * filtered out here rather than pinned.
   */
  const outcomes = (calls: Calls) => calls.done.filter(args => JSON.stringify(args) !== JSON.stringify(NO_SESSION))

  async function settled(calls: Calls): Promise<void> {
    const deadline = Date.now() + 10_000
    while (outcomes(calls).length === 0) {
      if (Date.now() > deadline) throw new Error('onDone was never called')
      await Bun.sleep(20)
    }
    await Bun.sleep(100)
  }

  const branchExists = (tree: Tree) => lab.git.attempt(tree.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`).ok
  const tmuxCalls = (tree: Tree) => (existsSync(tree.tmuxLog) ? readFileSync(tree.tmuxLog, 'utf8').trim().split('\n') : [])

  /** The session is back where it started, the worktree session is over, and cached tool results are gone. */
  function expectBackHome(tree: Tree) {
    expect(process.cwd()).toBe(tree.repo)
    expect(getCwdState()).toBe(tree.repo)
    expect(getCurrentWorktreeSession()).toBeNull()
    expect(getCached('Glob', CACHED_QUERY)).toBeUndefined()
  }

  test(
    'with no worktree session it reports that at once, as a system message, and draws nothing',
    async () => {
      const calls = fresh()
      const screen = await open(calls)
      await Bun.sleep(200)
      expect(calls.done.length).toBeGreaterThan(0)
      for (const args of calls.done) expect(args).toEqual(NO_SESSION)
      expect(screen.text()).not.toContain('worktree')
    },
    SLOW,
  )

  test(
    'with nothing to lose it removes the worktree and its branch without asking',
    async () => {
      const tree = enterWorktree()
      const calls = fresh()
      const screen = await open(calls)
      await settled(calls)
      expect(outcomes(calls)).toEqual([['Worktree removed (no changes)']])
      expect(existsSync(tree.path)).toBe(false)
      expect(branchExists(tree)).toBe(false)
      expectBackHome(tree)
      expect(screen.text()).not.toContain('Exiting worktree session')
    },
    SLOW,
  )

  // --- the question -------------------------------------------------------------------
  const subtitles: Array<{ shape: Shape; says: string }> = [
    { shape: { dirty: 1 }, says: 'You have 1 uncommitted file. These will be lost if you remove the worktree.' },
    { shape: { dirty: 3 }, says: 'You have 3 uncommitted files. These will be lost if you remove the worktree.' },
    { shape: { commits: 1 }, says: `You have 1 commit on ${BRANCH}. The branch will be deleted if you remove the worktree.` },
    { shape: { commits: 2 }, says: `You have 2 commits on ${BRANCH}. The branch will be deleted if you remove the worktree.` },
    { shape: { dirty: 1, commits: 1 }, says: `You have 1 uncommitted file and 1 commit on ${BRANCH}. All will be lost if you remove.` },
    { shape: { dirty: 2, commits: 3 }, says: `You have 2 uncommitted files and 3 commits on ${BRANCH}. All will be lost if you remove.` },
  ]
  for (const { shape, says } of subtitles) {
    test(
      `asks, saying "${says}"`,
      async () => {
        const tree = enterWorktree(shape)
        const calls = fresh()
        const screen = await open(calls)
        const text = flat(await screen.until(frame => frame.includes('Remove worktree'), 'the question'))
        expect(text).toContain('Exiting worktree session')
        expect(text).toContain(says)
        expect(text).toContain(`❯ 1. Keep worktree Stays at ${tree.path}`)
        expect(text).toContain('2. Remove worktree All changes and commits will be lost.')
        expect(text).not.toContain('3.')
        expect(calls.done).toEqual([])
        // Asking changes nothing yet.
        expect(getCurrentWorktreeSession()).toBe(tree.session)
        expect(process.cwd()).toBe(tree.path)
      },
      SLOW,
    )
  }

  const keeps: Array<{ how: string; keys: string[]; withCancel: boolean }> = [
    { how: 'Enter on the focused "Keep worktree"', keys: [KEYS.enter], withCancel: true },
    { how: 'Esc when the caller gave no cancel', keys: [KEYS.esc], withCancel: false },
  ]
  for (const { how, keys, withCancel } of keeps) {
    test(
      `${how} keeps the worktree, its branch and its changes, and returns to the original directory`,
      async () => {
        const tree = enterWorktree({ dirty: 1, commits: 1 })
        const calls = fresh()
        const screen = await open(calls, withCancel)
        await screen.until(frame => frame.includes('Keep worktree'), 'the question')
        await screen.press(...keys)
        await settled(calls)
        expect(outcomes(calls)).toEqual([[`Worktree kept. Your work is saved at ${tree.path} on branch ${BRANCH}`]])
        expect(existsSync(join(tree.path, 'scratch-0.txt'))).toBe(true)
        expect(branchExists(tree)).toBe(true)
        expectBackHome(tree)
        expect(calls.cancel).toBe(0)
      },
      SLOW,
    )
  }

  test(
    'Esc with a caller cancel goes back to the session and changes nothing',
    async () => {
      const tree = enterWorktree({ dirty: 1 })
      const calls = fresh()
      const screen = await open(calls)
      await screen.until(frame => frame.includes('Keep worktree'), 'the question')
      await screen.press(KEYS.esc)
      await Bun.sleep(200)
      expect(calls.cancel).toBe(1)
      expect(calls.done).toEqual([])
      expect(getCurrentWorktreeSession()).toBe(tree.session)
      expect(process.cwd()).toBe(tree.path)
      expect(existsSync(tree.path)).toBe(true)
      expect(getCached('Glob', CACHED_QUERY)).toBeDefined()
    },
    SLOW,
  )

  const removals: Array<{ shape: Shape; keys: string[]; says: string }> = [
    { shape: { dirty: 2 }, keys: ['2'], says: 'Worktree removed. Uncommitted changes were discarded.' },
    { shape: { commits: 1 }, keys: [KEYS.down, KEYS.enter], says: `Worktree removed. 1 commit on ${BRANCH} was discarded.` },
    { shape: { commits: 2 }, keys: ['2'], says: `Worktree removed. 2 commits on ${BRANCH} were discarded.` },
    { shape: { dirty: 1, commits: 1 }, keys: ['2'], says: 'Worktree removed. 1 commit and uncommitted changes were discarded.' },
    { shape: { dirty: 1, commits: 2 }, keys: ['2'], says: 'Worktree removed. 2 commits and uncommitted changes were discarded.' },
  ]
  for (const { shape, keys, says } of removals) {
    test(
      `removing ${JSON.stringify(shape)} deletes the worktree and its branch and reports "${says}"`,
      async () => {
        const tree = enterWorktree(shape)
        const calls = fresh()
        const screen = await open(calls)
        await screen.until(frame => frame.includes('Remove worktree'), 'the question')
        await screen.press(...keys)
        await settled(calls)
        expect(outcomes(calls)).toEqual([[says]])
        expect(existsSync(tree.path)).toBe(false)
        expect(branchExists(tree)).toBe(false)
        expectBackHome(tree)
        expect(tmuxCalls(tree)).toEqual([])
      },
      SLOW,
    )
  }

  // --- with a tmux session -----------------------------------------------------------------
  test(
    'with a tmux session it offers three answers that name the session',
    async () => {
      const tree = enterWorktree({ dirty: 1, tmux: 'feature_tmux' })
      const screen = await open(fresh())
      const text = flat(await screen.until(frame => frame.includes('Remove worktree and tmux session'), 'the question'))
      expect(text).toContain(`❯ 1. Keep worktree and tmux session Stays at ${tree.path}. Reattach with: tmux attach -t feature_tmux`)
      expect(text).toContain(`2. Keep worktree, kill tmux session Keeps worktree at ${tree.path}, terminates tmux session.`)
      expect(text).toContain('3. Remove worktree and tmux session All changes and commits will be lost.')
    },
    SLOW,
  )

  const tmuxAnswers: Array<{ answer: string; keys: string[]; says: (tree: Tree) => string; kills: boolean; removes: boolean }> = [
    {
      answer: 'keep both',
      keys: [KEYS.enter],
      says: tree => `Worktree kept. Your work is saved at ${tree.path} on branch ${BRANCH}. Reattach to tmux session with: tmux attach -t feature_tmux`,
      kills: false,
      removes: false,
    },
    {
      answer: 'keep the worktree, kill the session',
      keys: ['2'],
      says: tree => `Worktree kept at ${tree.path} on branch ${BRANCH}. Tmux session terminated.`,
      kills: true,
      removes: false,
    },
    {
      answer: 'remove both',
      keys: ['3'],
      says: () => 'Worktree removed. Uncommitted changes were discarded. Tmux session terminated.',
      kills: true,
      removes: true,
    },
  ]
  for (const { answer, keys, says, kills, removes } of tmuxAnswers) {
    test(
      `"${answer}" ${kills ? 'kills exactly that tmux session' : 'leaves tmux alone'} and ${removes ? 'removes' : 'keeps'} the worktree`,
      async () => {
        const tree = enterWorktree({ dirty: 1, tmux: 'feature_tmux' })
        const calls = fresh()
        const screen = await open(calls)
        await screen.until(frame => frame.includes('tmux session'), 'the question')
        await screen.press(...keys)
        await settled(calls)
        expect(outcomes(calls)).toEqual([[says(tree)]])
        expect(tmuxCalls(tree)).toEqual(kills ? ['kill-session -t =feature_tmux'] : [])
        expect(existsSync(tree.path)).toBe(!removes)
        expect(branchExists(tree)).toBe(!removes)
        expectBackHome(tree)
      },
      SLOW,
    )
  }

  // --- when the original directory is gone ---------------------------------------------------
  test(
    'removing when the original directory is gone reports the failure and still finishes',
    async () => {
      const tree = enterWorktree({ dirty: 1 })
      const calls = fresh()
      const screen = await open(calls)
      await screen.until(frame => frame.includes('Remove worktree'), 'the question')
      rmSync(tree.repo, { recursive: true, force: true })
      await screen.press('2')
      await settled(calls)
      expect(outcomes(calls)).toEqual([['Worktree cleanup failed, exiting anyway']])
      expect(getCached('Glob', CACHED_QUERY)).toBeUndefined()
      // Nothing was removed: the worktree is still there.
      expect(existsSync(tree.path)).toBe(true)
    },
    SLOW,
  )

  test(
    'the silent removal reports the same failure when the original directory is gone',
    async () => {
      const tree = enterWorktree()
      rmSync(tree.repo, { recursive: true, force: true })
      const calls = fresh()
      await open(calls)
      await settled(calls)
      expect(outcomes(calls)).toEqual([['Worktree cleanup failed, exiting anyway']])
      expect(getCached('Glob', CACHED_QUERY)).toBeUndefined()
    },
    SLOW,
  )
})
