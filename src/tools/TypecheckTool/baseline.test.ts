import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  isWorkingTreeClean,
  resetBaselineDirectoryCacheForTesting,
  resolveBaseline,
} from 'src/tools/TypecheckTool/baseline.js'

const roots: string[] = []

/**
 * Hermetic on purpose. Inheriting the ambient environment makes these depend on
 * whatever the rest of the run did to it: one suite left `HOME` pointing at a
 * temp directory it had already deleted, and every `git commit` here then
 * exited 128 — only in a full-suite run, and with `stdio: 'ignore'` swallowing
 * the reason. The identity and config vars below make the outcome depend on
 * nothing but this repository.
 */
function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  })
}

/**
 * A committed `.gitignore` covering `.claudin/` matters: without it the cache
 * we are about to write leaves the tree permanently dirty, which is exactly
 * the state that blocks baseline capture.
 */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'claudin-typecheck-baseline-'))
  roots.push(root)
  writeFileSync(join(root, '.gitignore'), '.claudin/\n')
  writeFileSync(join(root, 'a.ts'), 'export const a = 1\n')
  git(root, ['init', '-q'])
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'init'])
  resetBaselineDirectoryCacheForTesting()
  return root
}

function commitChange(root: string, contents: string): void {
  writeFileSync(join(root, 'a.ts'), contents)
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'change'])
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('resolveBaseline', () => {
  test('a clean tree records the run as the project backlog', async () => {
    const cwd = repo()
    const outcome = await resolveBaseline({
      cwd,
      checker: 'tsc',
      mode: 'auto',
      fingerprints: ['a', 'b'],
    })
    expect(outcome.state.kind).toBe('captured')
    // Everything present at capture time is pre-existing by definition.
    expect(outcome.isNew).toEqual([false, false])
    expect(existsSync(join(cwd, '.claudin', 'cache', 'typecheck-baseline.json'))).toBe(true)
  })

  test('a later run at the same commit reports only what the baseline lacks', async () => {
    const cwd = repo()
    await resolveBaseline({ cwd, checker: 'tsc', mode: 'auto', fingerprints: ['a', 'b'] })

    writeFileSync(join(cwd, 'a.ts'), 'export const a = "broken"\n')
    const outcome = await resolveBaseline({
      cwd,
      checker: 'tsc',
      mode: 'auto',
      fingerprints: ['a', 'b', 'c'],
    })
    expect(outcome.state).toEqual({ kind: 'matched', sha: expect.any(String) })
    expect(outcome.isNew).toEqual([false, false, true])
    expect(outcome.fixedCount).toBe(0)
  })

  test('counts baselined diagnostics that stopped reproducing', async () => {
    const cwd = repo()
    await resolveBaseline({ cwd, checker: 'tsc', mode: 'auto', fingerprints: ['a', 'b'] })
    writeFileSync(join(cwd, 'a.ts'), 'export const a = 2\n')
    const outcome = await resolveBaseline({
      cwd,
      checker: 'tsc',
      mode: 'auto',
      fingerprints: ['a'],
    })
    expect(outcome.fixedCount).toBe(1)
  })

  test('a dirty tree with no baseline for this commit admits it knows nothing', async () => {
    const cwd = repo()
    writeFileSync(join(cwd, 'a.ts'), 'export const a = "dirty"\n')
    const outcome = await resolveBaseline({
      cwd,
      checker: 'tsc',
      mode: 'auto',
      fingerprints: ['a'],
    })
    expect(outcome.state).toEqual({ kind: 'absent', reason: 'dirty-tree-no-baseline' })
    expect(outcome.isNew).toEqual([true])
  })

  test('reconstruction checks HEAD, never the dirty tree it was called from', async () => {
    // The whole point: the first check of a session cannot record a baseline
    // because the session already edited. Checking out HEAD elsewhere answers
    // the question without a stash and without touching the user's tree.
    const cwd = repo()
    writeFileSync(join(cwd, 'a.ts'), 'export const a = "dirty"\n')
    let seen = ''
    const outcome = await resolveBaseline({
      cwd,
      checker: 'tsc',
      mode: 'auto',
      fingerprints: ['old', 'mine'],
      reconstruct: async dir => {
        seen = readFileSync(join(dir, 'a.ts'), 'utf8')
        return ['old']
      },
    })

    expect(seen).toBe('export const a = 1\n')
    expect(readFileSync(join(cwd, 'a.ts'), 'utf8')).toBe('export const a = "dirty"\n')
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
    expect(outcome.state).toEqual({ kind: 'reconstructed', sha: head, recordedCount: 1 })
    expect(outcome.isNew).toEqual([false, true])
  })

  test('a reconstructed baseline is persisted, so only the first call pays for it', async () => {
    const cwd = repo()
    writeFileSync(join(cwd, 'a.ts'), 'export const a = "dirty"\n')
    let runs = 0
    const opts = {
      cwd,
      checker: 'tsc' as const,
      mode: 'auto' as const,
      fingerprints: ['old', 'mine'],
      reconstruct: async () => {
        runs++
        return ['old']
      },
    }
    await resolveBaseline(opts)
    const second = await resolveBaseline(opts)

    expect(runs).toBe(1)
    expect(second.state.kind).toBe('matched')
    expect(second.isNew).toEqual([false, true])
  })

  test('the worktree is removed and leaves no registration behind', async () => {
    const cwd = repo()
    writeFileSync(join(cwd, 'a.ts'), 'export const a = "dirty"\n')
    let dir = ''
    await resolveBaseline({
      cwd,
      checker: 'tsc',
      mode: 'auto',
      fingerprints: ['old'],
      reconstruct: async d => {
        dir = d
        return ['old']
      },
    })

    expect(dir).not.toBe('')
    expect(existsSync(dir)).toBe(false)
    const list = execFileSync('git', ['worktree', 'list'], { cwd, encoding: 'utf8' })
    expect(list).not.toContain('head-worktree')
  })

  test('a reconstruction that describes a different project is discarded', async () => {
    // A worktree where the checker cannot resolve dependencies does not fail —
    // `tsc` without node_modules reports thousands of "cannot find module"
    // errors. Recording those would bury the real backlog, so a reconstruction
    // that barely overlaps the live run is refused.
    const cwd = repo()
    writeFileSync(join(cwd, 'a.ts'), 'export const a = "dirty"\n')
    const outcome = await resolveBaseline({
      cwd,
      checker: 'tsc',
      mode: 'auto',
      fingerprints: ['real1', 'real2'],
      reconstruct: async () => ['noise1', 'noise2', 'noise3', 'real1'],
    })

    expect(outcome.state).toEqual({ kind: 'absent', reason: 'dirty-tree-no-baseline' })
    expect(existsSync(join(cwd, '.claudin', 'cache', 'typecheck-baseline.json'))).toBe(false)
  })

  test('a clean HEAD reconstructs as an empty baseline rather than being refused', async () => {
    // Zero diagnostics at HEAD is a perfectly good backlog and the overlap test
    // cannot apply to it — everything the live run reports really is new.
    const cwd = repo()
    writeFileSync(join(cwd, 'a.ts'), 'export const a = "dirty"\n')
    const outcome = await resolveBaseline({
      cwd,
      checker: 'tsc',
      mode: 'auto',
      fingerprints: ['mine'],
      reconstruct: async () => [],
    })

    expect(outcome.state.kind).toBe('reconstructed')
    expect(outcome.isNew).toEqual([true])
  })

  test('an unusable reconstruction falls through to the older behaviour', async () => {
    const cwd = repo()
    await resolveBaseline({ cwd, checker: 'tsc', mode: 'auto', fingerprints: ['a'] })
    commitChange(cwd, 'export const a = 2\n')
    writeFileSync(join(cwd, 'a.ts'), 'export const a = "uncommitted"\n')

    const outcome = await resolveBaseline({
      cwd,
      checker: 'tsc',
      mode: 'auto',
      fingerprints: ['a', 'b'],
      reconstruct: async () => null,
    })
    expect(outcome.state.kind).toBe('inherited')
  })

  test('reconstruction wins over inheriting, being exact for HEAD', async () => {
    const cwd = repo()
    await resolveBaseline({ cwd, checker: 'tsc', mode: 'auto', fingerprints: ['a'] })
    commitChange(cwd, 'export const a = 2\n')
    writeFileSync(join(cwd, 'a.ts'), 'export const a = "uncommitted"\n')

    const outcome = await resolveBaseline({
      cwd,
      checker: 'tsc',
      mode: 'auto',
      fingerprints: ['a', 'fromcommit', 'mine'],
      reconstruct: async () => ['a', 'fromcommit'],
    })
    expect(outcome.state.kind).toBe('reconstructed')
    // The commit's own error lands in the backlog where it belongs, instead of
    // being blamed on the uncommitted work as an inherited baseline would.
    expect(outcome.isNew).toEqual([false, false, true])
  })

  test('the killswitch stops the extra checkout entirely', async () => {
    const cwd = repo()
    writeFileSync(join(cwd, 'a.ts'), 'export const a = "dirty"\n')
    process.env.CLAUDIN_DISABLE_TYPECHECK_WORKTREE = '1'
    try {
      let called = false
      const outcome = await resolveBaseline({
        cwd,
        checker: 'tsc',
        mode: 'auto',
        fingerprints: ['a'],
        reconstruct: async () => {
          called = true
          return ['a']
        },
      })
      expect(called).toBe(false)
      expect(outcome.state).toEqual({ kind: 'absent', reason: 'dirty-tree-no-baseline' })
    } finally {
      delete process.env.CLAUDIN_DISABLE_TYPECHECK_WORKTREE
    }
  })

  test('a dirty tree inherits the baseline from an earlier commit', async () => {
    // The first check of a session edits before it checks, so the tree is dirty
    // and no baseline for HEAD can be recorded. Giving up here is what made the
    // tool useless exactly when it is first reached for.
    const cwd = repo()
    await resolveBaseline({ cwd, checker: 'tsc', mode: 'auto', fingerprints: ['a', 'b'] })
    const captured = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
    commitChange(cwd, 'export const a = 2\n')
    writeFileSync(join(cwd, 'a.ts'), 'export const a = "uncommitted"\n')

    const outcome = await resolveBaseline({
      cwd,
      checker: 'tsc',
      mode: 'auto',
      fingerprints: ['a', 'b', 'c'],
    })
    expect(outcome.state).toEqual({ kind: 'inherited', sha: captured, behind: 1 })
    expect(outcome.isNew).toEqual([false, false, true])
  })

  test('inheriting records nothing — a dirty tree must not become a baseline', async () => {
    const cwd = repo()
    await resolveBaseline({ cwd, checker: 'tsc', mode: 'auto', fingerprints: ['a'] })
    commitChange(cwd, 'export const a = 2\n')
    writeFileSync(join(cwd, 'a.ts'), 'export const a = "uncommitted"\n')
    await resolveBaseline({ cwd, checker: 'tsc', mode: 'auto', fingerprints: ['a', 'b'] })

    // Still the ORIGINAL two entries at the original commit: had the dirty run
    // been recorded, 'b' would now be backlog and never reported again.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
    const file = JSON.parse(
      readFileSync(join(cwd, '.claudin', 'cache', 'typecheck-baseline.json'), 'utf8'),
    ) as { checkers: Record<string, { sha: string; fingerprints: string[] }> }
    expect(file.checkers.tsc?.fingerprints).toEqual(['a'])
    expect(file.checkers.tsc?.sha).not.toBe(head)
  })

  test('a baseline from another line of work is refused, not borrowed', async () => {
    // After a branch switch the recorded sha describes unrelated code. Counting
    // this run against it would label its diagnostics with someone else's
    // backlog — worse than admitting provenance is unknown.
    const cwd = repo()
    await resolveBaseline({ cwd, checker: 'tsc', mode: 'auto', fingerprints: ['a'] })
    git(cwd, ['checkout', '-q', '--orphan', 'unrelated'])
    git(cwd, ['commit', '-qm', 'unrelated root'])
    writeFileSync(join(cwd, 'a.ts'), 'export const a = "dirty"\n')

    const outcome = await resolveBaseline({
      cwd,
      checker: 'tsc',
      mode: 'auto',
      fingerprints: ['a', 'b'],
    })
    expect(outcome.state).toEqual({ kind: 'absent', reason: 'dirty-tree-no-baseline' })
    expect(outcome.isNew).toEqual([true, true])
  })

  test('a baseline whose commit no longer exists degrades instead of throwing', async () => {
    const cwd = repo()
    await resolveBaseline({ cwd, checker: 'tsc', mode: 'auto', fingerprints: ['a'] })
    const path = join(cwd, '.claudin', 'cache', 'typecheck-baseline.json')
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        checkers: { tsc: { sha: 'f'.repeat(40), capturedAt: '', fingerprints: ['a'] } },
      }),
    )
    writeFileSync(join(cwd, 'a.ts'), 'export const a = "dirty"\n')

    const outcome = await resolveBaseline({ cwd, checker: 'tsc', mode: 'auto', fingerprints: ['a'] })
    expect(outcome.state).toEqual({ kind: 'absent', reason: 'dirty-tree-no-baseline' })
  })

  test('a commit that adds errors is reported, not laundered into the backlog', async () => {
    // Commit broken code on a clean tree and the new errors would otherwise
    // become "pre-existing" and be hidden forever.
    const cwd = repo()
    await resolveBaseline({ cwd, checker: 'tsc', mode: 'auto', fingerprints: ['a'] })
    commitChange(cwd, 'export const a = "broken"\n')

    const outcome = await resolveBaseline({
      cwd,
      checker: 'tsc',
      mode: 'auto',
      fingerprints: ['a', 'b', 'c'],
    })
    expect(outcome.state.kind).toBe('captured')
    expect(outcome.state).toMatchObject({
      introducedSincePrev: { count: 2, prevSha: expect.any(String) },
    })
  })

  test('baselines are per checker, so one does not clobber the other', async () => {
    const cwd = repo()
    await resolveBaseline({ cwd, checker: 'tsc', mode: 'auto', fingerprints: ['ts1'] })
    await resolveBaseline({ cwd, checker: 'cargo', mode: 'auto', fingerprints: ['rs1'] })

    writeFileSync(join(cwd, 'a.ts'), 'export const a = 3\n')
    const outcome = await resolveBaseline({
      cwd,
      checker: 'tsc',
      mode: 'auto',
      fingerprints: ['ts1'],
    })
    expect(outcome.state.kind).toBe('matched')
    expect(outcome.isNew).toEqual([false])
  })

  test('mode "ignore" reports everything and records nothing', async () => {
    const cwd = repo()
    const outcome = await resolveBaseline({
      cwd,
      checker: 'tsc',
      mode: 'ignore',
      fingerprints: ['a', 'b'],
    })
    expect(outcome.state).toEqual({ kind: 'absent', reason: 'ignored' })
    expect(outcome.isNew).toEqual([true, true])
    expect(existsSync(join(cwd, '.claudin', 'cache', 'typecheck-baseline.json'))).toBe(false)
  })

  test('mode "capture" is refused on a dirty tree instead of laundering the run', async () => {
    // A baseline is keyed to HEAD's sha, so capturing from a dirty tree files
    // the errors in the uncommitted work under that commit and calls them
    // pre-existing forever after — an agent silencing its own breakage with one
    // argument. This used to be allowed outright.
    const cwd = repo()
    writeFileSync(join(cwd, 'a.ts'), 'export const a = "dirty"\n')
    const outcome = await resolveBaseline({
      cwd,
      checker: 'tsc',
      mode: 'capture',
      fingerprints: ['a'],
    })
    expect(outcome.state).toEqual({ kind: 'absent', reason: 'dirty-tree-no-baseline' })
    expect(outcome.captureRefused).toBe(true)
    expect(outcome.isNew).toEqual([true])
    expect(existsSync(join(cwd, '.claudin', 'cache', 'typecheck-baseline.json'))).toBe(false)
  })

  test('a refused capture still answers with the best baseline available', async () => {
    // Degrading to `auto` rather than failing: the caller asked a real question
    // and an inherited baseline answers it, refusal or not.
    const cwd = repo()
    await resolveBaseline({ cwd, checker: 'tsc', mode: 'auto', fingerprints: ['a'] })
    commitChange(cwd, 'export const a = 2\n')
    writeFileSync(join(cwd, 'a.ts'), 'export const a = "uncommitted"\n')

    const outcome = await resolveBaseline({
      cwd,
      checker: 'tsc',
      mode: 'capture',
      fingerprints: ['a', 'b'],
    })
    expect(outcome.state.kind).toBe('inherited')
    expect(outcome.captureRefused).toBe(true)
    expect(outcome.isNew).toEqual([false, true])
  })

  test('mode "capture" on a clean tree still overrides the same-commit guard', async () => {
    const cwd = repo()
    await resolveBaseline({ cwd, checker: 'tsc', mode: 'auto', fingerprints: ['a'] })
    const outcome = await resolveBaseline({
      cwd,
      checker: 'tsc',
      mode: 'capture',
      fingerprints: ['a', 'b'],
    })
    expect(outcome.state.kind).toBe('captured')
    expect(outcome.isNew).toEqual([false, false])
  })

  test('a re-capture at the same commit says what it absorbed', async () => {
    // Without this the only two guards both stay silent — the same-sha branch is
    // skipped for `capture`, and the delta report used to require a DIFFERENT
    // sha — so a forced re-capture swallowed new diagnostics without a word.
    const cwd = repo()
    await resolveBaseline({ cwd, checker: 'tsc', mode: 'auto', fingerprints: ['a'] })
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()

    const outcome = await resolveBaseline({
      cwd,
      checker: 'tsc',
      mode: 'capture',
      fingerprints: ['a', 'b', 'c'],
    })
    expect(outcome.state).toEqual({
      kind: 'captured',
      sha: head,
      recordedCount: 3,
      introducedSincePrev: { count: 2, prevSha: head },
    })
  })

  test('outside a git repository there is nothing to key a baseline to', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'claudin-typecheck-nogit-'))
    roots.push(cwd)
    resetBaselineDirectoryCacheForTesting()
    const outcome = await resolveBaseline({
      cwd,
      checker: 'tsc',
      mode: 'auto',
      fingerprints: ['a'],
    })
    expect(outcome.state).toEqual({ kind: 'absent', reason: 'not-a-git-repo' })
  })
})

