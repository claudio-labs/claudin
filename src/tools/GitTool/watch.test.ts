import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { invalidateSessionEnvCache } from 'src/sessions/sessionEnvironment.js'
import {
  cleanupAllFakeGh,
  type FakeGh,
  GH_NOT_AUTHENTICATED,
  installFakeGh,
} from 'src/tools/GitTool/__fixtures__/fakeGh.js'
import { GitTool } from 'src/tools/GitTool/GitTool.js'
import { batchFailed, formatGitBatchResult, runGitBatch, type RunGitBatchOptions } from 'src/tools/GitTool/run.js'
import type { GitProgress } from 'src/tools/GitTool/types.js'

/**
 * The watch lane, driven by the fake `gh`.
 *
 * A real watch needs a run in flight, which a test cannot arrange, and what is
 * worth pinning here is how this tool reacts to a command that is STOPPED
 * rather than what `gh` prints while it runs: the ceiling, the idle watchdog,
 * `gh pr checks`' exit 8, and the output cap. The fake reproduces each of those
 * shapes exactly; the FORMAT is pinned separately, against captured bytes, in
 * `parsers/watch.test.ts`.
 *
 * Getting the fake onto the child's PATH takes `CLAUDIN_ENV_FILE` and not just
 * `process.env.PATH` — see the long note in `families.test.ts`. Skipping it is
 * not a failing test, it is a test that silently runs REAL `gh` against this
 * repository: that is exactly what happened here first, and `gh pr checks 1`
 * quietly answered with PR #1's real checks.
 */

const POLL = 'CI\tpending\t0\thttps://example.test/1\t\n'
const FINAL = 'CI\tpass\t9m9s\thttps://example.test/FINAL\t\n'

let fakeGh: FakeGh
let originalPath: string | undefined
let originalEnvFile: string | undefined

beforeAll(() => {
  fakeGh = installFakeGh()
  const envFile = join(fakeGh.binDir, 'env.sh')
  writeFileSync(envFile, `export PATH="${fakeGh.binDir}:$PATH"\n`)
  originalPath = process.env.PATH
  originalEnvFile = process.env.CLAUDIN_ENV_FILE
  process.env.PATH = fakeGh.path
  process.env.CLAUDIN_ENV_FILE = envFile
  invalidateSessionEnvCache()
})

afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  // Leaving CLAUDIN_ENV_FILE set would prepend this directory to every shell
  // command in every later test file of the same process.
  if (originalEnvFile === undefined) delete process.env.CLAUDIN_ENV_FILE
  else process.env.CLAUDIN_ENV_FILE = originalEnvFile
  invalidateSessionEnvCache()
  cleanupAllFakeGh()
})

function run(
  commands: string[],
  extra: Partial<Omit<RunGitBatchOptions, 'commands'>> = {},
) {
  return runGitBatch({
    commands,
    abortSignal: new AbortController().signal,
    ...extra,
  })
}

/** One refresh, then alive and silent for a minute: it can only be stopped. */
function neverFinishes(): void {
  fakeGh.setRules([{ match: 'pr checks', stdout: POLL, holdMs: 60_000 }])
}

describe('a watch that runs out of time', () => {
  test('reports a ceiling stall instead of a failure', async () => {
    neverFinishes()
    const result = await run(['gh pr checks 1 --watch'], { timeoutMs: 1_500 })
    const outcome = result.outcomes[0]
    expect(outcome?.stall?.reason).toBe('ceiling')
    // SIGTERM, and NOT an interruption: the user did not abort anything.
    expect(outcome?.exitCode).toBe(143)
    expect(outcome?.interrupted).toBe(false)
    expect(batchFailed(result)).toBe(false)
  }, 30_000)

  test('the text says it is still running and how to continue', async () => {
    neverFinishes()
    const result = await run(['gh pr checks 1 --watch'], { timeoutMs: 1_500 })
    const text = formatGitBatchResult(result)
    expect(text).toContain('Still running after')
    expect(text).toContain('Re-run to keep watching')
    // The failure wording for the same exit code must not appear.
    expect(text).not.toContain('Exit code 143')
  }, 30_000)

  test('an ordinary command that hits the ceiling IS a failure', async () => {
    // No `--watch`, so nothing forgives the 143 — and `errors.ts` explains it
    // instead of leaving the model with a bare exit code.
    fakeGh.setRules([{ match: 'pr view', stdout: POLL, holdMs: 60_000 }])
    const result = await run(['gh pr view 1'], { timeoutMs: 1_500 })
    expect(result.outcomes[0]?.stall).toBeUndefined()
    expect(batchFailed(result)).toBe(true)
    expect(formatGitBatchResult(result)).toContain('timeout stopped it')
  }, 30_000)
})

