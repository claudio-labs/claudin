import { describe, expect, test } from 'bun:test'

import { EnterWorktreeTool } from 'src/tools/EnterWorktreeTool/EnterWorktreeTool.js'

describe('EnterWorktreeTool', () => {
  test('shouldDefer is true and the user-facing name is human-friendly', () => {
    expect(EnterWorktreeTool.shouldDefer).toBe(true)
    expect(EnterWorktreeTool.userFacingName(undefined)).toBe('Creating worktree')
  })

  test('input schema accepts empty body and valid slug', () => {
    expect(EnterWorktreeTool.inputSchema.safeParse({}).success).toBe(true)
    expect(
      EnterWorktreeTool.inputSchema.safeParse({ name: 'feature/x.1' }).success,
    ).toBe(true)
  })

  test('input schema rejects invalid slug per validateWorktreeSlug', () => {
    // Path segment "." is forbidden
    const dot = EnterWorktreeTool.inputSchema.safeParse({ name: 'a/./b' })
    expect(dot.success).toBe(false)

    // Disallowed characters (space)
    const bad = EnterWorktreeTool.inputSchema.safeParse({ name: 'has space' })
    expect(bad.success).toBe(false)

    // Too long: 65 chars > MAX (64)
    const long = EnterWorktreeTool.inputSchema.safeParse({
      name: 'a'.repeat(65),
    })
    expect(long.success).toBe(false)
  })

  test('input schema rejects unknown keys', () => {
    expect(
      EnterWorktreeTool.inputSchema.safeParse({ name: 'ok', extra: 1 }).success,
    ).toBe(false)
  })

  test('input schema accepts path alone (enter existing worktree)', () => {
    expect(
      EnterWorktreeTool.inputSchema.safeParse({ path: '../wt-x' }).success,
    ).toBe(true)
  })

  test('input schema rejects name and path together (mutually exclusive)', () => {
    const both = EnterWorktreeTool.inputSchema.safeParse({
      name: 'feat',
      path: '../wt-x',
    })
    expect(both.success).toBe(false)
    if (!both.success) {
      expect(both.error.issues[0]?.message).toContain('mutually exclusive')
    }
  })

  test('toAutoClassifierInput returns the name or empty string', () => {
    expect(EnterWorktreeTool.toAutoClassifierInput?.({ name: 'feat' })).toBe(
      'feat',
    )
    expect(EnterWorktreeTool.toAutoClassifierInput?.({})).toBe('')
  })

  test('mapToolResultToToolResultBlockParam forwards the message string', () => {
    const block = EnterWorktreeTool.mapToolResultToToolResultBlockParam?.(
      {
        worktreePath: '/tmp/wt',
        worktreeBranch: 'main',
        message: 'Created worktree at /tmp/wt',
      },
      'u1',
    )
    expect(block).toEqual({
      type: 'tool_result',
      content: 'Created worktree at /tmp/wt',
      tool_use_id: 'u1',
    })
  })
})
