import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { REPO_ROOT } from '../../repoRoot.js'
import {
  type Call,
  bashReport,
  grepReport,
  overview,
  parseArgs,
  printBash,
  printGrep,
  printOverview,
  printRead,
  printSymbols,
  printWait,
  readReport,
  waitReport,
  walk,
} from './feature-usage-census.ts'

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

  test('a trailing slash alone is no anchor: ripgrep reads it at any depth', () => {
    const g = grepReport([call('Grep', { pattern: 'x', glob: '!node_modules/', path: '/other' }, 'f.rs')])
    expect(g.negatedSlashGlobElsewhere).toBe(0)
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

  // The 11-26 census counted 5 re-polls; none repeated a wait: three waited
  // in two stages on one pane ("Running…", then idle), two asked again with a
  // stricter `until` after an early match, and one moved on to a log.
  test('a wait on another command, or for another condition, starts its own run', () => {
    const pane = 'tmux capture-pane -t uiprobe -p'
    const w = waitReport([
      wait('match', 5, { command: pane, until: 'Running' }),
      wait('match', 40, { command: pane, until: 'IDLE' }),
      wait('timeout', 60, { command: 'tail -n 5 log.txt', until: 'keep-alive' }),
      wait('match', 9, { command: 'tail -n 5 log.txt', until: 'keep-alive' }),
    ])
    expect(w.runs).toBe(3)
    expect(w.repolls).toBe(1)
    expect(w.repollsAfterTimeout).toBe(1)
    expect(w.multiCallRuns).toBe(1)
  })

  test('a wait in another transcript starts its own run', () => {
    const w = waitReport([wait('timeout', 600), call('WaitFor', { command: 'cat f' }, 'x', { file: '/t/b.jsonl' })])
    expect(w.runs).toBe(2)
    expect(w.repolls).toBe(0)
    expect(w.reasons).toEqual([['timeout', 1], ['unparsed', 1]])
  })
})

/** What the print functions wrote, one entry per console.log. */
function printed(run: () => void): string[] {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    run()
    return log.mock.calls.map(args => String(args[0]))
  } finally {
    log.mockRestore()
  }
}

// ---------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------

const filteredOutput = (attrs: string, body: string): string => `<bash-output-filtered ${attrs}>${body}</bash-output-filtered>\n`

function bashCalls(): Call[] {
  const bash = (command: string, text: string, extra: Partial<Call> = {}): Call => call('Bash', { command }, text, extra)
  return [
    // Capped, then the same command again.
    bash('bun test src/x.test.ts', filteredOutput('original="bun test src/x.test.ts" lines="3/100" reduction="90%"', 'ok\n…97 lines omitted…\nfail')),
    bash('bun test src/x.test.ts', filteredOutput('lines="5/4" reduction="10%"', 'a\nb\nc\nd\ne')),
    // Capped, then the same listing with a pipe appended.
    bash('ls -R src/tools', filteredOutput('lines="40/400" reduction="80%"', 'x\n…360 lines omitted…\ny')),
    bash('ls -R src/tools | head -50', 'x\ny'),
    // Capped, then the same head on another directory.
    bash('find src/a -name x', filteredOutput('lines="10/30" reduction="55%"', '…20 lines omitted…')),
    bash('find src/b -name y', filteredOutput('lines="9/10" reduction="5%"', 'q')),
    // Capped, then a dedicated tool.
    bash('cargo build', filteredOutput('lines="6/10" reduction="40%"', 'e\n…4 lines omitted…')),
    call('Grep', { pattern: 'e' }, 'a.rs'),
    bash('git status', filteredOutput('original="git status" actual="git status --short" lines="1/9" reduction="100%"', 'M a')),
    bash('git push', '<bash-output-rewritten original="git push" actual="git push --porcelain">done</bash-output-rewritten>'),
    bash('cat big.log', '<persisted-output>saved to a file</persisted-output>'),
    bash('cd /repo && FOO=1 bun run build', 'r'.repeat(2000)),
    bash('git -C x log', 'abc'),
    bash('echo a && echo b', 'e'.repeat(1500)),
    bash('rm x', 'Blocked: this deletes a file → Edit(file_path)'),
    bash('x', '<tool_use_error>Blocked: nope\nsecond line'),
    bash('false', 'Exit code 1', { isError: true }),
    bash('sleep 1', '', { answered: false }),
    // Capped in another transcript, with nothing related after it.
    bash('npm run lint', filteredOutput('reduction="35%"', 'w\n…1 lines omitted…'), { file: '/t/b.jsonl' }),
    call('Edit', { file_path: '/repo/a.ts' }, 'ok', { file: '/t/b.jsonl' }),
  ]
}

