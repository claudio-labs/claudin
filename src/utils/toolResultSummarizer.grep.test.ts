/**
 * Regression suite for the Grep summarizer strategy (R1–R11 of
 * .claudin/plans/agile-roaming-puddle.md).
 *
 * Most of the weight here is on what must NOT change: the strategy rewrites a
 * payload the model reads on every search, so a silent regression is expensive
 * and invisible. Fixtures under __fixtures__/grepSamples are real ripgrep
 * output lifted from session transcripts, normalized the way GrepTool emits it
 * today and scrubbed with EQUAL-LENGTH placeholders — the ROI floors below
 * assert reduction percentages, so a shorter placeholder would shift them all.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

import {
  maybeSummarizeToolResult,
  summarizeGrepOutput,
} from './toolResultSummarizer.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'

const FIXTURE_DIR = join(import.meta.dir, '__fixtures__', 'grepSamples')

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.txt`), 'utf8')
}

function bodyOf(text: string): string {
  const result = summarizeGrepOutput(text)
  return result === null ? text : result.body
}

const MATCH_RE = /^(.+?):(\d+):/
const CONTEXT_RE = /^(.+?)-(\d+)-/

/** Locators (`file:line`) of every MATCH line in a raw ripgrep body. */
function matchLocators(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const m = MATCH_RE.exec(line)
    const c = CONTEXT_RE.exec(line)
    if (m && (!c || m[1]!.length <= c[1]!.length)) out.push(`${m[1]}:${m[2]}`)
  }
  return out
}

const BLOCK_HEADER_RE = /^--- (.+) \(\d+ match(?:es)?\) ---$/
const BLOCK_LINE_RE = /^(\d+)([:-])/
const OTHER_HEADER = '--- other (preserved literally) ---'

/**
 * Rebuilds `file:line` locators from a SUMMARIZED body, where the path lives on
 * the block header and each line carries only `NN:text`. The honesty checks
 * below are about what the model can still resolve, so they go through the same
 * reconstruction the model would.
 */
function blockLocators(body: string): { matches: string[]; context: string[] } {
  const matches: string[] = []
  const context: string[] = []
  let file: string | null = null
  for (const line of body.split('\n')) {
    if (line === OTHER_HEADER) break
    const header = BLOCK_HEADER_RE.exec(line)
    if (header) {
      file = header[1]!
      continue
    }
    const entry = BLOCK_LINE_RE.exec(line)
    if (!entry || file === null) continue
    ;(entry[2] === ':' ? matches : context).push(`${file}:${entry[1]}`)
  }
  return { matches, context }
}

// ---------------------------------------------------------------------------
// R10 — ROI floor table. One row per fixture; `floor` is the minimum acceptable
// reduction of the strategy body. The floors sit a few points under what the
// current build measures, deliberately tight: a floor with slack is a floor
// that no longer notices a rung being switched off. Every rung of the strategy
// is load-bearing for at least one row — clamp (context-*), dedupe (dup-heavy),
// per-file cap (dup-heavy), file cap (multi-file), literal bucket
// (legacy-mixed-paths) — so disabling any one of them fails a row here.
// Modelled on src/outputFilter/Bash/phase13Report.test.ts.
// ---------------------------------------------------------------------------
type Row = {
  fixture: string
  shape: string
  floor: number
  /** Strings that MUST survive the strategy. */
  preserves: string[]
}

