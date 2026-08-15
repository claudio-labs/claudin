import { describe, expect, test } from 'bun:test'
import { GitTool } from 'src/tools/GitTool/GitTool.js'

/**
 * `isReadOnly` is the gate plan mode calls
 * (`planModeHardDenyIfApplicable` → `tool.isReadOnly(input)`,
 * `src/permissions/permissions.ts:1079`), and it fails closed there: a
 * throw is treated as NOT read-only. So the contract this file pins is exactly
 * what decides whether a command can run inside a plan.
 */
describe('GitTool.isReadOnly — the plan-mode gate', () => {
  test('a read batch is read-only', () => {
    expect(GitTool.isReadOnly({ commands: ['git diff'] })).toBe(true)
    expect(GitTool.isReadOnly({ commands: ['git status', 'git diff', 'git log -3'] })).toBe(
      true,
    )
  })

  test('a mutation is not', () => {
    expect(GitTool.isReadOnly({ commands: ['git commit -m x'] })).toBe(false)
    expect(GitTool.isReadOnly({ commands: ['git push'] })).toBe(false)
  })

  test('`git fetch` is not, because it writes refs', () => {
    expect(GitTool.isReadOnly({ commands: ['git fetch'] })).toBe(false)
  })

  test('a mixed batch is not — the rule is AND over the list', () => {
    expect(GitTool.isReadOnly({ commands: ['git diff', 'git commit -m x'] })).toBe(false)
    expect(GitTool.isReadOnly({ commands: ['git commit -m x', 'git diff'] })).toBe(false)
  })

  test('an empty list is not read-only', () => {
    expect(GitTool.isReadOnly({ commands: [] })).toBe(false)
  })

  test('a command the classifier does not know is not read-only', () => {
    expect(GitTool.isReadOnly({ commands: ['git totally-new-subcommand'] })).toBe(false)
  })
})

describe('GitTool.validateInput — refusals land before anything runs', () => {
  test('declines a shell operator', async () => {
    const result = await GitTool.validateInput?.({ commands: ['git diff | head -5'] })
    expect(result?.result).toBe(false)
  })

  test('declines an interactive form', async () => {
    const result = await GitTool.validateInput?.({ commands: ['git add -p'] })
    expect(result?.result).toBe(false)
    if (result && !result.result) expect(result.message).toContain('hang')
  })

  test('declines a batch when only ONE element is bad', async () => {
    const result = await GitTool.validateInput?.({
      commands: ['git status', 'git rebase -i HEAD~2'],
    })
    expect(result?.result).toBe(false)
  })

  test('accepts a well-formed batch', async () => {
    const result = await GitTool.validateInput?.({
      commands: ['git status', 'git diff', 'git commit -m "x"'],
    })
    expect(result?.result).toBe(true)
  })
})