describe('bashReport', () => {
  test('calls split into unanswered, blocked, errors and ran; ran by marker', () => {
    const b = bashReport(bashCalls())
    expect(b.calls).toBe(18)
    expect(b.unanswered).toBe(1)
    expect(b.blocked).toBe(2)
    expect(b.blockedBy).toEqual([['Edit', 1], ['(unparsed)', 1]])
    expect(b.unparsedLeads).toEqual([['Blocked: nope', 1]])
    expect(b.errors).toBe(1)
    expect(b.ran).toBe(14)
    expect(b.filtered).toBe(8)
    expect(b.rewrittenOnly).toBe(1)
    expect(b.persisted).toBe(1)
    expect(b.raw).toBe(4)
    expect(b.rewrites).toEqual([['git status → git status --short', 1], ['git push → git push --porcelain', 1]])
  })

  test('filtered results: reduction, estimated original and the anomalies', () => {
    const b = bashReport(bashCalls())
    expect(b.reductionMedian).toBe(47.5)
    expect(b.reductionBuckets).toEqual([['75%+', 3], ['30-50%', 2], ['10-30%', 1], ['50-75%', 1], ['<10%', 1]])
    // 'M a' at 100% is its own estimate; 'q' at 5% is 1 / 0.95.
    expect(b.filteredHeads.find(([head]) => head === 'git status')?.[1]).toEqual({ n: 1, body: 3, saved: 0 })
    expect(b.filteredHeads[0]![0]).toBe('bun test')
    expect(b.filteredHeads[0]![1].n).toBe(2)
    expect(b.filteredHeads[0]![1].body).toBe(26 + 9)
    expect(b.filteredHeads[0]![1].saved).toBeCloseTo(26 / 0.1 - 26 + 9 / 0.9 - 9)
    expect(b.filteredBody).toBe(26 + 9 + 23 + 18 + 1 + 19 + 3 + 19)
    expect(b.filteredWrapped).toBeGreaterThan(b.filteredBody)
    expect(b.anomalies).toEqual({
      moreLinesThanOriginal: [{ head: 'bun test', lines: '5/4' }],
      listingOmitted: [
        { head: 'ls', omitted: 360, lines: '40/400' },
        { head: 'find', omitted: 20, lines: '10/30' },
      ],
      marginal: [
        { head: 'bun test', reduction: 10, body: 9 },
        { head: 'find', reduction: 5, body: 1 },
      ],
    })
  })

  test('what followed a capped result, within the next three calls of the transcript', () => {
    const b = bashReport(bashCalls())
    expect(b.cappedHeads).toEqual([
      ['bun test', { n: 1, orig: 100, omitted: 97 }],
      ['ls', { n: 1, orig: 400, omitted: 360 }],
      ['find', { n: 1, orig: 30, omitted: 20 }],
      ['cargo build', { n: 1, orig: 10, omitted: 4 }],
      ['npm run', { n: 1, orig: 0, omitted: 1 }],
    ])
    expect(b.afterCap).toEqual([
      ['re-sent same command', 1],
      ['same head, same target', 1],
      ['same head, other target', 1],
      ['moved to Grep', 1],
      ['went on', 1],
    ])
    expect(b.reaskHeads).toEqual([['bun test', 1], ['ls', 1]])
  })

  test('raw results by command head, past any cd and env prefix', () => {
    const b = bashReport(bashCalls())
    expect(b.rawChars).toBe(3 + 2000 + 3 + 1500)
    expect(b.rawHeads).toEqual([
      ['bun run', { n: 1, chars: 2000, big: 1, compound: 0 }],
      ['echo', { n: 1, chars: 1500, big: 1, compound: 1 }],
      ['ls', { n: 1, chars: 3, big: 0, compound: 1 }],
      ['git', { n: 1, chars: 3, big: 0, compound: 0 }],
    ])
    expect(b.rawBig).toBe(2)
    expect(b.rawBigChars).toBe(3500)
    expect(b.rawBigCompound).toBe(1)
    expect(b.bigRaw).toEqual([
      { head: 'bun run', chars: 2000, compound: false },
      { head: 'echo', chars: 1500, compound: true },
    ])
  })

  test('printBash renders the section', () => {
    const lines = printed(() => printBash(bashReport(bashCalls())))
    expect(lines[0]).toBe('\n== Bash output filter ==')
    expect(lines[1]).toBe('calls=18 blocked=2 errors=1 ran=14 unanswered=1')
    expect(lines).toContain('  blocked → Edit:1  (unparsed):1')
    expect(lines).toContain('    unparsed ×1: Blocked: nope')
    expect(lines).toContain('  ran: filtered=8 (57.1%) rewritten-only=1 persisted=1 raw=4 (28.6%)')
    expect(lines).toContain('  raw chars: 3.4K over 4 results; ≥1K: 2 results / 3.4K (1 compound)')
    expect(lines).toContain('  reduction median=47.5%  75%+:3  30-50%:2  10-30%:1  50-75%:1  <10%:1')
    expect(lines).toContain('    bun run                    n=  1 chars=   2.0K ≥1K=  1 compound=0')
    expect(lines).toContain('      1  git status → git status --short')
    expect(lines).toContain('  anomalies: body>original lines=1  listing-with-omitted-lines=2  reduction<15%=2')
    expect(lines).toContain('    lines↑  bun test             lines=5/4')
    expect(lines).toContain('    omitted ls                   lines=40/400 omitted=360')
    expect(lines).toContain('    ls                         n=  1 original lines=   400 omitted=   360')
    expect(lines).toContain(
      '  after a capped result (next 3 calls): re-sent same command:1  same head, same target:1  same head, other target:1  moved to Grep:1  went on:1',
    )
    expect(lines).toContain('    re-asked about the same target, by head: bun test:1  ls:1')
    expect(lines).toContain('       2.0K  bun run                  atomic')
    expect(lines).toContain('       1.5K  echo                     compound')
  })
})