const ROWS: Row[] = [
  {
    fixture: 'context-12',
    shape: 'context-heavy (-C 12)',
    floor: 90,
    preserves: ['performCodexRequest'],
  },
  {
    fixture: 'context-30',
    shape: 'context-heavy (-C 30)',
    floor: 90,
    preserves: ['planModeHardDenyIfApplicable'],
  },
  {
    fixture: 'unscoped-wide',
    shape: 'unscoped, wide context',
    floor: 85,
    preserves: ['getProjectActiveProvider'],
  },
  {
    fixture: 'single-file',
    shape: 'single file, huge context',
    floor: 88,
    preserves: ['writeFileSyncAndFlush'],
  },
  {
    fixture: 'legacy-mixed-paths',
    shape: 'absolute context + relative matches',
    floor: 18,
    preserves: ['planModeHardDenyIfApplicable'],
  },
  // Match-only bodies: the per-file header replaces the path on every line it
  // covers, so these shrink too — they did NOT while the path was repeated
  // under the header, and the no-win guard threw both summaries away.
  {
    fixture: 'dup-heavy',
    shape: 'match-only, repeated bodies',
    floor: 28,
    preserves: ['FILE_EDIT_TOOL_NAME'],
  },
  {
    fixture: 'multi-file',
    shape: 'match-only, 66 files',
    floor: 12,
    preserves: [],
  },
]

describe('grep summarizer — ROI floors (R10)', () => {
  for (const row of ROWS) {
    test(`${row.fixture} (${row.shape})`, () => {
      const text = fixture(row.fixture)
      const body = bodyOf(text)
      const reduction = 100 * (1 - body.length / text.length)
      expect(reduction).toBeGreaterThanOrEqual(row.floor)
      for (const needle of row.preserves) {
        expect(body).toContain(needle)
      }
    })
  }
})

describe('grep summarizer — identity guards', () => {
  // R1: a body the strategy cannot parse is returned untouched.
  test('R1 leaves an unparseable body alone', () => {
    for (const name of ['no-path-prefix', 'no-line-numbers', 'zero-matches']) {
      expect(summarizeGrepOutput(fixture(name))).toBeNull()
    }
  })

  // R1b: the dispatch threshold is the other identity path, and the one that
  // actually fires in production — `under-threshold` is a body the strategy
  // would happily shrink by ~39%, which the caller must still leave alone.
  test('R1b a result below the dispatch threshold is not summarized', () => {
    const text = fixture('under-threshold')
    expect(text.length).toBeLessThan(6000)
    expect(bodyOf(text).length).toBeLessThan(text.length)
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 'under-threshold',
      content: text,
    }
    expect(maybeSummarizeToolResult(block, GREP_TOOL_NAME)).toBe(block)
  })

  // R6: the strategy may legitimately not shrink a body, but the caller's
  // no-win guard is the only thing standing between that and a bigger payload.
  //
  // One match per file is the shape that always grows: the block header costs
  // more than the one path it replaces. Built here rather than taken from a
  // fixture because every fixture now shrinks — a growth pin that depends on a
  // fixture staying bad stops guarding the moment the fixture gets better.
  test('R6 a body that grows is never shipped', () => {
    const growing = Array.from({ length: 50 }, (_, i) => {
      const pad = `value ${i} `.repeat(11)
      return `src/generated/module-${String(i).padStart(2, '0')}.ts:${i + 1}:const v${i} = "${pad}"`
    }).join('\n')
    // Over the dispatch threshold, so the no-win guard — not the threshold — is
    // what has to catch this.
    expect(growing.length).toBeGreaterThan(6000)
    expect(bodyOf(growing).length).toBeGreaterThan(growing.length)
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 'no-win',
      content: growing,
    }
    expect(maybeSummarizeToolResult(block, GREP_TOOL_NAME).content).toBe(growing)
  })

  // R2: the killswitch must be a real escape hatch — with it set, even a
  // fixture the strategy would shrink by 87% comes back untouched.
  test('R2 the env killswitch returns the block unchanged', () => {
    const before = process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER
    process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER = '1'
    try {
      const block = {
        type: 'tool_result' as const,
        tool_use_id: 'killswitch',
        content: fixture('context-30'),
      }
      expect(maybeSummarizeToolResult(block, GREP_TOOL_NAME)).toBe(block)
    } finally {
      if (before === undefined) {
        delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER
      } else {
        process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER = before
      }
    }
  })

  // R4: dispatch is by tool name. A grep-shaped body handed to another tool
  // must not pick up the grep strategy.
  test('R4 another tool never gets the grep strategy', () => {
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 'other-tool',
      content: fixture('context-30'),
    }
    const out = maybeSummarizeToolResult(block, 'Read')
    expect(out).toBe(block)
    const bash = maybeSummarizeToolResult(block, 'Bash')
    expect(String(bash.content)).not.toContain('Grep summary:')
  })

  // R5: determinism — the persisted-result path keys on content being stable
  // for a given id (toolResultStorage.ts writes with 'wx' and treats EEXIST as
  // "already persisted").
  test('R5 is deterministic across runs', () => {
    for (const name of ['context-12', 'dup-heavy', 'legacy-mixed-paths']) {
      const text = fixture(name)
      expect(bodyOf(text)).toBe(bodyOf(text))
    }
  })

  // R3: idempotency. The STRATEGY is not idempotent — a grouped body re-parses
  // as fresh grep output — so the guarantee lives in the caller, which refuses
  // to touch a block that already carries the summary marker. Pin that, because
  // it is the thing production depends on.
  test('R3 an already-summarized block is left alone by the caller', () => {
    const once = bodyOf(fixture('context-12'))
    const wrapped = `<tool-result-summary tool="Grep" original="12.5KB" kept="1.8KB" strategy="grep-grouped">\n${once}\n</tool-result-summary>`
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 'idempotency',
      content: wrapped,
    }
    expect(maybeSummarizeToolResult(block, GREP_TOOL_NAME)).toBe(block)
  })
})