describe('a watch that goes quiet', () => {
  test('is stopped by the idle watchdog, keeping what it printed', async () => {
    neverFinishes()
    const result = await run(['gh pr checks 2 --watch'], {
      timeoutMs: 30_000,
      idleTimeoutMs: 1_200,
    })
    const outcome = result.outcomes[0]
    expect(outcome?.stall?.reason).toBe('idle')
    expect(outcome?.stall?.silentMs).toBeGreaterThanOrEqual(1_200)
    // Well under the 30s ceiling: the watchdog is what ended it.
    expect(outcome?.stall?.ranMs).toBeLessThan(15_000)
    expect(outcome?.output).toContain('pending')
    expect(batchFailed(result)).toBe(false)
    expect(formatGitBatchResult(result)).toContain('No new output for')
  }, 30_000)

  test('an ordinary git command gets no watchdog, however quiet', async () => {
    // Same threshold, no `--watch`: this must run to completion instead of
    // being cut off, which is why the watchdog is not global.
    const result = await run(['git --version'], { idleTimeoutMs: 1 })
    expect(result.outcomes[0]?.stall).toBeUndefined()
    expect(result.outcomes[0]?.exitCode).toBe(0)
  }, 30_000)
})

describe('`gh pr checks` exit 8', () => {
  test('is pending, not a failure', async () => {
    fakeGh.setRules([{ match: 'pr checks', stdout: POLL, exitCode: 8 }])
    const result = await run(['gh pr checks 3'])
    const outcome = result.outcomes[0]
    expect(outcome?.exitCode).toBe(8)
    expect(outcome?.stall?.reason).toBe('pending')
    expect(batchFailed(result)).toBe(false)
    expect(formatGitBatchResult(result)).toContain('still pending')
  }, 30_000)

  test('does not stop the rest of the batch', async () => {
    fakeGh.setRules([{ match: 'pr checks', stdout: POLL, exitCode: 8 }])
    const result = await run(['gh pr checks 3', 'git --version'])
    expect(result.outcomes).toHaveLength(2)
    expect(result.notRun).toEqual([])
    expect(result.outcomes[1]?.exitCode).toBe(0)
  }, 30_000)

  test('a real gh failure still stops a write behind it', async () => {
    // Exit 1 from the fake's loud fallback: only exit 8 is forgiven, and only
    // for `pr checks`. A write after it must not run — reads would.
    fakeGh.setRules([])
    const result = await run(['gh pr view 9', 'gh pr comment 9 --body x'])
    expect(result.outcomes[0]?.stall).toBeUndefined()
    expect(result.notRun).toEqual(['gh pr comment 9 --body x'])
    expect(batchFailed(result)).toBe(true)
  }, 30_000)

  test('a failing check does not cost the read behind it', async () => {
    // `gh pr checks` exits 1 when a check failed; the census saw that stop the
    // `gh run list` asked for in the same call.
    fakeGh.setRules([
      { match: 'pr checks', stdout: 'smoke-and-tests\tfail\t32s\thttps://github.com/o/r/actions/runs/7/job/8\t\n', exitCode: 1 },
      { match: 'run list', stdout: 'completed\tfailure\tci\tmain\n' },
    ])
    const result = await run(['gh pr checks 4', 'gh run list --limit 1'])
    expect(result.outcomes).toHaveLength(2)
    expect(result.notRun).toEqual([])
    expect(result.outcomes[1]?.output).toContain('completed')
  }, 30_000)

  test('a failing check is the answer, not an error', async () => {
    // What the model asked was the state of CI; the 2026-10-16..19 census saw
    // four of these marked `is_error`.
    fakeGh.setRules([
      { match: 'pr checks', stdout: 'smoke-and-tests\tfail\t32s\thttps://github.com/o/r/actions/runs/7/job/8\t\n', exitCode: 1 },
    ])
    const result = await run(['gh pr checks 4', 'git --version'])
    expect(result.outcomes[0]?.answer).toContain('1 check failed: smoke-and-tests')
    expect(batchFailed(result)).toBe(false)
    const text = formatGitBatchResult(result)
    expect(text).toContain('smoke-and-tests\tfail')
    expect(text).toContain('`gh run view 7 --log-failed`')
    expect(text).not.toContain('Exit code 1')
  }, 30_000)

  test('a failing check still stops a write behind it', async () => {
    // An answer, but not a green light: `["gh pr checks 4", "gh pr merge 4"]`
    // must not merge a PR whose CI just failed, as it did not when this exit
    // was an error.
    fakeGh.setRules([
      { match: 'pr checks', stdout: 'smoke-and-tests\tfail\t32s\thttps://github.com/o/r/actions/runs/7/job/8\t\n', exitCode: 1 },
      { match: 'pr merge', stdout: 'Merged pull request #4\n' },
    ])
    const result = await run(['gh pr checks 4', 'gh pr merge 4 --squash'])
    expect(result.outcomes[0]?.answer).toContain('1 check failed')
    expect(result.notRun).toEqual(['gh pr merge 4 --squash'])
  }, 30_000)

  test('no checks yet stops a write behind it too', async () => {
    fakeGh.setRules([
      { match: 'pr checks', stderr: "no checks reported on the 'feat/x' branch\n", exitCode: 1 },
      { match: 'pr merge', stdout: 'Merged pull request #4\n' },
    ])
    const result = await run(['gh pr checks 4', 'gh pr merge 4 --squash'])
    expect(result.outcomes[0]?.answer).toContain('No checks are registered')
    expect(result.notRun).toEqual(['gh pr merge 4 --squash'])
  }, 30_000)

  test('a signed-out gh stops the reads behind it, which would only fail the same way', async () => {
    fakeGh.setRules([{ ...GH_NOT_AUTHENTICATED, match: 'pr' }])
    const result = await run(['gh pr view 9', 'gh pr list'])
    expect(result.notRun).toEqual(['gh pr list'])
  }, 30_000)
})

