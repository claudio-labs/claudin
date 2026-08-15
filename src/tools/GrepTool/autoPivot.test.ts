/**
 * Unit suite for the Grep auto-pivot policy. The tool-level behavior (does a
 * broad search actually come back as a map) lives in GrepTool.test.ts; this
 * file pins the gate itself and the one downstream contract the pivot depends
 * on — that a pivoted body survives the summarizer untouched.
 */
import { describe, expect, test } from 'bun:test'

import {
  GREP_AUTO_PIVOT_FOOTER,
  GREP_PIVOT_MIN_FILES,
  GREP_PIVOT_THRESHOLD_CHARS,
  GREP_PIVOT_THRESHOLD_MATCH_LINES,
  grepAutoPivotEnabled,
  measureGrepShape,
  pivotWins,
  shouldAutoPivot,
} from 'src/tools/GrepTool/autoPivot.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { maybeSummarizeToolResult } from 'src/services/tools/toolResultSummarizer.js'

/** Defaults for the non-shape half of the decision: nothing suppressing. */
function decide(
  shape: { chars: number; matchLines: number; files: number },
  overrides: Partial<{
    headLimitGiven: boolean
    offset: number
    lineNumbers: boolean
  }> = {},
): boolean {
  return shouldAutoPivot({
    shape,
    headLimitGiven: false,
    offset: 0,
    lineNumbers: true,
    ...overrides,
  })
}

const WIDE = {
  chars: GREP_PIVOT_THRESHOLD_CHARS,
  matchLines: 10,
  files: GREP_PIVOT_MIN_FILES,
}

describe('measureGrepShape', () => {
  test('counts match lines and their distinct files', () => {
    const shape = measureGrepShape(
      [
        '/repo/src/a.ts:12:const needle = 1',
        '/repo/src/a.ts:40:needle()',
        '/repo/src/b.ts:7:needle',
      ],
      120,
    )

    expect(shape).toEqual({ chars: 120, matchLines: 3, files: 2 })
  })

  test('ignores -A/-B/-C context lines', () => {
    const shape = measureGrepShape(
      [
        '/repo/src/a.ts-11-// before',
        '/repo/src/a.ts:12:const needle = 1',
        '/repo/src/a.ts-13-// after',
      ],
      90,
    )

    expect(shape.matchLines).toBe(1)
    expect(shape.files).toBe(1)
  })

  test('a single-file search (rg drops the path prefix) measures as no files', () => {
    const shape = measureGrepShape(['12:const needle = 1', '40:needle()'], 40)

    expect(shape.files).toBe(0)
    expect(decide(shape)).toBe(false)
  })
})

describe('shouldAutoPivot — triggers', () => {
  test('pivots on the char trigger once the search is wide enough', () => {
    expect(decide(WIDE)).toBe(true)
  })

  test('pivots on the match-line trigger below the char threshold', () => {
    expect(
      decide({
        chars: GREP_PIVOT_THRESHOLD_CHARS - 1,
        matchLines: GREP_PIVOT_THRESHOLD_MATCH_LINES,
        files: GREP_PIVOT_MIN_FILES,
      }),
    ).toBe(true)
  })

  test('a big result in few files keeps its lines', () => {
    expect(
      decide({
        chars: GREP_PIVOT_THRESHOLD_CHARS * 10,
        matchLines: GREP_PIVOT_THRESHOLD_MATCH_LINES * 10,
        files: GREP_PIVOT_MIN_FILES - 1,
      }),
    ).toBe(false)
  })

  test('a wide but small result keeps its lines', () => {
    expect(
      decide({
        chars: GREP_PIVOT_THRESHOLD_CHARS - 1,
        matchLines: GREP_PIVOT_THRESHOLD_MATCH_LINES - 1,
        files: GREP_PIVOT_MIN_FILES * 4,
      }),
    ).toBe(false)
  })
})

describe('shouldAutoPivot — suppression', () => {
  test('an explicit head_limit means the caller sized the output', () => {
    expect(decide(WIDE, { headLimitGiven: true })).toBe(false)
  })

  test('paginating with offset is never interrupted', () => {
    expect(decide(WIDE, { offset: 250 })).toBe(false)
  })

  test('without line numbers there is nothing to map', () => {
    expect(decide(WIDE, { lineNumbers: false })).toBe(false)
  })
})

describe('pivotWins', () => {
  test('accepts a map that is materially smaller', () => {
    expect(pivotWins(2_000, 10_000)).toBe(true)
  })

  test('rejects a map that only shaves the edges', () => {
    expect(pivotWins(9_000, 10_000)).toBe(false)
  })

  test('rejects a map bigger than the lines it would replace', () => {
    expect(pivotWins(12_000, 10_000)).toBe(false)
  })
})

describe('grepAutoPivotEnabled', () => {
  const force = process.env.CLAUDIN_FORCE_GREP_AUTO_PIVOT
  const disable = process.env.CLAUDIN_DISABLE_GREP_AUTO_PIVOT

  function restore(): void {
    if (force === undefined) delete process.env.CLAUDIN_FORCE_GREP_AUTO_PIVOT
    else process.env.CLAUDIN_FORCE_GREP_AUTO_PIVOT = force
    if (disable === undefined) delete process.env.CLAUDIN_DISABLE_GREP_AUTO_PIVOT
    else process.env.CLAUDIN_DISABLE_GREP_AUTO_PIVOT = disable
  }

  test('the force flag turns it on under test', () => {
    process.env.CLAUDIN_FORCE_GREP_AUTO_PIVOT = '1'
    delete process.env.CLAUDIN_DISABLE_GREP_AUTO_PIVOT
    try {
      expect(grepAutoPivotEnabled()).toBe(true)
    } finally {
      restore()
    }
  })

  test('the killswitch wins over the force flag', () => {
    process.env.CLAUDIN_FORCE_GREP_AUTO_PIVOT = '1'
    process.env.CLAUDIN_DISABLE_GREP_AUTO_PIVOT = '1'
    try {
      expect(grepAutoPivotEnabled()).toBe(false)
    } finally {
      restore()
    }
  })
})

/**
 * The pivot happens inside the tool, so its body reaches the Grep summarizer
 * afterwards. A symbol map is not `path:NN:text`, so the strategy must leave it
 * alone — if a future map format starts parsing as ripgrep output, the
 * summarizer would regroup and clamp a body that has no context lines to clamp,
 * and this test is what catches it.
 */
describe('a pivoted body survives the summarizer', () => {
  test('is returned byte-identical', () => {
    const blocks: string[] = []
    for (let i = 0; i < 40; i++) {
      blocks.push(
        `src/services/module${i}/handler.ts\n` +
          `  ${10 + i}-${80 + i}  export async function handleRequest${i}(input: RequestInput, ctx: Context)\n` +
          `  ${120 + i}-${190 + i}  function normalizePayload${i}(raw: unknown): Payload`,
      )
    }
    const body =
      `Found 80 matched symbols across 40 files (pagination = limit: 250)\n` +
      `The search matched 812 lines in 96 files; the first 250 are mapped below.\n\n` +
      `${blocks.join('\n\n')}${GREP_AUTO_PIVOT_FOOTER}`

    // Guard the guard: below the dispatch floor the summarizer never runs and
    // this test would pass without asserting anything.
    expect(body.length).toBeGreaterThan(6_000)

    const out = maybeSummarizeToolResult(
      { type: 'tool_result', tool_use_id: 'pivot', content: body },
      GREP_TOOL_NAME,
    )

    expect(out.content).toBe(body)
  })
})
