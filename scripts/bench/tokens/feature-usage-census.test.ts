import { describe, expect, test } from 'bun:test'
import { type Call, grepGlobPatterns, grepReport, isDirAnchoredGlob, waitReport } from './feature-usage-census.ts'

let seq = 0
function call(tool: string, input: Record<string, unknown>, text: string, extra: Partial<Call> = {}): Call {
  return {
    id: `t${seq}`,
    tool,
    input,
    ts: 0,
    file: '/t/a.jsonl',
    session: 'a',
    sub: false,
    seq: seq++,
    cwd: '/repo',
    text,
    chars: text.length,
    isError: false,
    answered: true,
    ...extra,
  }
}

describe('grep globs with a slash', () => {
  test('patterns split the way GrepTool splits them', () => {
    expect(grepGlobPatterns('*.ts,*.tsx {a/b.ts,c/d.ts} !x/**')).toEqual(['*.ts', '*.tsx', '{a/b.ts,c/d.ts}', '!x/**'])
  })

  test('only a relative pattern with a slash is anchored at the directory ripgrep runs in', () => {
    expect(isDirAnchoredGlob('src/*.ts')).toBe(true)
    expect(isDirAnchoredGlob('!fuzz/corpus/**')).toBe(true)
    expect(isDirAnchoredGlob('*.ts')).toBe(false)
    expect(isDirAnchoredGlob('**/a/b.ts')).toBe(false)
    expect(isDirAnchoredGlob('/a/b.ts')).toBe(false)
  })

  test('a slash glob is counted apart by whether the search path is the cwd', () => {
    const g = grepReport([
      call('Grep', { pattern: 'x', glob: '{a/b.ts}' }, 'a/b.ts'),
      call('Grep', { pattern: 'x', glob: '{a/b.ts}', path: '/repo/src' }, 'No matches found'),
      call('Grep', { pattern: 'x', glob: 'a/b.ts', path: 'src' }, 'src/a/b.ts'),
      call('Grep', { pattern: 'x', glob: '!fuzz/**', path: '/other' }, 'f.rs'),
      call('Grep', { pattern: 'x', glob: '*.ts', path: '/other' }, 'No matches found'),
    ])
    expect(g.slashGlobAtCwd).toBe(1)
    expect(g.slashGlobAtCwdEmpty).toBe(0)
    expect(g.slashGlobElsewhere).toBe(2)
    expect(g.slashGlobElsewhereEmpty).toBe(1)
    expect(g.negatedSlashGlobElsewhere).toBe(1)
  })
})

describe('waitReport', () => {
  const wait = (reason: string, secs: number, input: Record<string, unknown> = {}) =>
    call('WaitFor', { command: 'cat f', ...input }, `out\n[WaitFor: ${reason} after ${secs}s, 3 polls]`)

  test('back-to-back waits are one run, and each call past the first is a re-poll', () => {
    const w = waitReport([
      wait('timeout', 600, { command: 'gh pr checks 1', timeout_s: 600 }),
      wait('timeout', 600, { command: 'gh pr checks 1', timeout_s: 600 }),
      wait('match', 30, { command: 'gh pr checks 1', timeout_s: 600 }),
      call('Bash', { command: 'ls' }, 'a'),
      wait('match', 5),
    ])
    expect(w.waits).toBe(4)
    expect(w.runs).toBe(2)
    expect(w.multiCallRuns).toBe(1)
    expect(w.repolls).toBe(2)
    expect(w.repollsAfterTimeout).toBe(2)
    expect(w.ciPolls).toBe(3)
    expect(w.ciTimeouts).toBe(2)
    expect(w.waitedMin).toBeCloseTo(1235 / 60)
    expect(w.reasons).toEqual([['timeout', 2], ['match', 2]])
    expect(w.timeoutAsked).toEqual([['600', 3], ['default', 1]])
  })

  test('a wait in another transcript starts its own run', () => {
    const w = waitReport([wait('timeout', 600), call('WaitFor', { command: 'cat f' }, 'x', { file: '/t/b.jsonl' })])
    expect(w.runs).toBe(2)
    expect(w.repolls).toBe(0)
    expect(w.reasons).toEqual([['timeout', 1], ['unparsed', 1]])
  })
})
