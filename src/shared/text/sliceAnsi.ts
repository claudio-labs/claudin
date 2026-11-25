import {
  type AnsiCode,
  ansiCodesToString,
  reduceAnsiCodes,
  tokenize,
  undoAnsiCodes,
} from '@alcalzone/ansi-tokenize'
import { stringWidth } from 'src/terminal/ink/stringWidth.js'

// A code is an "end code" if its code equals its endCode (e.g., hyperlink close)
function isEndCode(code: AnsiCode): boolean {
  return code.code === code.endCode
}

// Filter to only include "start codes" (not end codes)
function filterStartCodes(codes: AnsiCode[]): AnsiCode[] {
  return codes.filter(c => !isEndCode(c))
}

export type SliceAnsiOptions = {
  /**
   * Keep the result within `end - start` cells: a wide glyph that would
   * straddle `end` is left out instead of included whole. The default keeps
   * the partitioning contract (`slice(0, k) + slice(k)` is the original) that
   * splitting callers need; a caller clipping to a cell budget sets this.
   */
  fitEnd?: boolean
}

// Display width, not code units. Combining marks (Devanagari matras, virama,
// diacritics) are width 0, and the tokenizer's fullWidth flag wins over
// stringWidth, which can count a glyph carrying VS16 as one cell.
function tokenCells(token: ReturnType<typeof tokenize>[number]): number {
  return token.type !== 'char'
    ? 0
    : token.fullWidth
      ? 2
      : stringWidth(token.value)
}

/**
 * The cells a string occupies, counted the way sliceAnsi counts them. A caller
 * that walks a string in chunks measures with this, not stringWidth, so the
 * walk and the slices agree.
 */
export function displayCells(str: string): number {
  let cells = 0
  for (const token of tokenize(str)) {
    cells += tokenCells(token)
  }
  return cells
}

/**
 * Slice a string containing ANSI escape codes, and report the cells consumed
 * from `start` — what a chunked walk advances by.
 *
 * Unlike the slice-ansi package, this properly handles OSC 8 hyperlink
 * sequences because @alcalzone/ansi-tokenize tokenizes them correctly.
 */
export function sliceAnsiCells(
  str: string,
  start: number,
  end?: number,
  options?: SliceAnsiOptions,
): { text: string; width: number } {
  const fitEnd = options?.fitEnd === true
  // Don't pass `end` to tokenize — it counts code units, not display cells,
  // so it drops tokens early for text with zero-width combining marks.
  const tokens = tokenize(str)
  let activeCodes: AnsiCode[] = []
  let position = 0
  let result = ''
  let include = false

  for (const token of tokens) {
    // Callers pass start/end in display cells, so position tracks the same
    // units (counting code units advanced past `end` early on combining marks).
    const width = tokenCells(token)

    // Break AFTER trailing zero-width marks — a combining mark attaches to
    // the preceding base char, so "भा" (भ + ा, 1 display cell) sliced at
    // end=1 must include the ा. Breaking on position >= end BEFORE the
    // zero-width check would drop it and render भ bare. ANSI codes are
    // width 0 but must NOT be included past end (they open new style runs
    // that leak into the undo sequence), so gate on char type too. The
    // !include guard ensures empty slices (start===end) stay empty even
    // when the string starts with a zero-width char (BOM, ZWJ).
    if (end !== undefined && position >= end) {
      if (token.type !== 'char' || width > 0 || !include) break
    }

    if (token.type === 'ansi') {
      activeCodes.push(token)
      if (include) {
        // Emit all ANSI codes during the slice
        result += token.code
      }
    } else if (token.type === 'control') {
      // Zero-width control sequences (not style codes, so they don't join
      // activeCodes) are passed through verbatim while inside the slice.
      if (include) {
        result += token.code
      }
    } else {
      if (fitEnd && end !== undefined && width > 0 && position + width > end) {
        break
      }

      if (!include && position >= start) {
        // Skip leading zero-width marks at the start boundary — they belong
        // to the preceding base char in the left half. Without this, the
        // mark appears in BOTH halves: left+right ≠ original. Only applies
        // when start > 0 (otherwise there's no preceding char to own it).
        if (start > 0 && width === 0) continue
        include = true
        // Reduce and filter to only active start codes
        activeCodes = filterStartCodes(reduceAnsiCodes(activeCodes))
        result = ansiCodesToString(activeCodes)
      }

      if (include) {
        result += token.value
      }

      position += width
    }
  }

  const width = Math.max(0, position - start)

  // Nothing was emitted, so no style was opened that would need closing.
  if (!include) return { text: result, width }

  // Only undo start codes that are still active
  const activeStartCodes = filterStartCodes(reduceAnsiCodes(activeCodes))
  result += ansiCodesToString(undoAnsiCodes(activeStartCodes))
  return { text: result, width }
}

/** Slice a string containing ANSI escape codes. */
export default function sliceAnsi(
  str: string,
  start: number,
  end?: number,
  options?: SliceAnsiOptions,
): string {
  return sliceAnsiCells(str, start, end, options).text
}