/** What `gh pr checks` prints before GitHub has registered a push's workflow runs. */
const NO_CHECKS = { match: 'pr checks', stderr: "no checks reported on the 'feat/x' branch\n", exitCode: 1 }

/**
 * The `gh pr checks` calls for PR 5. Counted by number: a `gh` spawned just
 * before an abort can boot, and log itself, after its batch returned — on a
 * slow runner, after the next test's clearInvocations(). The abort test uses
 * PR 13 so its straggler never lands in this count.
 */
function checksCalls(): number {
  return fakeGh.invocations().filter(argv => argv[0] === 'pr' && argv[1] === 'checks' && argv[2] === '5').length
}

describe('`gh pr checks` before the checks exist', () => {
  test('a watch waits for checks that appear after the push', async () => {
    // The census saw this twice, each time followed by a `sleep 30` or a
    // hand-rolled WaitFor and a second watch.
    fakeGh.clearInvocations()
    fakeGh.setRules([{ ...NO_CHECKS, times: 2 }, { match: 'pr checks', stdout: FINAL }])
    const result = await run(['gh pr checks 5 --watch'], { noChecksGraceMs: 10_000, noChecksRetryMs: 100 })
    expect(result.outcomes[0]?.exitCode).toBe(0)
    expect(result.outcomes[0]?.output).toContain('FINAL')
    expect(checksCalls()).toBe(3)
  }, 30_000)

  test('a watch whose checks never appear returns after the grace, with the reason', async () => {
    fakeGh.clearInvocations()
    fakeGh.setRules([NO_CHECKS])
    const startedAt = Date.now()
    const result = await run(['gh pr checks 5 --watch'], { noChecksGraceMs: 1_000, noChecksRetryMs: 200 })
    expect(Date.now() - startedAt).toBeLessThan(10_000)
    expect(checksCalls()).toBeGreaterThan(1)
    // Waiting longer would not change it: no workflow runs on the branch.
    expect(batchFailed(result)).toBe(false)
    expect(result.outcomes[0]?.answer).toContain('No checks are registered for this branch yet')
    expect(formatGitBatchResult(result)).toContain('No checks are registered for this branch yet')
  }, 30_000)

  test('an abort ends the wait, and reports as one', async () => {
    fakeGh.setRules([NO_CHECKS])
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const startedAt = Date.now()
    const result = await runGitBatch({
      commands: ['gh pr checks 13 --watch', 'gh pr view 13'],
      abortSignal: controller.signal,
      noChecksGraceMs: 30_000,
      noChecksRetryMs: 10_000,
    })
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    // Not the last "no checks" answer: an Esc, which stops the read behind it.
    expect(result.outcomes[0]?.interrupted).toBe(true)
    expect(result.notRun).toEqual(['gh pr view 13'])
  }, 30_000)

  test('without --watch it answers at once, with the reason', async () => {
    fakeGh.clearInvocations()
    fakeGh.setRules([NO_CHECKS])
    const result = await run(['gh pr checks 5'], { noChecksGraceMs: 10_000, noChecksRetryMs: 100 })
    expect(checksCalls()).toBe(1)
    expect(batchFailed(result)).toBe(false)
    expect(formatGitBatchResult(result)).toContain('No checks are registered for this branch yet')
  }, 30_000)
})