// ---------------------------------------------------------------------------
// Grep
// ---------------------------------------------------------------------------

const GREP_PIVOT = 'Search matched broadly; returned the symbol map instead of matching lines'

function grepCalls(): Call[] {
  const grep = (input: Record<string, unknown>, text: string, extra: Partial<Call> = {}): Call => call('Grep', input, text, extra)
  const wide = { pattern: 'foo', output_mode: 'content', '-C': 2, head_limit: 0 }
  return [
    grep({ pattern: 'foo' }, 'a.ts\nb.ts'),
    grep(wide, 'm'.repeat(7000)),
    grep(wide, 'm'.repeat(7000)),
    grep({ ...wide, offset: 100 }, 'tail'),
    // The auto-pivot, then the same pattern with the hint taken.
    grep({ pattern: 'bar', output_mode: 'content' }, `${GREP_PIVOT}\nsrc/a.ts`),
    grep({ pattern: 'bar', output_mode: 'content', head_limit: 20 }, 'a.ts:1:bar\n[Showing results with pagination = limit: 20]'),
    // The auto-pivot, then the same search with one more flag.
    grep({ pattern: 'baz', output_mode: 'content', path: 'src' }, `${GREP_PIVOT}\nsrc/b.ts`),
    grep({ pattern: 'baz', output_mode: 'content', path: 'src', '-A': 1 }, 'b.ts:1:baz'),
    // The auto-pivot, and no re-run.
    grep({ pattern: 'qux', output_mode: 'content', path: 'a' }, `${GREP_PIVOT}\na/c.ts`),
    grep({ pattern: 'p', output_mode: 'content', path: 'a' }, 'a/p.ts:1:p'),
    grep({ pattern: 'p', output_mode: 'content', path: 'b' }, 'b/p.ts:1:p'),
    grep({ pattern: 'p', output_mode: 'content', path: 'b', glob: '*.ts' }, 'b/p.ts:1:p'),
    grep({ pattern: 'c', output_mode: 'count', type: 'ts', multiline: true }, 'No matches found'),
    grep({ pattern: 's', output_mode: 'symbols' }, 'INCOMPLETE: the search timed out\nfn s', { isError: true }),
    grep({ pattern: 'i', output_mode: 'files_with_matches', context: 1 }, 'x.ts\n(matched only in files excluded by .gitignore)', { sub: true, file: '/t/a/subagents/x.jsonl' }),
    grep({ pattern: 'never' }, '', { answered: false }),
  ]
}

