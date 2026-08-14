import { afterEach, describe, expect, test } from 'bun:test'

import { restoreWorktreeSession } from 'src/services/git/worktree.js'
import { ExitWorktreeTool } from './ExitWorktreeTool.js'

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
