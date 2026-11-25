import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getOriginalCwd,
  getProjectRoot,
  setOriginalCwd,
  setProjectRoot,
} from 'src/platform/bootstrap/state.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { setCwd } from 'src/shared/proc/Shell.js'
import { restoreWorktreeSession, type WorktreeSession } from 'src/vcs/git/worktree.js'
import { ExitWorktreeTool } from 'src/tools/ExitWorktreeTool/ExitWorktreeTool.js'

const attachedSession = {
  originalCwd: '/orig',
  worktreePath: '/tmp/wt-attached',
  worktreeName: 'wt-attached',
  sessionId: 'sess-test',
  attached: true,
}

describe('ExitWorktreeTool', () => {
  afterEach(() => {
    // Reset module-level worktree session state mutated by attached-session tests.
    restoreWorktreeSession(null)
  })

  test('shouldDefer is true and userFacingName is human-friendly', () => {
    expect(ExitWorktreeTool.shouldDefer).toBe(true)
    expect(ExitWorktreeTool.userFacingName(undefined)).toBe('Exiting worktree')
  })

  test('isDestructive() reflects remove vs keep', () => {
    expect(ExitWorktreeTool.isDestructive?.({ action: 'remove' } as never)).toBe(
      true,
    )
    expect(ExitWorktreeTool.isDestructive?.({ action: 'keep' } as never)).toBe(
      false,
    )
  })

  test('toAutoClassifierInput returns the action verbatim', () => {
    expect(
      ExitWorktreeTool.toAutoClassifierInput?.({ action: 'remove' } as never),
    ).toBe('remove')
    expect(
      ExitWorktreeTool.toAutoClassifierInput?.({ action: 'keep' } as never),
    ).toBe('keep')
  })

  test('input schema requires action and only accepts keep|remove', () => {
    expect(ExitWorktreeTool.inputSchema.safeParse({}).success).toBe(false)
    expect(
      ExitWorktreeTool.inputSchema.safeParse({ action: 'bogus' }).success,
    ).toBe(false)

    const ok = ExitWorktreeTool.inputSchema.safeParse({
      action: 'remove',
      discard_changes: true,
    })
    expect(ok.success).toBe(true)
  })

  test('input schema rejects unknown keys', () => {
    expect(
      ExitWorktreeTool.inputSchema.safeParse({
        action: 'keep',
        extra: 1,
      }).success,
    ).toBe(false)
  })

  test('validateInput returns no-op when no worktree session is active', async () => {
    const result = await ExitWorktreeTool.validateInput?.(
      { action: 'keep' } as never,
      {} as never,
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.message).toContain('No-op')
      expect(result.errorCode).toBe(1)
    }
  })

  test('isDestructive is false for an attached worktree even with action remove', () => {
    restoreWorktreeSession(attachedSession)
    expect(
      ExitWorktreeTool.isDestructive?.({ action: 'remove' } as never),
    ).toBe(false)
  })

  test('validateInput skips the remove safety gate for an attached session', async () => {
    restoreWorktreeSession(attachedSession)
    // Attached + remove must pass validation (no "discard work" block) because
    // call() coerces it to keep. This is side-effect free: for an attached
    // session validateInput returns {result:true} without touching git or disk.
    const result = await ExitWorktreeTool.validateInput?.(
      { action: 'remove', discard_changes: false } as never,
      {} as never,
    )
    expect(result?.result).toBe(true)
  })

  test('mapToolResultToToolResultBlockParam echoes the message', () => {
    const block = ExitWorktreeTool.mapToolResultToToolResultBlockParam?.(
      {
        action: 'keep',
        originalCwd: '/orig',
        worktreePath: '/tmp/wt',
        message: 'Exited worktree at /tmp/wt (kept)',
      },
      'u1',
    )
    expect(block).toEqual({
      type: 'tool_result',
      content: 'Exited worktree at /tmp/wt (kept)',
      tool_use_id: 'u1',
    })
  })
})

// `remove` for real: call() chdirs back, resets the cwd, originalCwd and
// projectRoot and clears the session, so all of it is put back after.
describe('ExitWorktreeTool remove reports what it removed', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function tempDir(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'exit-wt-')))
    dirs.push(dir)
    return dir
  }

  async function remove(session: WorktreeSession): Promise<string> {
    const prev = {
      processCwd: process.cwd(),
      cwd: getCwd(),
      originalCwd: getOriginalCwd(),
      projectRoot: getProjectRoot(),
    }
    restoreWorktreeSession(session)
    try {
      const result = await ExitWorktreeTool.call(
        { action: 'remove', discard_changes: true } as never,
        {} as never,
        (() => {}) as never,
        {} as never,
      )
      return result.data.message
    } finally {
      process.chdir(prev.processCwd)
      setCwd(prev.cwd)
      setOriginalCwd(prev.originalCwd)
      setProjectRoot(prev.projectRoot)
      restoreWorktreeSession(null)
    }
  }

  function repoWithWorktree(branch: string): { repo: string; worktree: string } {
    const repo = tempDir()
    const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    git('init', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    git('commit', '--allow-empty', '-m', 'init')
    const worktree = join(tempDir(), 'wt')
    git('worktree', 'add', '-b', branch, worktree)
    return { repo, worktree }
  }

  test('a hook-made worktree with no WorktreeRemove hook is said to be still on disk', async () => {
    const worktree = tempDir()
    const message = await remove({
      originalCwd: tempDir(),
      worktreePath: worktree,
      worktreeName: 'hooked',
      sessionId: 'sess-test',
      hookBased: true,
    })
    expect(existsSync(worktree)).toBe(true)
    expect(message).not.toContain('removed worktree')
    expect(message).toContain(`${worktree} is still on disk`)
  })

  test('a branch git refuses to delete is said to be kept', async () => {
    const { repo, worktree } = repoWithWorktree('wt-refused')
    // `main` is checked out in the main worktree, so `git branch -D` refuses it.
    const message = await remove({
      originalCwd: repo,
      worktreePath: worktree,
      worktreeName: 'wt',
      worktreeBranch: 'main',
      sessionId: 'sess-test',
    })
    expect(message).toContain(`removed worktree at ${worktree}`)
    expect(message).toContain('Git refused to delete branch main, so it is still there')
  })
})