describe('grepReport', () => {
  test('answered calls by output mode, with the default counted as files_with_matches', () => {
    const g = grepReport(grepCalls())
    expect(g.calls).toBe(15)
    expect(g.byMode).toEqual([
      { mode: 'files_with_matches', n: 2, chars: 9 + 51, median: 30, noMatch: 0, errors: 0 },
      { mode: 'content', n: 11, chars: 14_000 + 4 + 2 * (GREP_PIVOT.length + 9) + 56 + GREP_PIVOT.length + 7 + 4 * 10, median: 56, noMatch: 0, errors: 0 },
      { mode: 'count', n: 1, chars: 16, median: 16, noMatch: 1, errors: 0 },
      { mode: 'symbols', n: 1, chars: 37, median: 37, noMatch: 0, errors: 1 },
    ])
    expect(g.byModeMain).toEqual([['content', 11], ['files_with_matches', 1], ['count', 1], ['symbols', 1]])
    expect(g.byModeSub).toEqual([['files_with_matches', 1]])
  })

  test('inputs and result leads', () => {
    const g = grepReport(grepCalls())
    expect(g.withHeadLimit).toBe(4)
    expect(g.withHeadLimitZero).toBe(3)
    expect(g.withHeadLimitZeroChars).toBe(14_004)
    expect(g.headLimitZeroByMode).toEqual([['content', 3]])
    expect(g.headLimitZeroContentBig).toBe(2)
    expect(g.headLimitZeroContentBigChars).toBe(14_000)
    expect(g.withContext).toBe(5)
    expect(g.withPath).toBe(6)
    expect(g.withGlobOrType).toBe(2)
    expect(g.withMultiline).toBe(1)
    expect(g.autoPivot).toBe(3)
    expect(g.explicitSymbols).toBe(1)
    expect(g.incomplete).toBe(1)
    expect(g.ignoredFallback).toBe(1)
    expect(g.paginated).toBe(1)
    expect(g.contentOver6k).toBe(2)
    expect(g.contentOver6kChars).toBe(14_000)
    expect(g.contentOver6kWithLimit).toBe(2)
    expect(g.contentOver6kWithContext).toBe(2)
    expect(g.contentOver6kLimits).toEqual([['0', 2]])
    expect(g.contentNoScopeNoLimit).toBe(1)
    expect(g.contentNoScopeNoLimitChars).toBe(GREP_PIVOT.length + 9)
  })

  test('the next Grep of the same pattern in the transcript: what changed, and after a pivot', () => {
    const g = grepReport(grepCalls())
    expect(g.transitions).toEqual([['content → content', 6], ['files_with_matches → content', 1]])
    expect(g.contentRerunKinds).toEqual([
      ['identical', 1],
      ['paged (offset)', 1],
      ['head_limit changed', 1],
      ['context/flags changed', 1],
      ['path changed', 1],
      ['glob/type changed', 1],
    ])
    expect(g.pivotThenHint).toBe(1)
    expect(g.pivotThenSame).toBe(1)
    expect(g.pivotThenNothing).toBe(1)
  })

  test('printGrep renders the section', () => {
    const lines = printed(() => printGrep(grepReport(grepCalls())))
    expect(lines[0]).toBe('\n== Grep output modes ==')
    expect(lines[1]).toBe('calls=15')
    expect(lines).toContain('  count                n=   1 (  6.7%) chars=    0.0K median=  0.0K no-match=1 errors=0')
    expect(lines).toContain('  main: content:11  files_with_matches:1  count:1  symbols:1')
    expect(lines).toContain('  sub-agents: files_with_matches:1')
    expect(lines).toContain('  inputs: head_limit=4 (of which 0=unlimited: 3 / 13.7K) context(-A/-B/-C)=5 path=6 glob/type=2 multiline=1')
    expect(lines).toContain('    head_limit=0 by mode: content:3;  content & >6K: 2 / 13.7K')
    expect(lines).toContain('  results: auto-pivot→symbols=3 explicit symbols=1 incomplete=1 ignored-fallback=1 paginated=1')
    expect(lines).toContain('  same-pattern re-runs: content → content:6  files_with_matches → content:1')
    expect(lines).toContain('    head_limit on the >6K content results: 0:2')
    expect(lines).toContain('  after auto-pivot: took hint (head_limit/narrower)=1 re-ran same=1 no re-run=1')
    expect(lines).toContain('  glob with a "/": path is the cwd 0 (empty 0), path elsewhere 0 (empty 0); negated with path elsewhere 0')
  })
})

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const SUB_FILE = '/t/a/subagents/x.jsonl'
const AUTO_OUTLINE =
  "<system-reminder>\nFile '/repo/big.ts' (1200 lines) is large — showing a structural outline.\nFile is large; returned outline instead of full body.\n</system-reminder>\nfn a 1-10"
const EXPLICIT_OUTLINE = "<system-reminder>\nStructural outline of '/repo/big.ts' (1200 lines)\n</system-reminder>\nfn a 1-10"
const OVERCAP_OUTLINE =
  "<system-reminder>\nFile '/repo/huge.ts' (9000 lines) exceeds the read cap — showing a structural outline.\n</system-reminder>\nfn h 1-10"
const BATCH = { file_paths: ['/repo/a.ts', '/repo/b.md'] }
const BATCH_SMALL = '==> a.ts <==\n     1→const a = 1\n\n==> b.md <==\n     1→# b'
const BATCH_BIG = `==> a.ts <==\n${'a'.repeat(11_000)}\n\n==> b.md <==\n${'b'.repeat(200)}`

