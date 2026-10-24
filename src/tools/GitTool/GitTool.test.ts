import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import { GitTool } from 'src/tools/GitTool/GitTool.js'
import { DESCRIPTION } from 'src/tools/GitTool/prompt.js'
import { formatGitBatchResult } from 'src/tools/GitTool/run.js'

const roots: string[] = []

/** A directory that is deliberately NOT a git repository. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'claudin-git-tool-surface-'))
  roots.push(root)
  return root
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

type CallContext = Parameters<typeof GitTool.call>[1]

function callContext(): CallContext {
  return { abortController: new AbortController(), toolUseId: 'toolu_surface' } as unknown as CallContext
}

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
    const result = await GitTool.validateInput?.({ commands: ['git diff | grep "^+"'] })
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

  test('declines a cwd that is a file', async () => {
    const file = join(scratch(), 'not-a-dir')
    writeFileSync(file, 'x')
    const result = await GitTool.validateInput?.({ commands: ['git status'], cwd: file })
    expect(result?.result).toBe(false)
    if (result && !result.result) expect(result.message).toContain('not a directory')
  })
})

describe('GitTool — the rest of the tool surface', () => {
  test('always enabled, never concurrent, one description for both slots', async () => {
    expect(GitTool.isEnabled()).toBe(true)
    expect(GitTool.isConcurrencySafe()).toBe(false)
    expect(await GitTool.description()).toBe(DESCRIPTION)
    expect(await GitTool.prompt()).toBe(DESCRIPTION)
  })

  test('the classifier sees the commands, one per line', () => {
    expect(GitTool.toAutoClassifierInput({ commands: ['git add a', 'git commit -m x'] })).toBe(
      'git add a\ngit commit -m x',
    )
  })

  test('call runs the batch, and the result maps to its formatted text', async () => {
    const progress: unknown[] = []
    const { data } = await runWithCwdOverride(scratch(), () =>
      GitTool.call(
        { commands: ['git --version'] },
        callContext(),
        (() => {}) as never,
        {} as never,
        p => progress.push(p),
      ),
    )

    expect(data.outcomes).toHaveLength(1)
    expect(data.outcomes[0]?.exitCode).toBe(0)
    expect(GitTool.mapToolResultToToolResultBlockParam(data, 'toolu_surface')).toEqual({
      tool_use_id: 'toolu_surface',
      type: 'tool_result',
      content: formatGitBatchResult(data),
      is_error: false,
    })
  }, 60_000)

  test('a failed batch maps to an error result', async () => {
    const { data } = await runWithCwdOverride(scratch(), () =>
      GitTool.call({ commands: ['git rev-parse --git-dir'] }, callContext(), (() => {}) as never, {} as never),
    )

    expect(GitTool.mapToolResultToToolResultBlockParam(data, 'toolu_surface').is_error).toBe(true)
  }, 60_000)
})
