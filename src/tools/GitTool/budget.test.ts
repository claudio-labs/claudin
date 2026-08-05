import { describe, expect, test } from 'bun:test'

import { NO_WIN_RATIO, summarizeGitOutput } from './budget.js'
import {
  DIFF_PIVOT_CHARS,
  isUnifiedDiff,
  summarizeDiffFiles,
} from './parsers/diff.js'
import { renderRunLog } from './parsers/gh.js'
import { renderStatusShort } from './parsers/status.js'

/** A unified diff for `path` with `hunks` hunks of `linesPerHunk` added lines. */
function makeDiff(path: string, hunks: number, linesPerHunk: number): string {
  const parts = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`]
  for (let h = 0; h < hunks; h++) {
    parts.push(`@@ -${h * 50 + 1},3 +${h * 50 + 1},${linesPerHunk + 3} @@`)
    parts.push(' context line')
    for (let l = 0; l < linesPerHunk; l++) {
      parts.push(`+added line ${h}-${l} with enough text to matter`)
    }
    parts.push(' trailing context')
  }
  return parts.join('\n')
}

describe('summarizeGitOutput dispatch', () => {
  test('leaves a command with no summarizer untouched', () => {
    const output = 'abc123 some commit subject\n'.repeat(50)
    expect(summarizeGitOutput('git log --oneline -50', output)).toBe(output)
  })

  test('leaves empty output untouched', () => {
    expect(summarizeGitOutput('git diff', '')).toBe('')
  })

  test('finds the subcommand behind git global options', () => {
    const diff = makeDiff('src/big.ts', 40, 6)
    expect(diff.length).toBeGreaterThan(DIFF_PIVOT_CHARS)
    const viaGlobal = summarizeGitOutput('git -C /repo diff', diff)
    expect(viaGlobal).not.toBe(diff)
    expect(viaGlobal).toBe(summarizeGitOutput('git diff', diff))
  })

  test('--no-pager and -c k=v do not hide the subcommand', () => {
    const diff = makeDiff('src/big.ts', 40, 6)
    expect(summarizeGitOutput('git --no-pager diff', diff)).not.toBe(diff)
    expect(summarizeGitOutput('git -c core.pager=cat diff', diff)).not.toBe(diff)
  })

  test('a renderer that throws returns the raw output', () => {
    // A body that trips the diff detector but has no parseable file section:
    // the renderer must fail open rather than cost the model its output.
    const weird = `@@ -1,1 +1,1 @@\n${'x'.repeat(9_000)}`
    expect(summarizeGitOutput('git diff', weird)).toBe(weird)
  })
})

describe('the no-win guard', () => {
  test('declines a summary that is not at least the ratio smaller', () => {
    // One hunk, already tight: any rendering would be about the same size, so
    // the guard must hand back the original.
    const small = makeDiff('src/a.ts', 1, 2)
    expect(summarizeGitOutput('git diff', small)).toBe(small)
  })

  test('accepts a summary that clears the ratio', () => {
    const big = makeDiff('src/a.ts', 60, 8)
    const out = summarizeGitOutput('git diff', big)
    expect(out).not.toBe(big)
    expect(out.length).toBeLessThanOrEqual(big.length * NO_WIN_RATIO)
  })

  test('the ratio is the published constant, not a local guess', () => {
    expect(NO_WIN_RATIO).toBe(0.7)
  })
})

describe('diff rendering', () => {
  test('pivots a large diff to a stat table naming every file', () => {
    const diff = [makeDiff('src/a.ts', 20, 8), makeDiff('src/b.ts', 20, 8)].join(
      '\n',
    )
    const out = summarizeGitOutput('git diff', diff)
    expect(out).toContain('src/a.ts')
    expect(out).toContain('src/b.ts')
    expect(out).toContain('2 files changed')
    // The pivot is only honest if it says how to get the hunks back.
    expect(out).toContain('git diff -- <path>')
    expect(out).not.toContain('@@ -')
  })

  test('counts adds and removes exactly, ignoring the +++/--- headers', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,2 +1,2 @@',
      '-gone',
      '+added',
      ' same',
    ].join('\n')
    expect(summarizeDiffFiles(diff)).toEqual([
      {
        path: 'x.ts',
        added: 1,
        removed: 1,
        isBinary: false,
        isNew: false,
        isDeleted: false,
      },
    ])
  })

  test('parses a body whose `diff --git` header the output filter stripped', () => {
    // 13 of 95 recorded diff bodies arrive in exactly this shape.
    const diff = [
      '--- a/scripts/build.ts',
      '+++ b/scripts/build.ts',
      '@@ -65,8 +65,9 @@',
      '+  ADDED: true,',
      ' const x = 1',
    ].join('\n')
    const files = summarizeDiffFiles(diff)
    expect(files).toHaveLength(1)
    expect(files[0]?.path).toBe('scripts/build.ts')
    expect(files[0]?.added).toBe(1)
  })

  test('a content line starting with `--- ` does not become a phantom file', () => {
    const diff = [
      '--- a/doc.md',
      '+++ b/doc.md',
      '@@ -1,3 +1,3 @@',
      '--- a horizontal rule in the removed markdown',
      '+--- a horizontal rule in the added markdown',
      ' unchanged',
    ].join('\n')
    const files = summarizeDiffFiles(diff)
    expect(files.map(f => f.path)).toEqual(['doc.md'])
  })

  test('declines a `--stat` body, which is not a unified diff', () => {
    const stat = ' src/a.ts | 12 ++++++----\n 1 file changed, 8 insertions(+)'
    expect(isUnifiedDiff(stat)).toBe(false)
    expect(summarizeGitOutput('git diff --stat', stat)).toBe(stat)
  })

  test('keeps whole hunks and names the ones it dropped', () => {
    // Below the pivot but past the per-file line budget: this is the band the
    // pivot deliberately does not touch.
    const diff = makeDiff('src/a.ts', 14, 6)
    expect(diff.length).toBeLessThan(DIFF_PIVOT_CHARS)
    const out = summarizeGitOutput('git diff', diff)
    expect(out).toContain('more hunks')
    // Never a half hunk: every kept header is followed by its lines.
    const kept = out.split('\n').filter(l => l.startsWith('@@ '))
    expect(kept.length).toBeGreaterThan(0)
    expect(out).toContain('git diff -- src/a.ts')
  })

  test('git show routes through the same renderer', () => {
    const diff = makeDiff('src/a.ts', 40, 8)
    expect(summarizeGitOutput('git show HEAD', diff)).toBe(
      summarizeGitOutput('git diff', diff),
    )
  })
})

describe('gh run log rendering', () => {
  const line = (job: string, step: string, ts: string, text: string) =>
    `${job}\t${step}\t${ts} ${text}`

  test('hoists the repeated job/step prefix and drops the timestamps', () => {
    const raw = [
      line('smoke', 'Run tests', '2026-07-24T21:19:54.2638189Z', 'bun test v1.3'),
      line('smoke', 'Run tests', '2026-07-24T21:19:55.0752376Z', '(pass) one'),
      line('smoke', 'Run tests', '2026-07-24T21:19:55.0764041Z', '(pass) two'),
    ].join('\n')
    const out = renderRunLog(raw)
    expect(out).not.toBeNull()
    expect(out).toContain('## smoke › Run tests')
    expect(out).not.toContain('2026-07-24T21:19:54')
    // The prefix appears once, not once per line.
    expect(out?.match(/smoke/g)).toHaveLength(1)
  })

  test('drops the actions group markers and ANSI escapes', () => {
    const raw = [
      line('j', 's', '2026-07-24T21:19:54.0000000Z', '##[group]Run bun test'),
      line('j', 's', '2026-07-24T21:19:54.0000001Z', '\u001b[36;1mbun test\u001b[0m'),
    ].join('\n')
    const out = renderRunLog(raw)
    expect(out).not.toContain('##[group]')
    expect(out).toContain('bun test')
    expect(out).not.toContain('\u001b[36;1m')
  })

  test('keeps the tail when a log is still oversized, because failures are last', () => {
    const raw = Array.from({ length: 400 }, (_, i) =>
      line('j', 's', '2026-07-24T21:19:54.0000000Z', `step ${i}`),
    ).join('\n')
    const out = renderRunLog(raw) ?? ''
    expect(out).toContain('step 399')
    expect(out).not.toContain('step 10 ')
    expect(out).toContain('earlier log lines omitted')
  })

  test('declines a `gh run list` table, which is also tab-separated', () => {
    // The timestamp, not the tabs, is what makes a line a log line.
    expect(renderRunLog('completed\tsuccess\tCI\tmain\tpush\n')).toBeNull()
    expect(renderRunLog('just some text')).toBeNull()
  })
})

describe('git status rendering', () => {
  test('groups an untracked explosion by directory', () => {
    const lines = Array.from(
      { length: 40 },
      (_, i) => `?? build/artifacts/file-${i}.js`,
    )
    const raw = [' M src/a.ts', ...lines].join('\n')
    const out = renderStatusShort(raw)
    expect(out).toContain(' M src/a.ts')
    expect(out).toContain('40 untracked files')
    expect(out).toContain('build/artifacts/ (40 files)')
  })

  test('leaves a small status alone', () => {
    const raw = [' M src/a.ts', '?? new.ts'].join('\n')
    expect(renderStatusShort(raw)).toBeNull()
  })

  test('declines long-form status output', () => {
    const raw = 'On branch main\nnothing to commit, working tree clean'
    expect(renderStatusShort(raw)).toBeNull()
  })
})
