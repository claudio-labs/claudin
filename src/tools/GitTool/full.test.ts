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
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import {
  cleanupAllRepos,
  git,
  repoWithCommits,
  writeRepoFile,
} from 'src/tools/GitTool/__fixtures__/repo.js'
import { acceptsGitCommand } from 'src/tools/GitTool/grammar.js'
import { formatGitBatchResult, runGitBatch } from 'src/tools/GitTool/run.js'

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

    // Every changed file, first one included. The Bash filter wraps its result
    // in a marker glued to the first line, and parsing that as part of the
    // first section used to drop `src/app.ts` from the table without a word —
    // a stat table that lies about what changed.
    expect(output).toContain('7 files changed')
    for (const path of ['src/app.ts', 'src/mod1.ts', 'src/mod6.ts']) {
      expect(output).toContain(path)
    }
  }, 60_000)

  test('the stat table is complete under diff.mnemonicPrefix too', async () => {
    // With `i/ w/` prefixes the Bash filter keeps the `diff --git` headers
    // instead of stripping them, so the summarizer takes its OTHER branch — the
    // one where the filter's marker sits on the same line as the first
    // `diff --git`. Parsing that line as part of the section silently dropped
    // the first file from the table.
    const root = wideDirtyRepo()
    git(root, ['config', 'diff.mnemonicPrefix', 'true'])

    const result = await run(root, ['git diff'])
    const output = result.outcomes[0]?.output ?? ''

    expect(output).toContain('hunks omitted')
    expect(output).toContain('7 files changed')
    expect(output).toContain('src/app.ts')
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

/** `lines` lines of ~70 chars, tagged so a test can name the last one. */
function bigBody(tag: string, lines: number): string {
  return Array.from({ length: lines }, (_, i) => `export const ${tag}_${i} = 'line ${i} of ${tag}, padded to widen the diff'`).join('\n') + '\n'
}

/** Each file committed, then rewritten on every line: its diff is ~2 × its size. */
function rewrittenRepo(files: readonly string[], lines: number): string {
  const root = repoWithCommits(1)
  for (const file of files) writeRepoFile(root, file, bigBody('old', lines))
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'base'])
  for (const file of files) writeRepoFile(root, file, bigBody(file.replace(/\W/g, '_'), lines))
  return root
}

// The shell keeps only the first BASH_MAX_OUTPUT_LENGTH (30,000) characters of
// a run on `result.stdout` and leaves the rest in its output file. Git read
// stdout, so 68 single-command results since 2026-09-01 came back as exactly
// 30,000 bytes cut mid-line, 66 of them asked for with `full: true`.
describe('output past the shell cap', () => {
  test('full: true keeps the last line of a 200 KB diff', async () => {
    const result = await run(rewrittenRepo(['src/big.ts'], 1500), ['git diff'], true)
    const output = result.outcomes[0]?.output ?? ''
    expect(Buffer.byteLength(output)).toBeGreaterThan(30_000)
    expect(output).toContain('src_big_ts_1499')
  }, 60_000)

  test('the summary of a wide diff counts every file, not the first 30k of them', async () => {
    const files = Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`)
    const result = await run(rewrittenRepo(files, 300), ['git diff'])
    const output = result.outcomes[0]?.output ?? ''
    expect(output).toContain('8 files changed')
    expect(output).toContain('src/f7.ts')
    expect(output).toContain('src/f0.ts  +300/-300')
  }, 60_000)

  test('each command of a batch keeps its whole output', async () => {
    const result = await run(rewrittenRepo(['src/big.ts'], 1500), ['git diff', 'git status --short'], true)
    expect(result.outcomes[0]?.output ?? '').toContain('src_big_ts_1499')
    expect(result.outcomes[1]?.output).toBe(' M src/big.ts\n')
  }, 60_000)

  test('a failing command keeps the end of its output', async () => {
    const root = rewrittenRepo(['src/big.ts'], 1500)
    git(root, ['add', '.'])
    const result = await run(root, ['git diff --cached --exit-code'], true)
    expect(result.outcomes[0]?.exitCode).toBe(1)
    expect(result.outcomes[0]?.output ?? '').toContain('src_big_ts_1499')
  }, 60_000)

  test('JSON past the cap still parses', async () => {
    const root = repoWithCommits(1)
    const json = JSON.stringify(Array.from({ length: 900 }, (_, i) => ({ number: i, title: `pull request ${i} with a long title` })))
    writeRepoFile(root, 'list.json', json)
    git(root, ['add', 'list.json'])
    git(root, ['commit', '-qm', 'json'])
    const result = await run(root, ['git show HEAD:list.json'], true)
    expect(JSON.parse(result.outcomes[0]?.output ?? '')).toHaveLength(900)
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
