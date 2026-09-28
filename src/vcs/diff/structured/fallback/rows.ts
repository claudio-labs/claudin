import type { StructuredPatchHunk } from 'diff'
import { type Emphasis, wordByWordSpans } from 'src/vcs/diff/structured/fallback/wordChanges.js'
import { type HunkLine, type LineKind, readHunkLines } from 'src/vcs/diff/structured/hunk/lines.js'
import { digitCount, effectiveWidth } from 'src/vcs/diff/structured/layout/width.js'
import { type Span, wrapSpans } from 'src/vcs/diff/structured/layout/wrap.js'

/** One terminal row of the plain diff. */
export type FallbackRow = {
  kind: LineKind
  /** The line number, on the first row of a line only. */
  number: number | null
  spans: Span<Emphasis>[]
  /** Blank columns after the code that bring the row to the full width. */
  fill: number
}

type FallbackLayout = {
  /** The width of the line-number column, one more than the digits of the largest number. */
  numberWidth: number
  rows: FallbackRow[]
}

/** What the gutter holds after the number column: a space and the marker. */
const GUTTER_AFTER_NUMBER = 2

/**
 * Lays a hunk out as the rows of the plain diff, `width` columns wide. Every
 * row gives its code the same room, the width minus the gutter, and at least
 * one column. The hunk is expected to be sanitized already.
 */
export function layoutFallback(hunk: StructuredPatchHunk, width: number, dim: boolean): FallbackLayout {
  const lines = readHunkLines(hunk)
  const numberWidth = digitCount(largestNumber(lines)) + 1
  const codeWidth = Math.max(1, effectiveWidth(width) - numberWidth - GUTTER_AFTER_NUMBER)
  // A dimmed diff (a rejected edit, say) stays quiet, as on the highlighted path: no word stands out.
  const wordSpans = dim ? new Map<number, Span<Emphasis>[]>() : wordByWordSpans(lines)
  const rows = lines.flatMap((line, index) => {
    const spans = wordSpans.get(index) ?? [{ text: line.code, tag: 'plain' as const }]
    return wrapSpans(spans, codeWidth).map(
      (row, rowIndex): FallbackRow => ({
        kind: line.kind,
        number: rowIndex === 0 ? line.number : null,
        spans: row.spans,
        fill: Math.max(0, codeWidth - row.columns),
      }),
    )
  })
  return { numberWidth, rows }
}

function largestNumber(lines: readonly HunkLine[]): number {
  return lines.reduce((largest, line) => Math.max(largest, line.number ?? 0), 0)
}
