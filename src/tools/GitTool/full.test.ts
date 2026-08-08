/**
 * `full: true` and the multi-line message, end to end through `runGitBatch`.
 *
 * Both of these exist because the model left the tool for Bash rather than use
 * it: a big diff had no whole-body escape, and a commit body could not be
 * expressed at all. Neither is provable from a parser test — what matters is
 * that the bytes survive exec, the shell quoting and git itself — so these run
 * real git in a real fixture repo.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { runWithCwdOverride } from '../../utils/cwd.js'
import {
  cleanupAllRepos,
  git,
  repoWithCommits,
  writeRepoFile,
} from './__fixtures__/repo.js'
import { acceptsGitCommand } from './grammar.js'
import { formatGitBatchResult, runGitBatch } from './run.js'

afterAll(() => {
  cleanupAllRepos()
})

function run(root: string, commands: string[], full?: boolean) {
  return runWithCwdOverride(root, () =>
    runGitBatch({
      commands,
      abortSignal: new AbortController().signal,
      timeoutMs: 30_000,
      full,
    }),
  )
}

/** Seven modified files — past `DIFF_PIVOT_FILES`, so the budget pivots. */
function wideDirtyRepo(): string {
  const root = repoWithCommits(8)
  writeRepoFile(root, 'src/app.ts', 'export const version = 99\n// changed\n')
  for (let i = 1; i < 7; i++) {
    writeRepoFile(root, `src/mod${i}.ts`, `export const mod${i} = ${i}\n// changed\n`)
  }
  return root
}

describe('full: true', () => {
  test('a wide diff pivots to the stat table and names the escape', async () => {
    const result = await run(wideDirtyRepo(), ['git diff'])
    const output = result.outcomes[0]?.output ?? ''
    expect(output).toContain('hunks omitted')
    expect(output).not.toContain('@@')
    // The hint has to name this flag, or the model reaches for Bash again.
    expect(output).toContain('full: true')
  }, 60_000)

  test('the same diff comes back whole with full: true', async () => {
    const result = await run(wideDirtyRepo(), ['git diff'], true)
    const output = result.outcomes[0]?.output ?? ''
    expect(output).toContain('@@')
    expect(output).toContain('// changed')
    expect(output).not.toContain('hunks omitted')
  }, 60_000)

  test('full: true also skips the filter rewrite, not just the summarizer', async () => {
    const root = repoWithCommits(3)
    // Without it, `git log` is rewritten to `git log --oneline` before it runs,
    // so "the whole body" would still be a one-line-per-commit summary.
    const summarized = await run(root, ['git log'])
    expect(summarized.outcomes[0]?.output ?? '').not.toContain('Author:')

    const whole = await run(root, ['git log'], true)
    expect(whole.outcomes[0]?.output ?? '').toContain('Author:')
  }, 60_000)
})

describe('multi-line commit message', () => {
  test('a subject and body reach git with the blank line intact', async () => {
    const root = repoWithCommits(2)
    writeRepoFile(root, 'src/app.ts', 'export const version = 3\n')
    const message = 'feat: the subject\n\nThe body explains why.\nSecond body line.'

    const commit = `git commit -m "${message}"`
    // The grammar has to accept the very string that round-trips, or the two
    // halves of this feature pass their own tests and still meet at a refusal.
    expect(acceptsGitCommand(commit)).toBe(true)

    const result = await run(root, ['git add -A', commit])

    expect(result.outcomes).toHaveLength(2)
    expect(result.outcomes.every(o => o.exitCode === 0)).toBe(true)
    expect(git(root, ['log', '-1', '--format=%B']).trim()).toBe(message)

    // The `$ command` header stays one line, or a two-command batch reads as
    // five in the transcript.
    const headers = formatGitBatchResult(result)
      .split('\n')
      .filter(line => line.startsWith('$ '))
    expect(headers).toHaveLength(2)
    expect(headers[1]).toContain('The body explains why.')
  }, 60_000)

  test('a message quoted with single quotes keeps its backticks and $', async () => {
    const root = repoWithCommits(2)
    writeRepoFile(root, 'src/app.ts', 'export const version = 4\n')
    const message = 'fix: `renderDiff` no longer costs $50'

    const commit = `git commit -m '${message}'`
    expect(acceptsGitCommand(commit)).toBe(true)

    const result = await run(root, ['git add -A', commit])

    expect(result.outcomes.every(o => o.exitCode === 0)).toBe(true)
    expect(git(root, ['log', '-1', '--format=%B']).trim()).toBe(message)
  }, 60_000)
})
