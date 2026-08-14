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
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'

const FIXTURE_DIR = join(import.meta.dir, '__fixtures__', 'grepSamples')

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.txt`), 'utf8')
}

function bodyOf(text: string): string {
  const result = summarizeGrepOutput(text)
  return result === null ? text : result.body
}

/** Every recorded shape in the fixture corpus, for the whole-corpus invariants. */
const FIXTURES = [
  'context-12',
  'context-30',
  'dup-heavy',
  'legacy-mixed-paths',
  'multi-file',
  'no-line-numbers',
  'no-path-prefix',
  'single-file',
  'under-threshold',
  'unscoped-wide',
  'zero-matches',
]

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
const INLINE_LINE_RE = /^(.+?)([:-])(\d+)\2/
const OTHER_HEADER = '--- other (preserved literally) ---'

/**
 * Rebuilds `file:line` locators from a SUMMARIZED body. Three line shapes can
 * appear: `NN:text` under a block header (the path is on the header), a full
 * `path:NN:text` where the block was cheaper left inline, and a bare `NN:text`
 * for a single-file search that never had a path. The honesty checks below are
 * about what the model can still resolve, so they go through the same
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
    const bare = BLOCK_LINE_RE.exec(line)
    if (bare) {
      const locator = file === null ? bare[1]! : `${file}:${bare[1]}`
      ;(bare[2] === ':' ? matches : context).push(locator)
      continue
    }
    const inline = INLINE_LINE_RE.exec(line)
    if (!inline) continue
    ;(inline[2] === ':' ? matches : context).push(`${inline[1]}:${inline[3]}`)
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
    expect(summarizeGrepOutput(fixture('no-line-numbers'))).toBeNull()
    expect(
      summarizeGrepOutput('no files were searched, check your glob'),
    ).toBeNull()
    // Parseable but a single line: the strategy may produce something, and the
    // caller must still ship the original — this is 9 bytes.
    const tiny = fixture('zero-matches')
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 'tiny',
      content: tiny,
    }
    expect(maybeSummarizeToolResult(block, GREP_TOOL_NAME)).toBe(block)
  })

  // R1b: the dispatch gate is the other identity path, and the one that
  // actually fires in production. `under-threshold` is a body the strategy
  // would happily shrink by ~40% — it stays untouched because it is under
  // 6,000 AND its summary would count 16 matches away instead of printing
  // them. The lossless half of that rule is exercised below.
  test('R1b a lossy result below the dispatch threshold is not summarized', () => {
    const text = fixture('under-threshold')
    expect(text.length).toBeLessThan(6000)
    expect(summarizeGrepOutput(text)?.matchesElided).toBe(16)
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
    // Two short lines do not pay for a header, so this block stays inline —
    // what matters here is that both lines were split at the path.
    expect(blockLocators(body).matches).toEqual([
      'src/ratio.ts:10',
      'src/ratio.ts:11',
    ])
    expect(body).toContain('src/ratio.ts:10:if (ratio === 1:2:3) return')
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

describe('grep summarizer — when a header is worth its cost', () => {
  test('leaves a block inline when the header would replace one path', () => {
    // One match and no context: the header names a path in order to strip that
    // same path off a single line, and the summary grows. This is the shape the
    // no-win guard was throwing away wholesale.
    const text = [
      'src/services/api/providerConfig.ts:10:the only match here',
      'src/services/api/activeProvider.ts:20:the only match there',
    ].join('\n')
    const body = bodyOf(text)
    expect(body).not.toContain('---')
    expect(body).toContain('src/services/api/providerConfig.ts:10:the only match here')
  })

  test('heads a block as soon as there are lines to amortize it over', () => {
    const path = 'src/services/api/providerConfig.ts'
    const text = [
      `${path}:10:first`,
      `${path}:11:second`,
      `${path}:12:third`,
    ].join('\n')
    const body = bodyOf(text)
    expect(body).toContain(`--- ${path} (3 matches) ---`)
    expect(body.split(path).length - 1).toBe(1)
  })

  test('the choice is made per file, not for the whole body', () => {
    const busy = 'src/busy.ts'
    const lonely = 'src/lonely/path/that/is/long/enough/to/matter.ts'
    const text = [
      ...Array.from({ length: 4 }, (_, i) => `${busy}:${10 + i}:hit ${i}`),
      `${lonely}:99:the only match`,
    ].join('\n')
    const body = bodyOf(text)
    expect(body).toContain(`--- ${busy} (4 matches) ---`)
    expect(body).toContain(`${lonely}:99:the only match`)
    expect(body).not.toContain(`--- ${lonely}`)
  })
})

describe('grep summarizer — searches with no path at all', () => {
  const pad = ' '.repeat(40)
  // What rg emits when the search is scoped to a single file: no filename on
  // any line, just `NN:text`. The strategy parsed none of it and every such
  // result shipped in full.
  const singleFile = [
    ...Array.from({ length: 12 }, (_, i) => `${100 + i}-before ${i}${pad}`),
    `112:the match${pad}`,
    ...Array.from({ length: 12 }, (_, i) => `${113 + i}-after ${i}${pad}`),
  ].join('\n')

  test('clamps context on a body that carries no path', () => {
    const body = bodyOf(singleFile)
    expect(body.length).toBeLessThan(singleFile.length)
    expect(body).toContain(`112:the match${pad}`)
    const { context } = blockLocators(body)
    expect(context).toContain('109')
    expect(context).toContain('115')
    expect(context).not.toContain('108')
    expect(context).not.toContain('116')
  })

  test('emits no header, because there is no path to hoist', () => {
    const body = bodyOf(singleFile)
    expect(body).not.toContain('---')
    // Every surviving line is byte-identical to the one rg emitted.
    for (const line of body.split('\n').slice(1)) {
      expect(singleFile.split('\n')).toContain(line)
    }
  })

  test('a stray line-numbered line in a normal result stays literal', () => {
    // The retry is gated on the majority of lines having no path. Without that
    // gate this line would join a pathless block and become clampable, i.e.
    // droppable — and the literal bucket exists precisely so it cannot be.
    const text = [
      'src/a.ts:10:the match',
      'src/a.ts:11:more of the match',
      '117:const DEFAULT = 250',
    ].join('\n')
    const body = bodyOf(text)
    expect(body).toContain('other (preserved literally)')
    expect(body).toContain('117:const DEFAULT = 250')
  })

  test('a pathless repeat collapses to a line reference, not a bare colon', () => {
    const long = 'const duplicated = someVeryLongCallExpression(withArguments)'
    const text = [`10:${long}`, `20:${long}`, `30:${long}`].join('\n')
    const body = bodyOf(text)
    expect(body).toContain('… same as line 10')
    expect(body).not.toContain(':10:')
  })
})

describe('grep summarizer — the two-tier dispatch gate', () => {
  const pad = ' '.repeat(60)

  /**
   * A body whose ONLY elision is clamped context: one match per file, well
   * under both caps, so `matchesElided` is 0 no matter how much it shrinks.
   * `contextEachSide` sets the size, which is what the gate turns on.
   */
  function losslessBody(contextEachSide: number, files: number): string {
    const out: string[] = []
    for (let f = 0; f < files; f++) {
      const base = 1000 * (f + 1)
      const path = `src/module${f}/handler.ts`
      for (let i = contextEachSide; i > 0; i--) {
        out.push(`${path}-${base - i}-context above ${i}${pad}`)
      }
      out.push(`${path}:${base}:the match in file ${f}${pad}`)
      for (let i = 1; i <= contextEachSide; i++) {
        out.push(`${path}-${base + i}-context below ${i}${pad}`)
      }
    }
    return out.join('\n')
  }

  function ship(text: string, id: string): string | null {
    const block = { type: 'tool_result' as const, tool_use_id: id, content: text }
    const out = maybeSummarizeToolResult(block, GREP_TOOL_NAME)
    return out === block ? null : String(out.content)
  }

  test('below the floor nothing ships, however well it would compress', () => {
    const text = losslessBody(10, 1)
    expect(text.length).toBeLessThan(3000)
    // The strategy itself would gladly take it — the floor is the only thing
    // holding it back, so this fails the moment the floor moves down.
    expect(bodyOf(text).length).toBeLessThan(text.length / 2)
    expect(ship(text, 'below-floor')).toBeNull()
  })

  test('between floor and threshold a lossless summary ships', () => {
    const text = losslessBody(20, 1)
    expect(text.length).toBeGreaterThan(3000)
    expect(text.length).toBeLessThan(6000)
    expect(summarizeGrepOutput(text)?.matchesElided).toBe(0)
    const shipped = ship(text, 'lossless-band')
    expect(shipped).not.toBeNull()
    // Every match rg reported is still individually addressable.
    expect(shipped).toContain('1000:the match in file 0')
  })

  test('between floor and threshold a summary that counts a match away does not', () => {
    // Same band, but one file carries more matches than the per-file cap, so
    // the summary would print `+N more matches` instead of those lines.
    const dense = Array.from(
      { length: 40 },
      (_, i) => `src/dense/registry.ts:${i + 1}:const entry${i} = register()${pad}`,
    ).join('\n')
    expect(dense.length).toBeGreaterThan(3000)
    expect(dense.length).toBeLessThan(6000)
    expect(summarizeGrepOutput(dense)?.matchesElided).toBe(30)
    expect(bodyOf(dense).length).toBeLessThan(dense.length)
    expect(ship(dense, 'lossy-band')).toBeNull()
  })

  test('above the threshold a lossy summary still ships', () => {
    // The rule is a floor concession, not a new restriction: nothing that used
    // to be summarized stops being summarized.
    const text = fixture('multi-file')
    expect(text.length).toBeGreaterThan(6000)
    expect(summarizeGrepOutput(text)?.matchesElided).toBeGreaterThan(0)
    expect(ship(text, 'lossy-over-threshold')).not.toBeNull()
  })

  test('matchesElided counts both elision paths, not just the per-file cap', () => {
    // 60 files > GREP_MAX_FILES, and the first file also blows the per-file
    // cap: the count has to include the `<omitted>` files as well.
    const lines: string[] = []
    for (let i = 0; i < 25; i++) {
      lines.push(`src/busy.ts:${i + 1}:hit ${i}${pad}`)
    }
    for (let f = 0; f < 60; f++) {
      lines.push(`src/other${f}.ts:1:single hit${pad}`)
    }
    const elided = summarizeGrepOutput(lines.join('\n'))?.matchesElided
    // 15 over the per-file cap on busy.ts, plus every file past the 50th.
    expect(elided).toBe(15 + 11)
  })
})

describe('grep summarizer — line shapes that must not surprise it', () => {
  const pad = ' '.repeat(50)

  test('a Windows drive letter is not mistaken for the line-number split', () => {
    // R9 names this case: `C:` looks like the start of a prefix. It is not one
    // (no digits between two separators), but the path also contains the real
    // one, so the vote has to land past the drive letter.
    const path = String.raw`C:\proj\src\a.ts`
    const body = bodyOf(
      [
        `${path}:10:const x = 1${pad}`,
        `${path}-11-const y = 2${pad}`,
        `${path}:12:const z = 3${pad}`,
      ].join('\n'),
    )
    expect(body).toContain(`--- ${path} (2 matches) ---`)
    expect(blockLocators(body).matches).toEqual([`${path}:10`, `${path}:12`])
  })

  test('a path that itself contains `:N:` still groups under its full name', () => {
    // The leftmost split cuts at `:1:` and calls the file `src/a`; that reading
    // pins line 1 on every line, which is exactly what the vote rejects.
    const path = 'src/a:1:b.ts'
    const body = bodyOf(
      [
        `${path}:10:first${pad}`,
        `${path}:11:second${pad}`,
        `${path}:12:third${pad}`,
      ].join('\n'),
    )
    expect(blockLocators(body).matches).toEqual([
      `${path}:10`,
      `${path}:11`,
      `${path}:12`,
    ])
  })

  test('a match whose text is `--` survives; rg\'s own separator does not', () => {
    const body = bodyOf(['src/a.ts:10:--', '--', 'src/a.ts:11:real'].join('\n'))
    expect(body).toContain('src/a.ts:10:--')
    expect(body).toContain('matches=2')
    // The bare separator is dropped, not preserved literally.
    expect(body).not.toContain('other (preserved literally)')
  })

  test('empty match bodies neither crash nor collapse into each other', () => {
    const body = bodyOf(
      ['src/a.ts:10:', 'src/a.ts:11:', 'src/a.ts:12:'].join('\n'),
    )
    expect(body).toContain('matches=3')
    // A back-reference to an empty body would be longer than the body itself.
    expect(body).not.toContain('… same as')
  })

  test('carriage returns and control bytes come back byte for byte', () => {
    const text = [
      `src/a.ts:10:one\r`,
      `src/a.ts:11:\u0000\u0001\u0002binary\r`,
      `src/a.ts:12:three\r`,
    ].join('\n')
    const body = bodyOf(text)
    expect(body).toContain(`10:one\r`)
    expect(body).toContain(`11:\u0000\u0001\u0002binary\r`)
  })

  test('a line number is printed exactly as rg wrote it', () => {
    // `n` is a number for sorting and the clamp; printing it would rewrite
    // `007` as `7` and hand back a locator that is not what the source said.
    const body = bodyOf(
      [`src/a.ts:007:x${pad}`, `src/a.ts:008:y${pad}`, `src/a.ts:009:z${pad}`].join(
        '\n',
      ),
    )
    expect(body).toContain('src/a.ts:007:x')
    expect(body).not.toContain('src/a.ts:7:x')
  })

  test('a back-reference quotes the line number rg wrote, not a parsed one', () => {
    // The marker is the one place a locator is built rather than reproduced,
    // so it needs its own pin: a target of `src/a.ts:7` resolves to nothing in
    // a body whose lines all say `007`.
    const long = 'const shared = aVeryLongCallExpression(withSeveralArguments)'
    const body = bodyOf(
      [`src/a.ts:007:${long}`, `src/b.ts:1:${long}`].join('\n'),
    )
    expect(body).toContain('… same as src/a.ts:007')
  })

  test('a filename that mimics a block header does not break the grouping', () => {
    const path = 'src/--- fake (9 matches) ---.ts'
    const body = bodyOf(
      [`${path}:10:one${pad}`, `${path}:11:two${pad}`, `${path}:12:three${pad}`].join(
        '\n',
      ),
    )
    expect(body).toContain('matches=3')
    expect(body).toContain('one')
    expect(body).toContain('three')
  })
})

describe('grep summarizer — boundaries of the two caps', () => {
  const pad = ' '.repeat(50)
  const file = (n: number): string =>
    Array.from({ length: n }, (_, i) => `src/a.ts:${i + 1}:hit ${i}${pad}`).join(
      '\n',
    )
  const files = (n: number): string =>
    Array.from({ length: n }, (_, i) => `src/f${i}.ts:1:hit ${i}${pad}`).join('\n')

  test('a file at exactly the per-file cap elides nothing', () => {
    const r = summarizeGrepOutput(file(10))!
    expect(r.matchesElided).toBe(0)
    expect(r.body).not.toContain('more match')
  })

  test('one match past the cap elides exactly one', () => {
    const r = summarizeGrepOutput(file(11))!
    expect(r.matchesElided).toBe(1)
    expect(r.body).toContain('+1 more match')
    expect(r.body).not.toContain('+1 more matches')
  })

  test('a result at exactly the file cap omits nothing', () => {
    const r = summarizeGrepOutput(files(50))!
    expect(r.matchesElided).toBe(0)
    expect(r.body).not.toContain('<omitted>')
  })

  test('one file past the cap omits exactly one', () => {
    const r = summarizeGrepOutput(files(51))!
    expect(r.matchesElided).toBe(1)
    expect(r.body).toContain('<omitted>: 1 file, 1 match not shown')
  })
})

describe('grep summarizer — back-references resolve backwards', () => {
  const pad = ' '.repeat(50)

  /** Every `file:line` a summarized body prints, in the order it prints them. */
  function locatorsInOrder(body: string): string[] {
    const out: string[] = []
    let file: string | null = null
    for (const line of body.split('\n')) {
      const header = /^--- (.+) \(\d+ match(?:es)?\) ---$/.exec(line)
      if (header) {
        file = header[1]!
        continue
      }
      const bare = /^(\d+)[:-]/.exec(line)
      if (bare) {
        out.push(file === null ? bare[1]! : `${file}:${bare[1]}`)
        continue
      }
      const inline = /^(.+?)([:-])(\d+)\2/.exec(line)
      if (inline) out.push(`${inline[1]}:${inline[3]}`)
    }
    return out
  }

  function forwardReferences(body: string): string[] {
    const seen = new Set<string>()
    const bad: string[] = []
    let file: string | null = null
    for (const line of body.split('\n')) {
      const header = /^--- (.+) \(\d+ match(?:es)?\) ---$/.exec(line)
      if (header) {
        file = header[1]!
        continue
      }
      const ref = /… same as (?:line )?(.+?)\s*$/.exec(line)
      if (ref) {
        const target = ref[1]!.includes(':') ? ref[1]! : ref[1]!
        if (!seen.has(target)) bad.push(`${line} → ${target}`)
      }
      const bare = /^(\d+)[:-]/.exec(line)
      if (bare) {
        seen.add(file === null ? bare[1]! : `${file}:${bare[1]}`)
        continue
      }
      const inline = /^(.+?)([:-])(\d+)\2/.exec(line)
      if (inline) seen.add(`${inline[1]}:${inline[3]}`)
    }
    return bad
  }

  // R7's other half: a marker the model cannot resolve is worse than the
  // repeated text it replaced, and the two ways to produce one are pointing at
  // a line a later rung removed, or pointing forward into a block that has not
  // been printed yet.
  for (const name of FIXTURES) {
    test(`${name}: every back-reference points at an earlier line`, () => {
      const result = summarizeGrepOutput(fixture(name))
      if (result === null) return
      expect(forwardReferences(result.body)).toEqual([])
    })
  }

  test('a repeat of a line the per-file cap removed is printed in full', () => {
    // src/a.ts has 12 matches and a cap of 10, so line 12 is never printed.
    // src/b.ts repeats its body — and must not point at a line that is gone.
    const repeated = `UNIQUE BODY NUMBER 11 that is quite long indeed${pad}`
    const text = [
      ...Array.from(
        { length: 12 },
        (_, i) => `src/a.ts:${i + 1}:UNIQUE BODY NUMBER ${i} that is quite long indeed${pad}`,
      ),
      `src/b.ts:1:${repeated}`,
    ].join('\n')
    const body = bodyOf(text)
    expect(body).toContain(`src/b.ts:1:${repeated}`)
    expect(body).not.toContain('… same as src/a.ts:12')
    expect(forwardReferences(body)).toEqual([])
  })

  test('files tied on match count are emitted in name order', () => {
    // Determinism has a second consumer: a back-reference is only readable if
    // the block it points into came first, and ties decide that order.
    const body = bodyOf(
      [
        `src/zebra.ts:1:shared body that is long enough to dedupe${pad}`,
        `src/zebra.ts:2:second${pad}`,
        `src/alpha.ts:1:shared body that is long enough to dedupe${pad}`,
        `src/alpha.ts:2:second${pad}`,
      ].join('\n'),
    )
    expect(locatorsInOrder(body)[0]).toBe('src/alpha.ts:1')
    expect(body).toContain('… same as src/alpha.ts:1')
    expect(forwardReferences(body)).toEqual([])
  })
})
