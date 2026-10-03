/**
 * The auto-mode half of permission setup only exists when the
 * TRANSCRIPT_CLASSIFIER build flag is on. The shipped build turns it on, and
 * `bun test` folds every flag to false, so a suite about that half runs
 * itself a second time in a child `bun test --feature=TRANSCRIPT_CLASSIFIER`.
 *
 * `shipped` says which of the two runs this is. Under the plain runner,
 * `delegateToShippedBuild` registers the one test that starts the child and
 * fails with the child's report when anything in it fails.
 */
import { feature } from 'bun:bundle'
import { expect, test } from 'bun:test'
import { dirname, join } from 'node:path'

// `feature()` has to be the whole condition of a ternary or an `if`; any
// other position throws under `bun test`.
export const shipped: boolean = feature('TRANSCRIPT_CLASSIFIER') ? true : false

const repoRoot = join(dirname(import.meta.path), '..', '..', '..', '..')

export function delegateToShippedBuild(suitePath: string): void {
  test('passes in a child run with TRANSCRIPT_CLASSIFIER on', async () => {
    const child = Bun.spawn(
      [process.execPath, 'test', '--feature=TRANSCRIPT_CLASSIFIER', suitePath],
      { cwd: repoRoot, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const report = `${stdout}\n${stderr}`
    const passed = Number(report.match(/(\d+) pass/)?.[1] ?? 0)
    const failed = Number(report.match(/(\d+) fail/)?.[1] ?? 1)
    if (code !== 0 || failed > 0 || passed === 0) {
      throw new Error(`the flagged run failed (exit ${code}):\n${report}`)
    }
    expect(passed).toBeGreaterThan(0)
  }, 120_000)
}
