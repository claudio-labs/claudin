import type { DiffSegment } from 'src/vcs/diff/ui/types.js'

/**
 * Maps each **rendered** diff row back to the new-file line number it shows, so
 * a visual selection in the pane can be turned into an `@path#La-Lb` mention.
 *
 * Why this is not trivial: `renderDiffRows` hands back opaque ANSI strings from
 * `ColorDiff.render()` with no metadata, and a long source line wraps to
 * several rows. The authoritative numbers live in the segments
 * (`StructuredPatchHunk.newStart` plus the `+`/`-`/` ` prefixes on `lines`), so
 * they come from there; the rendered rows are only asked the much weaker
 * question "does this row start a new logical line, or continue the previous
 * one?", which its gutter answers by carrying a number or not.
 *
 * Fails closed rather than guessing: if the two sides disagree on how many
 * logical lines there are, it returns `null` and the caller disables selection
 * for that file instead of attaching a wrong range.
 *
 * Pure (no React/ink imports) so it is unit-testable — importing the `.tsx`
 * would pull in `ink.js` → the build-time-stubbed analytics module.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001B\[[0-9;]*m/g
/** `  123 + code` / `  123   code` — the gutter a rendered diff row starts with. */
const GUTTER_RE = /^\s*(\d+)\s/
/** A collapsed-gap marker row (`··· 8 lines ────`). */
const GAP_PREFIX = '···'

/**
 * New-file line number per logical line, in render order. `null` where the
 * line has none: a removed (`-`) line, or a collapsed-gap marker.
 */
export function logicalLineNumbers(segments: DiffSegment[]): (number | null)[] {
  const out: (number | null)[] = []
  for (const segment of segments) {
    if (segment.kind === 'gap') {
      out.push(null)
      continue
    }
    let newLine = segment.hunk.newStart
    for (const raw of segment.hunk.lines) {
      const marker = raw[0]
      if (marker === '-') {
        out.push(null)
        continue
      }
      // Context and additions both advance the new-file cursor.
      out.push(newLine)
      newLine += 1
    }
  }
  return out
}

/**
 * `rows[i]` → new-file line number, or `null` for a wrap continuation, a
 * removed line or a gap marker. `null` overall when the rendered rows and the
 * segments disagree.
 */
export function buildRowLineIndex(
  segments: DiffSegment[],
  rows: string[],
): (number | null)[] | null {
  const logical = logicalLineNumbers(segments)
  const index: (number | null)[] = []
  let logicalIndex = -1
  for (const row of rows) {
    const plain = row.replace(ANSI_RE, '')
    const startsLogicalLine =
      plain.trimStart().startsWith(GAP_PREFIX) || GUTTER_RE.test(plain)
    if (startsLogicalLine) logicalIndex += 1
    if (logicalIndex < 0 || logicalIndex >= logical.length) return null
    index.push(startsLogicalLine ? (logical[logicalIndex] ?? null) : null)
  }
  // A row count that never reached the last logical line means the two sides
  // disagree — bail rather than attach a range built on a guess.
  if (rows.length > 0 && logicalIndex !== logical.length - 1) return null
  return index
}

/**
 * New-file line range covered by rendered rows `from..to` (inclusive), or
 * `null` when the selection has no new-file lines at all (a block of pure
 * deletions, or only gap markers).
 */
export function selectionRange(
  index: (number | null)[],
  from: number,
  to: number,
): { start: number; end: number } | null {
  const lo = Math.max(0, Math.min(from, to))
  const hi = Math.min(index.length - 1, Math.max(from, to))
  let start: number | null = null
  let end: number | null = null
  for (let i = lo; i <= hi; i++) {
    const line = index[i]
    if (line == null) continue
    if (start === null || line < start) start = line
    if (end === null || line > end) end = line
  }
  return start === null || end === null ? null : { start, end }
}

export type ScreenRowSpan = {
  /** Absolute screen row of the pane's FIRST content row (border excluded). */
  firstContentRow: number
  /** Content rows the pane shows. */
  height: number
  /** Index into `diffRows` of the row drawn at `firstContentRow`. */
  scrollOffset: number
  /** The selection's endpoints, in absolute screen rows, in any order. */
  fromRow: number
  toRow: number
}

/**
 * New-file line range for a selection expressed in ABSOLUTE SCREEN rows — what
 * a mouse drag gives us, as opposed to the rendered-row indices `v` works in.
 *
 * The screen rows are clipped to the pane first, so a drag that runs off the
 * top or bottom attaches the part that was actually over the diff instead of
 * nothing. Returns null when the drag never overlapped the pane at all, or
 * when the rows it covered carry no new-file lines (pure deletions).
 */
export function rangeFromScreenRows(
  index: (number | null)[],
  { firstContentRow, height, scrollOffset, fromRow, toRow }: ScreenRowSpan,
): { start: number; end: number } | null {
  const lastContentRow = firstContentRow + height - 1
  const lo = Math.max(firstContentRow, Math.min(fromRow, toRow))
  const hi = Math.min(lastContentRow, Math.max(fromRow, toRow))
  if (lo > hi) return null
  return selectionRange(
    index,
    scrollOffset + (lo - firstContentRow),
    scrollOffset + (hi - firstContentRow),
  )
}