describe('a watch that outran the stdout cap', () => {
  test('still comes back with its LAST refresh', async () => {
    // `result.stdout` keeps the FIRST 30k chars, which for a watch is every
    // refresh except the one that matters. This is the whole reason the watch
    // lane reads the output file instead.
    // Comfortably past BASH_MAX_OUTPUT_LENGTH (30k): at ~38 chars a refresh,
    // 1200 of them is ~46k, so the final line lands well outside the cap.
    const refreshes = POLL.repeat(1_200)
    expect(refreshes.length).toBeGreaterThan(40_000)
    fakeGh.setRules([{ match: 'pr checks', stdout: `${refreshes}${FINAL}` }])
    const result = await run(['gh pr checks 4 --watch'], { timeoutMs: 30_000 })
    const outcome = result.outcomes[0]
    expect(outcome?.exitCode).toBe(0)
    expect(outcome?.output).toContain('FINAL')
    // And the 1200 refreshes before it do not come along with it.
    expect(outcome?.output.length).toBeLessThan(2_000)
  }, 60_000)
})

describe('progress', () => {
  test('ticks while a command runs, naming its place in the batch', async () => {
    neverFinishes()
    const seen: GitProgress[] = []
    await runGitBatch({
      commands: ['gh pr checks 1 --watch', 'git --version'],
      abortSignal: new AbortController().signal,
      timeoutMs: 2_500,
      onProgress: p => seen.push(p),
    })
    expect(seen.length).toBeGreaterThan(0)
    const first = seen[0] as GitProgress
    expect(first.type).toBe('git_progress')
    expect(first.command).toBe('gh pr checks 1 --watch')
    expect(first.index).toBe(1)
    expect(first.total).toBe(2)
    expect(seen.at(-1)?.elapsedMs).toBeGreaterThan(0)
  }, 30_000)
})

describe('the output schema keeps the stall', () => {
  test('keeps a stalled outcome through a parse', () => {
    // The assertion is on the parsed VALUE, not on `success`: `z.object` strips
    // what it does not declare and still succeeds, so a schema missing `stall`
    // would pass a success check while handing the renderer an undefined — and
    // the row would wear a ✗ it did not earn.
    const parsed = GitTool.outputSchema.safeParse({
      outcomes: [
        {
          command: 'gh pr checks --watch',
          effectiveCommand: 'gh pr checks --watch',
          exitCode: 143,
          output: POLL,
          interrupted: false,
          stall: { reason: 'ceiling', ranMs: 600_000, silentMs: 0 },
        },
      ],
      notRun: [],
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.outcomes[0]?.stall).toEqual({
      reason: 'ceiling',
      ranMs: 600_000,
      silentMs: 0,
    })
  })
})
