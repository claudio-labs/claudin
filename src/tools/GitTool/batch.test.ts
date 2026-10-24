import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import { getAllBaseTools } from 'src/tools/tools.js'
import { GitTool, MAX_COMMANDS } from 'src/tools/GitTool/GitTool.js'
import { batchFailed, formatGitBatchResult, RULE_MAP_SET_ASIDE_NOTE, runGitBatch } from 'src/tools/GitTool/run.js'
import { RULE_MAP_KILLSWITCH, syncProjectRuleMap } from 'src/memory/instructions/ruleMapAutoSync.js'

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

describe('a pull or switch refused only over the navigation map the sync healed', () => {
  const savedKillswitch = process.env[RULE_MAP_KILLSWITCH]
  beforeEach(() => {
    delete process.env[RULE_MAP_KILLSWITCH]
  })
  afterAll(() => {
    if (savedKillswitch === undefined) delete process.env[RULE_MAP_KILLSWITCH]
    else process.env[RULE_MAP_KILLSWITCH] = savedKillswitch
  })

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  }

  function identity(cwd: string): void {
    git(cwd, ['config', 'user.email', 'test@example.com'])
    git(cwd, ['config', 'user.name', 'Test'])
  }

  function files(root: string, dir: string, count: number): void {
    mkdirSync(join(root, 'src', dir), { recursive: true })
    for (let i = 0; i < count; i++) writeFileSync(join(root, 'src', dir, `f${i}.ts`), 'x\n')
    git(root, ['add', 'src'])
    git(root, ['commit', '-qm', dir])
  }

  /**
   * An origin, a teammate's clone that has pushed one more commit, and the
   * session's clone, whose map the sync healed after a local commit — so the
   * tree's only change is ` M .claudin/rules/search-strategy.md`.
   */
  async function sessionClone(): Promise<string> {
    const origin = scratch()
    git(origin, ['init', '-q', '--bare'])
    const teammate = scratch()
    git(teammate, ['clone', '-q', origin, '.'])
    identity(teammate)
    files(teammate, 'core', 8)
    await syncProjectRuleMap(teammate)
    git(teammate, ['add', '-A'])
    git(teammate, ['commit', '-qm', 'map'])
    git(teammate, ['push', '-q', '-u', 'origin', 'HEAD'])

    const session = scratch()
    git(session, ['clone', '-q', origin, '.'])
    identity(session)
    files(session, 'grown', 40)
    expect((await syncProjectRuleMap(session)).status).toBe('healed')

    writeFileSync(join(teammate, 'README.md'), 'upstream\n')
    git(teammate, ['add', 'README.md'])
    git(teammate, ['commit', '-qm', 'readme'])
    git(teammate, ['push', '-q'])
    return session
  }

  function runIn(root: string, commands: string[], ruleMapRoot?: string) {
    return runWithCwdOverride(root, () =>
      runGitBatch({ commands, abortSignal: new AbortController().signal, timeoutMs: 30_000, ruleMapRoot }),
    )
  }

  test('a rebasing pull has the heal put back and runs, with the note', async () => {
    const session = await sessionClone()
    const result = await runIn(session, ['git pull --rebase', 'git log --oneline -1'], session)

    expect(result.outcomes[0]?.exitCode).toBe(0)
    expect(result.outcomes[0]?.output).toStartWith(RULE_MAP_SET_ASIDE_NOTE)
    expect(result.notRun).toEqual([])
    expect(batchFailed(result)).toBe(false)
    expect(git(session, ['log', '--format=%s']).split('\n')).toContain('readme')
  }, 60_000)

  test('a switch to a branch whose map differs runs after the set-aside', async () => {
    const session = await sessionClone()
    git(session, ['stash', '-q'])
    git(session, ['switch', '-q', '-c', 'other'])
    writeFileSync(join(session, '.claudin', 'rules', 'search-strategy.md'), 'another map\n')
    git(session, ['commit', '-qam', 'other map'])
    git(session, ['switch', '-q', '-'])
    git(session, ['stash', 'pop', '-q'])

    const result = await runIn(session, ['git switch other'], session)

    expect(result.outcomes[0]?.exitCode).toBe(0)
    expect(result.outcomes[0]?.output).toStartWith(RULE_MAP_SET_ASIDE_NOTE)
    expect(git(session, ['branch', '--show-current']).trim()).toBe('other')
  }, 60_000)

  test('without a map root the refusal stands', async () => {
    const session = await sessionClone()
    const result = await runIn(session, ['git pull --rebase'])

    expect(result.outcomes[0]?.exitCode).not.toBe(0)
    expect(result.outcomes[0]?.output).not.toContain(RULE_MAP_SET_ASIDE_NOTE)
    expect(batchFailed(result)).toBe(true)
  }, 60_000)

  test('a second dirty file keeps the refusal and the healed map', async () => {
    const session = await sessionClone()
    writeFileSync(join(session, 'src', 'core', 'f0.ts'), 'mine\n')
    const result = await runIn(session, ['git pull --rebase'], session)

    expect(result.outcomes[0]?.exitCode).not.toBe(0)
    expect(result.outcomes[0]?.output).not.toContain(RULE_MAP_SET_ASIDE_NOTE)
    expect(git(session, ['status', '--porcelain'])).toContain(' M .claudin/rules/search-strategy.md')
  }, 60_000)

  test('GitTool passes the project root only for a batch in the session checkout', () => {
    const src = readFileSync(new URL('./GitTool.ts', import.meta.url), 'utf8')
    expect(src).toContain('ruleMapRoot: input.cwd === undefined ? getProjectRoot() : undefined')
  })
})