describe('grep summarizer — honesty', () => {
  // R7: every match that existed must still be reachable — either printed, or
  // counted in a `+N more matches` / `<omitted>` line.
  test('R7 no match line vanishes silently', () => {
    // dup-heavy trips the per-file cap (14 matches in one file) and multi-file
    // trips the 50-file cap, so both accounting lines are exercised — with only
    // the context fixtures neither cap ever fires and the test is vacuous.
    for (const name of [
      'context-12',
      'context-30',
      'unscoped-wide',
      'dup-heavy',
      'multi-file',
    ]) {
      const text = fixture(name)
      const body = bodyOf(text)
      const locators = matchLocators(text)
      expect(locators.length).toBeGreaterThan(0)
      const printed = new Set(blockLocators(body).matches)
      const shown = locators.filter(l => printed.has(l))
      const accountedFor =
        shown.length +
        [...body.matchAll(/\+(\d+) more match/g)].reduce(
          (n, m) => n + Number(m[1]),
          0,
        ) +
        [...body.matchAll(/<omitted>: \d+ files?, (\d+) match/g)].reduce(
          (n, m) => n + Number(m[1]),
          0,
        )
      expect(accountedFor).toBeGreaterThanOrEqual(locators.length)
    }
  })

  // R7b: the caps must actually fire on the fixtures R7 leans on, otherwise
  // R7 is satisfied by "everything was printed" and guards nothing.
  test('R7b the fixtures behind R7 really do hit both caps', () => {
    expect(bodyOf(fixture('dup-heavy'))).toContain(' more match')
    expect(bodyOf(fixture('multi-file'))).toContain('<omitted>:')
  })

  // R8: the header counts must equal what the body actually contains.
  test('R8 header counts match the input', () => {
    const text = fixture('context-12')
    const body = bodyOf(text)
    const header = body.split('\n')[0]!
    const matches = Number(/matches=(\d+)/.exec(header)?.[1])
    expect(matches).toBe(matchLocators(text).length)

    const files = Number(/files=(\d+)/.exec(header)?.[1])
    const distinctFiles = new Set(
      matchLocators(text).map(l => l.slice(0, l.lastIndexOf(':'))),
    )
    expect(files).toBe(distinctFiles.size)

    // context=kept/total — kept must never exceed total, and must equal the
    // number of context lines actually printed.
    const ctx = /context=(\d+)\/(\d+)/.exec(header)
    expect(ctx).not.toBeNull()
    const kept = Number(ctx![1])
    const total = Number(ctx![2])
    expect(kept).toBeLessThanOrEqual(total)
    expect(blockLocators(body).context.length).toBe(kept)
  })

  // R8b: `total` is the honest denominator — every context line rg emitted,
  // including the ones that ended up in the literal bucket. legacy-mixed-paths
  // is the fixture where those two numbers differ.
  test('R8b the context denominator counts every context line', () => {
    const text = fixture('legacy-mixed-paths')
    const body = bodyOf(text)
    const ctx = /context=(\d+)\/(\d+)/.exec(body.split('\n')[0]!)
    expect(ctx).not.toBeNull()
    const rawContext = text
      .split('\n')
      .filter(l => l && !MATCH_RE.test(l) && CONTEXT_RE.test(l)).length
    expect(Number(ctx![2])).toBeLessThanOrEqual(rawContext)
    expect(Number(ctx![1])).toBe(blockLocators(body).context.length)
  })

  // R9: fail-open on malformed input — never throw, never empty.
  test('R9 malformed bodies do not throw', () => {
    const malformed = [
      '--',
      '\n\n\n',
      'C:\\proj\\a.ts:12:const x = 1\nC:\\proj\\a.ts-13-  helper()',
      'src/a.ts:notanumber:text',
      '\u0000\u0001binary junk\u0002',
      'src/a.ts:1:ok\n--\nsrc/a.ts-2-ctx',
    ]
    for (const text of malformed) {
      expect(() => summarizeGrepOutput(text)).not.toThrow()
      const body = bodyOf(text)
      expect(typeof body).toBe('string')
      expect(body.length).toBeGreaterThan(0)
    }
  })
})

