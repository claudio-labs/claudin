import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import { getAllBaseTools } from 'src/tools/tools.js'
import { GitTool, MAX_COMMANDS } from 'src/tools/GitTool/GitTool.js'
import { batchFailed, formatGitBatchResult, runGitBatch } from 'src/tools/GitTool/run.js'

const roots: string[] = []

/** A directory that is deliberately NOT a git repository. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'claudin-git-tool-'))
  roots.push(root)
  return root
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function run(commands: string[]) {
  return runWithCwdOverride(scratch(), () =>
    runGitBatch({
      commands,
      abortSignal: new AbortController().signal,
      timeoutMs: 30_000,
    }),
  )
}

describe('batch execution', () => {
  test('runs every command in order when all succeed', async () => {
    const result = await run(['git --version', 'git --version'])
    expect(result.outcomes).toHaveLength(2)
    expect(result.outcomes.every(o => o.exitCode === 0)).toBe(true)
    expect(result.notRun).toEqual([])
    expect(batchFailed(result)).toBe(false)
  }, 60_000)

  test('stops at the first non-zero exit and reports what did not run', async () => {
    // `git rev-parse --git-dir` exits non-zero outside a repository, so the
    // failure is real rather than simulated.
    const result = await run([
      'git rev-parse --git-dir',
      'git --version',
      'git status',
    ])
    expect(result.outcomes).toHaveLength(1)
    expect(result.outcomes[0]?.exitCode).not.toBe(0)
    expect(result.notRun).toEqual(['git --version', 'git status'])
    expect(batchFailed(result)).toBe(true)
  }, 60_000)

  test('the skipped commands are named in the model-facing text', async () => {
    const result = await run(['git rev-parse --git-dir', 'git --version'])
    const text = formatGitBatchResult(result)
    // Without this the model cannot tell a skipped command from one that
    // produced no output.
    expect(text).toContain('not run')
    expect(text).toContain('git --version')
  }, 60_000)

  test('a single successful command renders bare, like a Bash result', async () => {
    const result = await run(['git --version'])
    const text = formatGitBatchResult(result)
    expect(text).toStartWith('git version')
    expect(text).not.toContain('$ git --version')
  }, 60_000)

  test('a batch labels each section with the command that produced it', async () => {
    const result = await run(['git --version', 'git --version'])
    expect(formatGitBatchResult(result)).toContain('$ git --version')
  }, 60_000)
})

describe('isReadOnly is the AND over the list', () => {
  test('all reads → read-only', () => {
    expect(GitTool.isReadOnly({ commands: ['git status', 'git diff'] })).toBe(true)
  })

  test('a cwd makes even a read batch non-read-only, like `git -C`', () => {
    expect(
      GitTool.isReadOnly({ commands: ['git status', 'git diff'], cwd: '/elsewhere' }),
    ).toBe(false)
  })

  test('one write makes the whole batch a write', () => {
    // The fail-closed direction: plan mode must refuse a mixed batch rather
    // than run the reads and stop halfway.
    expect(
      GitTool.isReadOnly({ commands: ['git status', 'git commit -m x'] }),
    ).toBe(false)
  })
})

describe('input schema', () => {
  test('rejects an empty list', () => {
    expect(GitTool.inputSchema.safeParse({ commands: [] }).success).toBe(false)
  })

  test('accepts exactly the cap and rejects one more', () => {
    const at = Array.from({ length: MAX_COMMANDS }, () => 'git status')
    expect(GitTool.inputSchema.safeParse({ commands: at }).success).toBe(true)
    expect(
      GitTool.inputSchema.safeParse({ commands: [...at, 'git status'] }).success,
    ).toBe(false)
  })

  test('takes a list, never a bare string', () => {
    // A `string | string[]` union becomes anyOf in JSON Schema, which strict
    // -schema transports mangle; the array is the only accepted shape.
    expect(GitTool.inputSchema.safeParse({ commands: 'git status' }).success).toBe(
      false,
    )
  })
})

describe('validateInput', () => {
  test('refuses a batch containing a composed command', async () => {
    const result = await GitTool.validateInput?.({
      commands: ['git status', 'git add -A && git commit -m x'],
    })
    expect(result?.result).toBe(false)
  })

  test('accepts a quoted commit message', async () => {
    const result = await GitTool.validateInput?.({
      commands: ['git commit -m "fix: thing"'],
    })
    expect(result?.result).toBe(true)
  })

  test('cwd must be an absolute path to an existing directory', async () => {
    const relative = await GitTool.validateInput?.({ commands: ['git status'], cwd: 'sibling' })
    expect(relative?.result).toBe(false)
    const missing = await GitTool.validateInput?.({
      commands: ['git status'],
      cwd: join(scratch(), 'does-not-exist'),
    })
    expect(missing?.result).toBe(false)
    const ok = await GitTool.validateInput?.({ commands: ['git status'], cwd: scratch() })
    expect(ok?.result).toBe(true)
  })
})

describe('cwd runs the batch in another checkout', () => {
  test('the commands see the other repo', async () => {
    // A real second repository with one commit, so `git log` has a subject
    // the session cwd (a non-repo scratch dir) could never produce.
    const other = scratch()
    execFileSync('git', ['init', '-q'], { cwd: other })
    writeFileSync(join(other, 'f.txt'), 'x\n')
    execFileSync('git', ['add', 'f.txt'], { cwd: other })
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'other-repo-subject-7f3a'],
      { cwd: other },
    )
    const home = scratch()
    const result = await runWithCwdOverride(home, () =>
      runGitBatch({
        commands: ['git log --oneline -1'],
        cwd: other,
        abortSignal: new AbortController().signal,
        timeoutMs: 30_000,
      }),
    )
    expect(result.outcomes[0]?.exitCode).toBe(0)
    expect(result.outcomes[0]?.output).toContain('other-repo-subject-7f3a')
    // The `cd` is visible in what ran.
    expect(result.outcomes[0]?.effectiveCommand).toContain(`cd ${other}`)
  }, 60_000)

  test('the cd never moves the session cwd (source-asserted)', () => {
    // `exec()` moves the session cwd after any foreground command unless
    // `preventCwdChanges` is set (Shell.ts). A runtime assertion here is
    // tautological — `runWithCwdOverride` answers getCwd() from the override
    // whatever exec did — so the flag is pinned where it is passed.
    const src = readFileSync(new URL('./run.ts', import.meta.url), 'utf8')
    expect(src).toContain('preventCwdChanges: opts.cwd !== undefined')
  })
})

describe('registration', () => {
  const original = process.env.CLAUDIN_DISABLE_GIT_TOOL

  afterAll(() => {
    if (original === undefined) delete process.env.CLAUDIN_DISABLE_GIT_TOOL
    else process.env.CLAUDIN_DISABLE_GIT_TOOL = original
  })

  test('is in the base toolset by default', () => {
    delete process.env.CLAUDIN_DISABLE_GIT_TOOL
    expect(getAllBaseTools().map(t => t.name)).toContain('Git')
  })

  test('the killswitch removes it from the toolset entirely', () => {
    // Not just disabled: the description is paid on every request, so the
    // schema itself has to go.
    process.env.CLAUDIN_DISABLE_GIT_TOOL = '1'
    expect(getAllBaseTools().map(t => t.name)).not.toContain('Git')
  })
})