function readCalls(): Call[] {
  const read = (input: Record<string, unknown>, text: string, extra: Partial<Call> = {}): Call => call('Read', input, text, extra)
  const big = '/repo/big.ts'
  const walked = '/repo/walk.ts'
  const jumped = '/repo/jump.ts'
  return [
    // The auto-outline, then a symbol, an explicit outline and the full body.
    read({ file_path: big }, AUTO_OUTLINE),
    read({ file_path: big, symbol: 'foo' }, 'fn foo'),
    read({ file_path: big, view: 'outline' }, EXPLICIT_OUTLINE),
    read({ file_path: big, view: 'full' }, 'b'.repeat(500)),
    read({ file_path: '/repo/huge.ts' }, OVERCAP_OUTLINE),
    call('Patch', { patchText: `*** Begin Patch\n*** Update File: ${walked}\n@@\n-a\n+b\n*** Add File: /repo/new.ts\n+x\n*** End Patch` }, 'ok'),
    // Three slices, each resuming where the last one ended.
    read({ file_path: walked, offset: 1, limit: 100 }, 'w'.repeat(300)),
    read({ file_path: walked, offset: 101, limit: 100 }, 'w'.repeat(300)),
    read({ file_path: walked, offset: 205, limit: 100 }, 'w'.repeat(300)),
    // Three slices that jump, then the outline.
    read({ file_path: jumped, offset: 1, limit: 50 }, 'j'.repeat(50)),
    read({ file_path: jumped, offset: 500, limit: 50 }, 'j'.repeat(50)),
    read({ file_path: jumped, limit: 10 }, 'j'.repeat(50)),
    read({ file_path: jumped, view: 'outline' }, EXPLICIT_OUTLINE.replace('big.ts', 'jump.ts')),
    read({ file_path: '/repo/doc.pdf', pages: '1-3' }, 'pdf'),
    read({ file_path: '/repo/data.json' }, 'j'.repeat(11_000)),
    read({ file_path: '/repo/notes.md' }, 'n'.repeat(12_000)),
    call('Edit', { file_path: '/repo/data.json' }, 'ok'),
    read({ file_path: '/repo/data.json', offset: 5, limit: 5 }, 'jjjjj'),
    read(BATCH, BATCH_SMALL),
    read(BATCH, BATCH_SMALL),
    read(BATCH, BATCH_BIG),
    read({ file_path: '/repo/err.ts' }, 'File does not exist.', { isError: true }),
    read({ file_path: '/repo/sub.ts', symbol: 'x' }, 'fn x', { sub: true, file: SUB_FILE }),
    read({ file_paths: ['/repo/a.ts', '/repo/c.ts'], view: 'outline' }, '==> a.ts <==\nfn a 1-10\n\n==> c.ts <==\nfn c 1-10', { sub: true, file: SUB_FILE }),
    read({ file_path: '/repo/never.ts' }, '', { answered: false }),
  ]
}

