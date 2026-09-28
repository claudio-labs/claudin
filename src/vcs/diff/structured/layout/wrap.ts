import { stringWidth } from 'src/terminal/ink/stringWidth.js'
import { type Cell, cellsOf } from 'src/vcs/diff/structured/layout/width.js'

/** A run of text drawn one way; the tag says which. */
export type Span<Tag> = { text: string; tag: Tag }

/** One row of wrapped text: its spans, and the columns they take. */
type WrappedRow<Tag> = { spans: Span<Tag>[]; columns: number }

type TaggedCell<Tag> = Cell & { tag: Tag }

/** Consecutive cells that are all spaces, or all not. */
type Run<Tag> = { blank: boolean; cells: TaggedCell<Tag>[] }

/**
 * Lays spans out in rows of at most `width` columns. Rows break at spaces and
 * take as many words as fit. A word wider than a row is broken where it meets
 * the edge, and a cell wider than a row gets a row of its own. At a break,
 * the spaces that still fit stay on the row and the rest are dropped. Every
 * piece keeps the tag of the span it came from, so a change of tag inside a
 * word is never a place to break.
 */
export function wrapSpans<Tag>(spans: readonly Span<Tag>[], width: number): WrappedRow<Tag>[] {
  const total = spans.reduce((sum, span) => sum + stringWidth(span.text), 0)
  if (total <= width) return [{ spans: mergeSpans(spans), columns: total }]

  const rows: TaggedCell<Tag>[][] = []
  let row: TaggedCell<Tag>[] = []
  let used = 0
  const endRow = (): void => {
    rows.push(row)
    row = []
    used = 0
  }
  const place = (cell: TaggedCell<Tag>): void => {
    row.push(cell)
    used += cell.columns
  }

  for (const run of runsOf(spans)) {
    const columns = columnsOf(run.cells)
    if (used + columns <= width) {
      run.cells.forEach(place)
    } else if (run.blank) {
      for (const cell of run.cells) {
        if (used + cell.columns > width) break
        place(cell)
      }
      endRow()
    } else if (columns <= width) {
      endRow()
      run.cells.forEach(place)
    } else {
      for (const cell of run.cells) {
        if (used > 0 && used + cell.columns > width) endRow()
        place(cell)
      }
    }
  }
  if (row.length > 0) endRow()
  return rows.map(cells => ({ spans: mergeSpans(cells), columns: columnsOf(cells) }))
}

function runsOf<Tag>(spans: readonly Span<Tag>[]): Run<Tag>[] {
  const runs: Run<Tag>[] = []
  for (const span of spans) {
    for (const cell of cellsOf(span.text)) {
      const blank = cell.text === ' '
      const last = runs.at(-1)
      if (last !== undefined && last.blank === blank) last.cells.push({ ...cell, tag: span.tag })
      else runs.push({ blank, cells: [{ ...cell, tag: span.tag }] })
    }
  }
  return runs
}

function mergeSpans<Tag>(pieces: readonly Span<Tag>[]): Span<Tag>[] {
  const merged: Span<Tag>[] = []
  for (const piece of pieces) {
    if (piece.text === '') continue
    const last = merged.at(-1)
    if (last !== undefined && last.tag === piece.tag) last.text += piece.text
    else merged.push({ text: piece.text, tag: piece.tag })
  }
  return merged
}

function columnsOf(cells: readonly Cell[]): number {
  return cells.reduce((sum, cell) => sum + cell.columns, 0)
}
