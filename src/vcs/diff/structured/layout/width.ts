import { stringWidth } from 'src/terminal/ink/stringWidth.js'

/** A grapheme cluster and the terminal columns it takes. */
export type Cell = { text: string; columns: number }

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const PRINTABLE_ASCII = /^[\u0020-\u007E]*$/

/** The width a diff is drawn at: whole columns, and never less than one. */
export function effectiveWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1
}

/** How many digits a line number prints with. */
export function digitCount(lineNumber: number): number {
  return String(Math.max(0, Math.trunc(lineNumber))).length
}

/** The cells a terminal draws text in, wide characters taking the columns they cover. */
export function cellsOf(text: string): Cell[] {
  if (PRINTABLE_ASCII.test(text)) return Array.from(text, char => ({ text: char, columns: 1 }))
  return Array.from(GRAPHEMES.segment(text), ({ segment }) => ({ text: segment, columns: stringWidth(segment) }))
}