describe('readReport', () => {
  test('answered reads by requested shape, and the outline leads', () => {
    const r = readReport(readCalls())
    expect(r.calls).toBe(22)
    // Four of them batches of two files: a file read is the unit below.
    expect(r.fileReads).toBe(26)
    expect(r.batchCalls).toBe(4)
    expect(r.batchFiles).toBe(8)
    expect(Object.fromEntries(r.byShape.map(s => [s.shape, s.n]))).toEqual({
      'full(default)': 11,
      symbol: 2,
      outline: 4,
      'full(explicit)': 1,
      range: 7,
      'pdf-pages': 1,
    })
    expect(r.byShape.find(s => s.shape === 'range')).toEqual({ shape: 'range', n: 7, chars: 900 + 150 + 5, median: 50, errors: 0 })
    expect(r.byShape.find(s => s.shape === 'full(default)')?.errors).toBe(1)
    expect(r.byShapeMain).toEqual([['full(default)', 11], ['range', 7], ['outline', 2], ['symbol', 1], ['full(explicit)', 1], ['pdf-pages', 1]])
    expect(r.byShapeSub).toEqual([['outline', 2], ['symbol', 1]])
    expect(r.outlineResults).toBe(4)
    expect(r.overcap).toBe(1)
    expect(r.autoPivots).toBe(1)
    expect(r.autoPivotChars).toBe(AUTO_OUTLINE.length)
    expect(r.autoPivotSourceLines).toBe(1200)
  })

  test('what followed an outline on the same path', () => {
    const r = readReport(readCalls())
    expect(r.followAfterAuto).toEqual([['symbol', 1]])
    expect(r.followAfterExplicit).toEqual([['none', 2], ['full(explicit)', 1]])
    expect(r.outlineThenFullSameFile).toBe(1)
    expect(r.outlineThenFullChars).toBe(500)
  })

  test('slice-walks, contiguous or not, and a read right after an edit', () => {
    const r = readReport(readCalls())
    expect(r.sliceWalks).toBe(2)
    expect(r.sliceWalkCalls).toBe(6)
    expect(r.sliceWalkChars).toBe(900 + 150)
    expect(r.contiguousWalks).toBe(1)
    expect(r.contiguousWalkCalls).toBe(3)
    expect(r.contiguousWalkChars).toBe(900)
    // The first slice after the Patch, and the range after the Edit.
    expect(r.readAfterEdit).toBe(2)
    expect(r.readAfterEditChars).toBe(300 + 5)
  })

  // Until 2026-11-16 a batch, having no `file_path`, was one read of an empty
  // path: a blank basename at the top of the table, the extension "(none)".
  test('a batch Read is one read of each of its files', () => {
    const r = readReport(readCalls())
    // Ten paths in the main transcript, a.ts and b.md among them, and three in the fork's.
    expect(r.distinctPaths).toBe(13)
    expect(r.rereadPaths).toBe(5)
    expect(r.rereadExtraCalls).toBe(3 + 2 + 3 + 2 + 2)
    expect(r.rereadBasenames.map(x => [x.base, x.n])).toEqual([['a.ts', 3], ['walk.ts', 3], ['big.ts', 4], ['jump.ts', 4], ['b.md', 3]])
    // Each file's own section of the three results, not the whole results.
    expect(r.rereadBasenames[0]).toEqual({ base: 'a.ts', n: 3, chars: 2 * '     1→const a = 1'.length + 11_000, shapes: [['full(default)', 3]] })
    expect(r.rereadBasenames[4]?.chars).toBe(2 * '     1→# b'.length + 200)
    expect(r.defaultOver10k).toBe(3)
    // The 11K file of the big batch, by its own extension; its 200-char neighbour is not one.
    expect(r.defaultOver10kChars).toBe(11_000 + 12_000 + 11_000)
    expect(r.defaultOver10kExt).toEqual([['.json', 1], ['.md', 1], ['.ts', 1]])
  })

  test('a batch result that does not split per file shares its size and keeps every path', () => {
    const r = readReport([
      call('Read', { file_paths: ['/repo/x.ts', '/repo/y.ts', '/repo/z.ts'] }, 'e'.repeat(90), { isError: true }),
    ])
    expect(r.calls).toBe(1)
    expect(r.fileReads).toBe(3)
    expect(r.distinctPaths).toBe(3)
    expect(r.byShape).toEqual([{ shape: 'full(default)', n: 3, chars: 90, median: 30, errors: 3 }])
  })

  test('printRead renders the section', () => {
    const lines = printed(() => printRead(readReport(readCalls())))
    expect(lines[0]).toBe('\n== Read shape ==')
    expect(lines[1]).toBe('calls=22 file reads=26 (4 batch calls carried 8) distinct paths (per transcript)=13')
    // Shares are of the 26 file reads.
    expect(lines[2]).toStartWith('  full(default)    n=  11 ( 42.3%) chars=')
    expect(lines).toContain('  range            n=   7 ( 26.9%) chars=    1.0K median=  0.0K errors=0')
    expect(lines).toContain('  main: full(default):11  range:7  outline:2  symbol:1  full(explicit):1  pdf-pages:1')
    expect(lines).toContain('  sub-agents: outline:2  symbol:1')
    expect(lines).toContain('  outline results=4 of which auto-pivot=1 (0.2K sent for 1,200 source lines) overcap=1')
    expect(lines).toContain('  follow-up after AUTO outline (same path): symbol:1')
    expect(lines).toContain('  follow-up after EXPLICIT outline (same path): none:2  full(explicit):1')
    expect(lines).toContain('  outline → full body of the same file: 1 (0.5K — the outline bought nothing there)')
    // As above: the batch's files under their own extension and basename.
    expect(lines).toContain('  full(default) bodies >10K that did NOT pivot: 3 / 33.2K  by ext: .json:1 .md:1 .ts:1')
    expect(lines).toContain('  paths read ≥3× in one transcript: 5 paths, 12 extra reads, 12.3K')
    expect(lines).toContain(`    ${'a.ts'.padEnd(34)} n=  3 chars=  10.8K  full(default):3`)
    expect(lines).toContain(`    ${'b.md'.padEnd(34)} n=  3 chars=   0.2K  full(default):3`)
    expect(lines).toContain('  slice-walks (3+ range reads of a path with no outline/symbol first): 2 paths, 6 calls, 1.0K')
    expect(lines).toContain('    of which contiguous (each offset resumes where the last slice ended): 1 paths, 3 calls, 0.9K')
    expect(lines).toContain('  read of a path right after editing it: 2 calls, 0.3K')
  })
})

// ---------------------------------------------------------------------------
// Overview, WaitFor and symbols, printed
// ---------------------------------------------------------------------------

