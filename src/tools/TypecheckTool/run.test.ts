import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resetBaselineDirectoryCacheForTesting } from './baseline.js'
import { formatCheckResult } from './budget.js'
import { fingerprintDiagnostic } from './fingerprint.js'
import { eraseCheckoutPath, runTypecheck, type RunOptions } from './run.js'

/**
 * These drive the orchestrator through REAL shell commands rather than a mocked
 * `exec`: the failure modes worth pinning here (a missing binary, a kill, a
 * capped stdout) are properties of the shell layer, and a mock would assert
 * only that this file agrees with itself. `mock.module` also leaks across files
 * in this suite.
 */

describe('eraseCheckoutPath', () => {
  const PROJECT = '/home/dev/project'
  // Where reconstruction puts its checkout — nested, so it CONTAINS the project
  // path. That is what makes order matter and what broke a first attempt at
  // this: substituting the project path first leaves the checkout's own suffix
  // behind, and 147 diagnostics went from agreeing to disagreeing.
  const CHECKOUT = `${PROJECT}/.claudin/cache/head-worktree`

  test('rewrites paths quoted inside messages, not only the file column', () => {
    // Measured at 38 diagnostics in this repo: each was reported as newly
    // introduced and the one it replaced as fixed, from an identical tree.
    const line = (root: string) =>
      `src/commands.ts(4,15): error TS7016: Could not find a declaration file for module './x.js'. '${root}/src/x.js' implicitly has an 'any' type.`
    expect(eraseCheckoutPath(line(CHECKOUT), CHECKOUT, PROJECT)).toBe(line(PROJECT))
  })

  test('leaves a message that already names the project alone', () => {
    // Dependencies resolve UPWARDS out of the checkout, so its output cites the
    // project's own node_modules verbatim. Those must not be touched twice.
    const line = `error TS2307: Cannot find module '${PROJECT}/node_modules/x/index.d.ts'.`
    expect(eraseCheckoutPath(line, CHECKOUT, PROJECT)).toBe(line)
  })

  test('makes the two runs agree on the fingerprint, which is the point', () => {
    const message = (root: string) => `'${root}/src/x.js' implicitly has an 'any' type.`
    const rebuilt = eraseCheckoutPath(message(CHECKOUT), CHECKOUT, PROJECT)
    const shape = { file: 'src/commands.ts', line: 4, column: 15, severity: 'error' } as const
    expect(fingerprintDiagnostic({ ...shape, code: 'TS7016', message: rebuilt }, PROJECT)).toBe(
      fingerprintDiagnostic({ ...shape, code: 'TS7016', message: message(PROJECT) }, PROJECT),
    )
  })
})

const roots: string[] = []

function sandbox(): string {
  // Deliberately NOT a git repo: baseline resolution then reports
  // `not-a-git-repo` and nothing is persisted, so these stay hermetic.
  const root = mkdtempSync(join(tmpdir(), 'claudin-typecheck-run-'))
  roots.push(root)
  resetBaselineDirectoryCacheForTesting()
  return root
}

