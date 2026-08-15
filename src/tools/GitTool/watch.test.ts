import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { invalidateSessionEnvCache } from 'src/sessions/sessionEnvironment.js'
import { cleanupAllFakeGh, type FakeGh, installFakeGh } from 'src/tools/GitTool/__fixtures__/fakeGh.js'
import { GitTool } from 'src/tools/GitTool/GitTool.js'
import { batchFailed, formatGitBatchResult, runGitBatch } from 'src/tools/GitTool/run.js'
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
 * Getting the fake onto the child's PATH takes `CLAUDE_ENV_FILE` and not just
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
  originalEnvFile = process.env.CLAUDE_ENV_FILE
  process.env.PATH = fakeGh.path
  process.env.CLAUDE_ENV_FILE = envFile
  invalidateSessionEnvCache()
})

afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  // Leaving CLAUDE_ENV_FILE set would prepend this directory to every shell
  // command in every later test file of the same process.
  if (originalEnvFile === undefined) delete process.env.CLAUDE_ENV_FILE
  else process.env.CLAUDE_ENV_FILE = originalEnvFile
  invalidateSessionEnvCache()
  cleanupAllFakeGh()
})

function run(
  commands: string[],
  extra: { timeoutMs?: number; idleTimeoutMs?: number } = {},
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

  test('a real gh failure still stops it', async () => {
    // Exit 1 from the fake's loud fallback: only exit 8 is forgiven, and only
    // for `pr checks`.
    fakeGh.setRules([])
    const result = await run(['gh pr view 9', 'git --version'])
    expect(result.outcomes[0]?.stall).toBeUndefined()
    expect(result.notRun).toEqual(['git --version'])
    expect(batchFailed(result)).toBe(true)
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