describe('overview', () => {
  const calls = (): Call[] => [
    call('Read', { file_path: '/repo/a.ts', view: 'outline' }, 'x'.repeat(2048)),
    call('Read', { file_path: '/repo/a.ts', symbol: 'a' }, 'fn a', { sub: true, file: SUB_FILE }),
    call('Grep', { pattern: 'a', output_mode: 'symbols' }, 'fn a'),
    call('Bash', { command: 'false' }, 'Exit code 1', { isError: true, session: 'b', file: '/t/b.jsonl' }),
    call('Rename', { symbol: 'a' }, 'ok'),
    call('LSP', { operation: 'hover' }, 'ok'),
    call('WaitFor', { command: 'gh run watch', timeout_s: 60 }, '[WaitFor: timeout after 60s, 6 polls]'),
  ]

  test('tool calls by result chars, across sessions and transcripts', () => {
    const o = overview(calls())
    expect(o.calls).toBe(7)
    expect(o.totalChars).toBe(2048 + 4 + 4 + 11 + 2 + 2 + 37)
    expect(o.sessions).toBe(2)
    expect(o.transcripts).toBe(3)
    expect(o.subCalls).toBe(1)
    expect(o.byTool[0]).toEqual(['Read', { n: 2, chars: 2052, errors: 0, sub: 1 }])
    expect(o.byTool.find(([tool]) => tool === 'Bash')?.[1]).toEqual({ n: 1, chars: 11, errors: 1, sub: 0 })
    expect(o.symbolTools).toEqual({ Rename: 1, LSP: 1 })
  })

  test('printOverview, printWait and printSymbols render their sections', () => {
    const all = calls()
    const o = overview(all)
    const lines = printed(() => {
      printOverview(o)
      printWait(waitReport(all))
      printSymbols(o, grepReport(all), readReport(all))
    })
    expect(lines).toEqual([
      '== Overview ==',
      'sessions=2 transcripts=3 tool calls=7 (sub-agent 1) result chars=2.1K',
      '  Read               n=    2 chars=     2.0K ( 97.3%) errors=  0 sub=1',
      '  WaitFor            n=    1 chars=     0.0K (  1.8%) errors=  0 sub=0',
      '  Bash               n=    1 chars=     0.0K (  0.5%) errors=  1 sub=0',
      '  Grep               n=    1 chars=     0.0K (  0.2%) errors=  0 sub=0',
      '  Rename             n=    1 chars=     0.0K (  0.1%) errors=  0 sub=0',
      '  LSP                n=    1 chars=     0.0K (  0.1%) errors=  0 sub=0',
      '\n== WaitFor ==',
      'calls=1 runs=1 (with >1 call: 0) re-polls=0 (after a timeout: 0) waited=1min',
      '  ended by: timeout:1',
      '  CI polls (gh pr|run): 1 timed out=1',
      '  timeout_s asked: 60:1',
      '\n== Symbols surface ==',
      '  Read outline (explicit)=1  Read auto-outline=0  Read symbol=1  Grep symbols (explicit)=1  Grep auto-pivot=0  Rename=1  LSP=1',
    ])
  })

  test('a failed wait ends by error, whatever its text says', () => {
    const w = waitReport([call('WaitFor', { command: 'cat f' }, '[WaitFor: aborted after 2s, 1 polls]', { isError: true })])
    expect(w.reasons).toEqual([['error', 1]])
    expect(w.waitedMin).toBeCloseTo(2 / 60)
  })
})

// ---------------------------------------------------------------------------
// Args, the walk and the script itself, over synthetic transcripts
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  test('reads the window, the project and the excluded sessions', () => {
    expect(parseArgs(['--since=2026-11-14', '--until=2026-11-15', '--project=-proj', '--exclude=a,b', '--json'])).toEqual({
      since: '2026-11-14',
      until: '2026-11-15',
      project: '-proj',
      exclude: new Set(['a', 'b']),
      json: true,
    })
  })

  test('defaults to today, in local time, with nothing excluded', () => {
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    expect(parseArgs([])).toEqual({ since: today, until: today, project: null, exclude: new Set(), json: false })
  })
})

type Rec = Record<string, unknown>