describe('resolveBaseline — a cache file that cannot be trusted', () => {
  function cacheFile(cwd: string, contents: string): string {
    const dir = join(cwd, '.claudin', 'cache')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'typecheck-baseline.json')
    writeFileSync(path, contents)
    return path
  }
  const capture = (cwd: string) =>
    resolveBaseline({ cwd, checker: 'tsc', mode: 'auto', fingerprints: ['a'] })

  test('truncated JSON is treated as a first run, not an error', async () => {
    // The cache is disposable state; a half-written file must degrade to
    // "record it again", never to a failed check.
    const cwd = repo()
    cacheFile(cwd, '{"version":1,"checkers":{"tsc":{"sha":"abc"')
    expect((await capture(cwd)).state.kind).toBe('captured')
  })

  test('a baseline from a future schema version is discarded', async () => {
    const cwd = repo()
    cacheFile(cwd, JSON.stringify({ version: 99, checkers: { tsc: { sha: 'abc', fingerprints: ['a'] } } }))
    const outcome = await capture(cwd)
    expect(outcome.state.kind).toBe('captured')
    // Not read as a match against the stale entry.
    expect(outcome.isNew).toEqual([false])
  })

  test('JSON of the wrong shape is discarded rather than trusted', async () => {
    const cwd = repo()
    cacheFile(cwd, JSON.stringify({ version: 1, checkers: 'not an object' }))
    expect((await capture(cwd)).state.kind).toBe('captured')
  })

  test('a cache directory that cannot be written still completes the check', async () => {
    const cwd = repo()
    const dir = join(cwd, '.claudin', 'cache')
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o500)
    try {
      expect((await capture(cwd)).state.kind).toBe('captured')
    } finally {
      chmodSync(dir, 0o700)
    }
  })
})

describe('isWorkingTreeClean', () => {
  test('agent scratch under .claudin does not count as project churn', async () => {
    // Nothing under .claudin changes what a compiler reports, and counting it
    // would block capture for a reason unrelated to the code being checked.
    const cwd = repo()
    rmSync(join(cwd, '.gitignore'))
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-qm', 'drop ignore'])
    writeFileSync(join(cwd, 'a.ts'), 'export const a = 1\n')

    expect(await isWorkingTreeClean(cwd)).toBe(true)

    const { mkdirSync } = await import('fs')
    mkdirSync(join(cwd, '.claudin'), { recursive: true })
    writeFileSync(join(cwd, '.claudin', 'scratch.md'), 'notes')
    expect(await isWorkingTreeClean(cwd)).toBe(true)

    writeFileSync(join(cwd, 'a.ts'), 'export const a = 2\n')
    expect(await isWorkingTreeClean(cwd)).toBe(false)
  })

  test('returns null outside a git repository', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'claudin-typecheck-nogit2-'))
    roots.push(cwd)
    expect(await isWorkingTreeClean(cwd)).toBeNull()
  })
})