function options(cwd: string, command: string, over: Partial<RunOptions> = {}): RunOptions {
  return {
    command,
    checker: 'tsc',
    cwd,
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    baselineMode: 'auto',
    severity: 'errors',
    alsoDetected: [],
    ...over,
  }
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('runTypecheck — the checker did not do its job', () => {
  test('a missing binary is degraded, never a clean bill of health', async () => {
    // The dangerous failure: exit 127 with no parseable output must not render
    // as "no diagnostics", which is what a naive `diagnostics.length === 0`
    // would say about a checker that never ran.
    const result = await runTypecheck(options(sandbox(), 'definitely-not-a-real-checker-xyz'))
    expect(result.degraded).toBe(true)
    expect(result.exitCode).toBe(127)
    expect(result.errors).toBeGreaterThan(0)
    expect(formatCheckResult(result)).toStartWith('⚠')
  })

  test('unreadable failing output keeps a raw tail instead of inventing positions', async () => {
    const result = await runTypecheck(
      options(sandbox(), 'echo "something went sideways"; exit 2'),
    )
    expect(result.degraded).toBe(true)
    expect(result.diagnostics).toEqual([])
    expect(result.stdoutTail).toContain('something went sideways')
  })

  test('a timeout reports the kill and records no baseline', async () => {
    // A timed-out run comes back as SIGTERM with `interrupted` false, and its
    // output is PARTIAL — baselining it would mark everything the checker never
    // printed as newly introduced on the next run.
    const result = await runTypecheck(
      options(sandbox(), 'echo "src/a.ts(1,1): error TS1: x."; sleep 5', { timeoutMs: 500 }),
    )
    expect(result.runError).toContain('did not finish within 500 ms')
    expect(result.baseline).toEqual({ kind: 'absent', reason: 'ignored' })
    expect(result.diagnostics).toEqual([])
  })

  test('the checker runs in the cwd it was handed, not the session shell one', async () => {
    // exec() has no cwd option: it runs in the session's persistent shell. That
    // matches getCwd() for a plain REPL turn, but a sub-agent under a cwd
    // override (worktree isolation) would check the MAIN checkout while filing
    // the results under the worktree's path.
    const cwd = sandbox()
    writeFileSync(join(cwd, 'only-here.txt'), 'src/a.ts(1,1): error TS9: ran in the right place.')
    const result = await runTypecheck(options(cwd, 'cat only-here.txt; exit 1'))
    expect(result.degraded).toBe(false)
    expect(result.diagnostics[0]?.message).toContain('right place')
  })

  test('a cwd that does not exist fails instead of checking somewhere else', async () => {
    const result = await runTypecheck(options('/nonexistent-directory-xyz', 'echo hi; exit 1'))
    expect(result.degraded).toBe(true)
    expect(result.stdoutTail).toContain('No such file or directory')
  })

  test('an MSBuild infrastructure failure is not reported as a type error', async () => {
    // Captured verbatim from `dotnet build --no-restore` on a project that was
    // never restored. It arrives in the exact shape of a compiler diagnostic,
    // positioned inside the .NET SDK — so without a guard the tool reports a
    // type error in a system file and, worse, BASELINES it.
    const netsdk1004 =
      "echo \"/usr/share/dotnet/sdk/9.0.316/Sdks/Microsoft.NET.Sdk/targets/Microsoft.PackageDependencyResolution.targets(266,5): error NETSDK1004: Assets file '/w/fresh/obj/project.assets.json' not found. Run a NuGet package restore to generate this file. [/w/fresh/fresh.csproj]\"; exit 1"
    const result = await runTypecheck(options(sandbox(), netsdk1004, { checker: 'dotnet' }))
    expect(result.diagnostics).toHaveLength(0)
    expect(result.runError).toContain('NETSDK1004')
    expect(formatCheckResult(result)).toContain('could not run')
  })

  test('a clean exit with no output is a pass, not a degraded run', async () => {
    const result = await runTypecheck(options(sandbox(), 'true'))
    expect(result.degraded).toBe(false)
    expect(result.errors).toBe(0)
    expect(formatCheckResult(result)).toStartWith('✓')
  })
})

describe('runTypecheck — output the shell had to spill to disk', () => {
  test('parses every diagnostic past the 30 000-char stdout cap', async () => {
    // `result.stdout` is capped at BASH_MAX_OUTPUT_LENGTH; a repo with a real
    // backlog prints far more. Reading only that would silently summarise the
    // project from its first few hundred lines.
    const emit = 'for i in $(seq 1 2000); do echo "src/f$i.ts(1,1): error TS2322: Bad $i."; done; exit 1'
    const result = await runTypecheck(options(sandbox(), emit))
    expect(result.degraded).toBe(false)
    expect(result.errors).toBe(2000)
  }, 30_000)

  test('a compound command survives the environment prefix', async () => {
    // An inline `A=1 B=2 cmd` prefix only composes with a SIMPLE command, so a
    // subshell or loop in a user-supplied `command` died on a bash syntax error
    // before the checker ever ran — and reported that as a degraded check.
    const result = await runTypecheck(
      options(sandbox(), '(echo "src/a.ts(1,1): error TS1: from a subshell."; exit 1)'),
    )
    expect(result.degraded).toBe(false)
    expect(result.errors).toBe(1)
  })
})

describe('runTypecheck — scoping and excerpts', () => {
  const emitTwo =
    'echo "src/keep/a.ts(1,1): error TS1: kept."; echo "src/other/b.ts(2,1): error TS2: elsewhere."; exit 1'

  test('a path filter scopes the counts AND says what it hid', async () => {
    const result = await runTypecheck(options(sandbox(), emitTwo, { pathFilter: 'src/keep' }))
    expect(result.errors).toBe(1)
    expect(result.hiddenByPathFilter).toBe(1)
    expect(formatCheckResult(result)).toContain('1 diagnostic elsewhere in the project is not counted')
  })

  test('several paths scope ONE call to everything a change touched', async () => {
    // The whole point: a turn editing three files should cost one check, not
    // three. Without the array form the model fires one call per file.
    const emitThree =
      'echo "src/money.ts(1,1): error TS1: a."; echo "src/receipt.ts(2,1): error TS2: b."; echo "src/legacy/old.ts(3,1): error TS3: backlog."; exit 1'
    const result = await runTypecheck(
      options(sandbox(), emitThree, { pathFilter: ['src/money.ts', 'src/receipt.ts'] }),
    )
    expect(result.errors).toBe(2)
    expect(result.hiddenByPathFilter).toBe(1)
    expect(formatCheckResult(result)).toContain('Scoped to src/money.ts, src/receipt.ts')
  })

  test('an empty path array means unscoped, not "hide everything"', async () => {
    // `path: []` filtering all diagnostics away would render as a clean project
    // — the exact false all-clear the hidden-count note exists to prevent.
    const result = await runTypecheck(options(sandbox(), emitTwo, { pathFilter: [] }))
    expect(result.errors).toBe(2)
    expect(result.hiddenByPathFilter).toBe(0)
  })

  test('a filter that matches nothing cannot read as a clean project', async () => {
    const result = await runTypecheck(options(sandbox(), emitTwo, { pathFilter: 'src/nowhere' }))
    expect(result.errors).toBe(0)
    const output = formatCheckResult(result)
    expect(output).toContain('2 diagnostics elsewhere in the project are not counted')
  })

  test('warnings are hidden by default but still counted against the baseline', async () => {
    const cwd = sandbox()
    const emit =
      'echo "src/a.ts(1,1): error TS1: an error."; echo "src/b.ts(1,1): warning TS2: a warning."; exit 1'
    const errorsOnly = await runTypecheck(options(cwd, emit))
    expect(errorsOnly.errors).toBe(1)
    expect(errorsOnly.warnings).toBe(0)

    const all = await runTypecheck(options(cwd, emit, { severity: 'all' }))
    expect(all.warnings).toBe(1)
  })

  test('a diagnostic pointing at a file that is not there yields no excerpt', async () => {
    // Checkers report generated and deleted files; opening one must not throw.
    const result = await runTypecheck(
      options(sandbox(), 'echo "src/vanished.ts(3,1): error TS1: gone."; exit 1'),
    )
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]?.excerpt).toBeUndefined()
  })

  test('attaches an excerpt when the file really is on disk', async () => {
    const cwd = sandbox()
    writeFileSync(join(cwd, 'a.ts'), 'const one = 1\nconst two = 2\nconst three = 3\n')
    const result = await runTypecheck(
      options(cwd, 'echo "a.ts(2,7): error TS1: bad name."; exit 1'),
    )
    expect(result.diagnostics[0]?.excerpt).toContain('const two = 2')
  })
})