describe('walk and the script over synthetic transcripts', () => {
  const SCRIPT = join(import.meta.dir, 'feature-usage-census.ts')
  // Local noon: the window is by local date.
  const noon = (day: number): string => new Date(2026, 10, day, 12).toISOString()
  const use = (id: string, name: string, input: Rec): Rec => ({ type: 'tool_use', id, name, input })
  const says = (day: number | null, content: unknown, extra: Rec = {}): Rec => ({
    type: 'assistant',
    ...(day === null ? {} : { timestamp: noon(day) }),
    message: { content },
    ...extra,
  })
  const answers = (id: string, content: unknown, extra: Rec = {}): Rec => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] },
  })
  const READ_A = use('r1', 'Read', { file_path: '/repo/a.ts' })

  let root = ''
  let files: string[] = []

  // Each file a minute older than the one before: main() walks newest first.
  let written = 0
  const put = (rel: string, recs: readonly (Rec | string)[]): string => {
    const path = join(root, 'projects', '-proj', rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, recs.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n\n')
    const mtime = new Date(2026, 10, 15, 12, -written++)
    utimesSync(path, mtime, mtime)
    return path
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'feature-usage-census-test-'))
    files = [
      put('s1.jsonl', [
        { type: 'summary', summary: 's' },
        says(14, [{ type: 'text', text: 'hi' }, null, 'stray', READ_A], { cwd: '/repo' }),
        answers('r1', 'body'),
        answers('r1', 'a second result for the same use'),
        'not json',
        { type: 'user', message: { content: 'a plain prompt' } },
        says(14, [use('b1', 'Bash', { command: 'ls' })]),
        answers('b1', [{ type: 'text', text: 'boom' }], { is_error: true }),
        says(13, [use('u1', 'WaitFor', { command: 'cat f' })]),
        says(null, [use('n1', 'Bash', { command: 'pwd' })]),
        answers('n1', '/repo'),
      ]),
      // The fork: the parent's Read again, then a Grep of its own.
      put('s1/subagents/agent-a.jsonl', [
        says(14, [READ_A], { cwd: '/elsewhere' }),
        answers('r1', 'the mirrored result'),
        says(14, [use('g1', 'Grep', { pattern: 'x', output_mode: 'content' })]),
        answers('g1', 'a.ts:1:x'),
      ]),
      put('s2.jsonl', [says(14, [use('e1', 'Edit', { file_path: '/repo/a.ts' })]), answers('e1', 'ok')]),
      join(root, 'projects', '-proj', 'removed-since-listing.jsonl'),
    ]
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('each tool use once, paired with its first result, in transcript order', () => {
    const calls = walk(files)
    expect(calls.map(c => [c.id, c.tool, c.session, c.sub, c.text, c.isError, c.answered])).toEqual([
      ['r1', 'Read', 's1', false, 'body', false, true],
      ['b1', 'Bash', 's1', false, 'boom', true, true],
      ['u1', 'WaitFor', 's1', false, '', false, false],
      ['n1', 'Bash', 's1', false, '/repo', false, true],
      ['g1', 'Grep', 's1', true, 'a.ts:1:x', false, true],
      ['e1', 'Edit', 's2', false, 'ok', false, true],
    ])
    expect(calls.map(c => c.seq)).toEqual([0, 1, 2, 3, 4, 5])
    expect(calls[0]).toMatchObject({ file: files[0]!, cwd: '/repo', chars: 4, ts: Date.parse(noon(14)), input: { file_path: '/repo/a.ts' } })
    expect(calls[1]!.cwd).toBe('')
    expect(calls[3]!.ts).toBeNaN()
    expect(calls[4]!.file).toBe(files[1]!)
  })

  // main() itself: the corpus root follows CLAUDIN_CONFIG_DIR, in the child only.
  const run = (...args: string[]) =>
    Bun.spawnSync([process.execPath, SCRIPT, '--project=-proj', ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDIN_CONFIG_DIR: root },
      stdout: 'pipe',
      stderr: 'pipe',
    })
  type Json = { overview: ReturnType<typeof overview>; read: ReturnType<typeof readReport>; wait: ReturnType<typeof waitReport> }

  test('the script keeps the calls dated inside the window, by local date', () => {
    const day = run('--since=2026-11-14', '--until=2026-11-14', '--json')
    expect(day.stderr.toString()).toBe('')
    expect(day.exitCode).toBe(0)
    const r = JSON.parse(day.stdout.toString()) as Json
    // r1, b1, g1 and e1: u1 is from the 13th, and n1 has no timestamp.
    expect(r.overview.calls).toBe(4)
    expect(r.overview.sessions).toBe(2)
    expect(r.overview.subCalls).toBe(1)
    expect(r.read.calls).toBe(1)
    expect(r.wait.waits).toBe(0)

    const both = JSON.parse(run('--since=2026-11-13', '--until=2026-11-14', '--json').stdout.toString()) as Json
    expect(both.overview.calls).toBe(5)
    expect(both.wait.waits).toBe(1)
  })

  test('the script leaves an excluded session out and prints every section', () => {
    const text = run('--since=2026-11-14', '--until=2026-11-14', '--exclude=s2')
    expect(text.exitCode).toBe(0)
    const lines = text.stdout.toString().split('\n')
    expect(lines[0]).toBe('window=2026-11-14..2026-11-14 files scanned=3 excluded sessions=s2')
    expect(lines[1]).toBe('== Overview ==')
    expect(lines[2]).toBe('sessions=1 transcripts=2 tool calls=3 (sub-agent 1) result chars=0.0K')
    for (const section of ['== Bash output filter ==', '== Grep output modes ==', '== Read shape ==', '== WaitFor ==', '== Symbols surface ==']) {
      expect(lines).toContain(section)
    }
  })

  test('the script exits 1 when the window holds no tool call', () => {
    const none = run('--since=2026-11-13', '--until=2026-11-13', '--exclude=s1')
    expect(none.exitCode).toBe(1)
    expect(none.stdout.toString()).toBe('')
    expect(none.stderr.toString()).toContain('no tool calls between 2026-11-13 and 2026-11-13 under ')
  })
})