describe('grep summarizer — context handling', () => {
  const pad = ' '.repeat(60)
  // A single match with 12 lines of context either side, one file only, so no
  // other rung (per-file cap, file cap, dedupe) can absorb the signal.
  const wide = [
    ...Array.from(
      { length: 12 },
      (_, i) => `src/a.ts-${100 + i}-before ${i}${pad}`,
    ),
    `src/a.ts:112:the match${pad}`,
    ...Array.from(
      { length: 12 },
      (_, i) => `src/a.ts-${113 + i}-after ${i}${pad}`,
    ),
  ].join('\n')

  test('keeps context within ±3 of a match and drops the rest', () => {
    const body = bodyOf(wide)
    expect(body).toContain('--- src/a.ts (1 match) ---')
    expect(body).toContain('112:the match')
    // 109..111 and 113..115 survive; 108 and 116 do not.
    const { context } = blockLocators(body)
    expect(context).toContain('src/a.ts:109')
    expect(context).toContain('src/a.ts:115')
    expect(context).not.toContain('src/a.ts:108')
    expect(context).not.toContain('src/a.ts:116')
  })

  test('sorts each file block by line number', () => {
    // Fed deliberately out of order: ripgrep itself emits ascending lines, so
    // the sort is what guarantees the clamp's anchors and the emitted block
    // agree. Ordered input would let the test pass with the sort deleted.
    const shuffled = [
      'src/a.ts:30:third',
      'src/a.ts:10:first',
      'src/a.ts-11-context after first',
      'src/a.ts:20:second',
    ].join('\n')
    const numbers = bodyOf(shuffled)
      .split('\n')
      .map(l => /^(\d+)[:-]/.exec(l)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
    expect(numbers).toEqual([10, 11, 20, 30])
  })

  test('drops the rg block separator and blank context lines', () => {
    const withNoise = [
      'src/a.ts:10:hit one',
      'src/a.ts-11-',
      '--',
      'src/a.ts:40:hit two',
    ].join('\n')
    const body = bodyOf(withNoise)
    // Not `toContain('--')`: the file headers legitimately contain dashes. The
    // separator survives as a LINE, which is what must be gone — including out
    // of the "preserved literally" bucket at the end of the body.
    expect(body.split('\n')).not.toContain('--')
    expect(blockLocators(body).context).not.toContain('src/a.ts:11')
    expect(body).toContain('10:hit one')
    expect(body).toContain('40:hit two')
  })

  test('collapses a repeated body to a back-reference that resolves', () => {
    const long = 'const duplicated = someVeryLongCallExpression(withArguments)'
    const text = [
      `src/a.ts:10:${long}`,
      `src/b.ts:20:${long}`,
      `src/c.ts:30:${long}`,
    ].join('\n')
    const body = bodyOf(text)
    // The back-reference stays fully qualified — it points into another file's
    // block, where a bare line number would resolve against the wrong header.
    expect(body).toContain('… same as src/a.ts:10')
    // The referenced line is present in the output, not dropped by another rung.
    expect(blockLocators(body).matches).toContain('src/a.ts:10')
    expect(body).toContain(`10:${long}`)
    expect(body.length).toBeLessThan(text.length + 200)
  })

  test('does not collapse a body shorter than the reference to it', () => {
    const text = ['src/a.ts:10:x', 'src/b.ts:20:x'].join('\n')
    const body = bodyOf(text)
    expect(body).not.toContain('same as')
    expect(body).toContain('20:x')
  })

  test('a context-only file is preserved literally, never dropped', () => {
    const text = [
      'src/a.ts:10:the match',
      '/abs/path/b.ts-99-orphan context line that has no anchor',
    ].join('\n')
    const body = bodyOf(text)
    expect(body).toContain('other (preserved literally)')
    expect(body).toContain('orphan context line that has no anchor')
    // The literal bucket has no header above it, so it keeps its full path.
    expect(body).toContain('/abs/path/b.ts-99-')
  })
})

describe('grep summarizer — line splitting', () => {
  test('does not repeat the path under its own block header', () => {
    const path = 'src/services/api/providerConfiguration.ts'
    const text = [
      `${path}:10:const a = 1`,
      `${path}-11-  helper()`,
      `${path}:20:const b = 2`,
    ].join('\n')
    const body = bodyOf(text)
    expect(body).toContain(`--- ${path} (2 matches) ---`)
    // Exactly once, in the header. This is the whole saving on a match-only
    // body: the path is the longest term on most ripgrep lines.
    expect(body.split(path).length - 1).toBe(1)
    expect(body).toContain('10:const a = 1')
    expect(body).toContain('11-  helper()')
  })

  test('splits a path that contains its own separator run', () => {
    // `-2026-` inside the file name reads as a line-number separator, so the
    // leftmost split called this file `notes/report` at line 2026 on every
    // line — a file with context and no match, i.e. the literal bucket, i.e.
    // no summary at all. This repo has such names under .claudin/memory/team/.
    const path = 'notes/report-2026-07-25.md'
    const text = [
      `${path}:10:const a = 1`,
      `${path}-11-  helper()`,
      `${path}:12:const b = 2`,
    ].join('\n')
    const body = bodyOf(text)
    expect(body).toContain(`--- ${path} (2 matches) ---`)
    expect(body).not.toContain('other (preserved literally)')
    expect(blockLocators(body).matches).toEqual([`${path}:10`, `${path}:12`])
  })

  test('still reads a code line whose text contains a separator run', () => {
    // The other direction: `:2:` inside the code text must not win over the
    // real prefix. Two lines of one file, so the vote has something to go on.
    const text = [
      'src/ratio.ts:10:if (ratio === 1:2:3) return',
      'src/ratio.ts:11:if (ratio === 4:5:6) return',
    ].join('\n')
    const body = bodyOf(text)
    expect(body).toContain('--- src/ratio.ts (2 matches) ---')
    expect(body).toContain('10:if (ratio === 1:2:3) return')
  })

  test('a file or a line body named __proto__ does not throw', () => {
    // `byFile[file] = []` on a plain object with file === '__proto__' sets the
    // prototype instead of a key, and the next `.push` throws — inside a
    // strategy whose entire contract is to fail open. Same for a line body of
    // '__proto__' or 'toString' reaching the dedupe map.
    const text = [
      '__proto__:10:__proto__',
      '__proto__:11:toString',
      '__proto__:12:__proto__',
      'src/b.ts:1:constructor',
    ].join('\n')
    expect(() => summarizeGrepOutput(text)).not.toThrow()
    const body = bodyOf(text)
    expect(body).toContain('--- __proto__ (3 matches) ---')
    expect(body).toContain('10:__proto__')
  })
})
