/**
 * Parser-wide context: AST node type, threaded ParseState, and the helpers
 * (`mk`, `leaf`, `sliceBytes`, `checkBudget`) that every grammar function in
 * the parser uses.
 *
 * Kept separate from the lexer (no lexer-internal knowledge) and from the
 * grammar (no statement/word/expression specifics) so it can be imported by
 * both without creating cycles.
 */

import { byteAt, type Lexer } from './lexer.js'

export type TsNode = {
  type: string
  text: string
  startIndex: number
  endIndex: number
  children: TsNode[]
}

/**
 * 50ms wall-clock cap — bails out on pathological/adversarial input.
 * Pass `Infinity` via `parse(src, Infinity)` to disable (e.g. correctness
 * tests, where CI jitter would otherwise cause spurious null returns).
 */
export const PARSE_TIMEOUT_MS = 50

/** Node budget cap — bails out before OOM on deeply nested input. */
export const MAX_NODES = 50_000

export type ParseState = {
  L: Lexer
  src: string
  srcBytes: number
  /** True when byte offsets == char indices (no multi-byte UTF-8) */
  isAscii: boolean
  nodeCount: number
  deadline: number
  aborted: boolean
  /** Depth of backtick nesting — inside `...`, ` terminates words */
  inBacktick: number
  /** When set, parseSimpleCommand stops at this token (for `[` backtrack) */
  stopToken: string | null
}

export function byteLengthUtf8(s: string): number {
  let b = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) b++
    else if (c < 0x800) b += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      b += 4
      i++
    } else b += 3
  }
  return b
}

export function checkBudget(P: ParseState): void {
  P.nodeCount++
  if (P.nodeCount > MAX_NODES) {
    P.aborted = true
    throw new Error('budget')
  }
  if ((P.nodeCount & 0x7f) === 0 && performance.now() > P.deadline) {
    P.aborted = true
    throw new Error('timeout')
  }
}

/** Build a node. Slices text from source by byte range via char-index lookup. */
export function mk(
  P: ParseState,
  type: string,
  start: number,
  end: number,
  children: TsNode[],
): TsNode {
  checkBudget(P)
  return {
    type,
    text: sliceBytes(P, start, end),
    startIndex: start,
    endIndex: end,
    children,
  }
}

export function sliceBytes(
  P: ParseState,
  startByte: number,
  endByte: number,
): string {
  if (P.isAscii) return P.src.slice(startByte, endByte)
  // Find char indices for byte offsets. Build byte table if needed.
  const L = P.L
  if (!L.byteTable) byteAt(L, 0)
  const t = L.byteTable!
  // Binary search for char index where byte offset matches
  let lo = 0
  let hi = P.src.length
  while (lo < hi) {
    const m = (lo + hi) >>> 1
    if (t[m]! < startByte) lo = m + 1
    else hi = m
  }
  const sc = lo
  lo = sc
  hi = P.src.length
  while (lo < hi) {
    const m = (lo + hi) >>> 1
    if (t[m]! < endByte) lo = m + 1
    else hi = m
  }
  return P.src.slice(sc, lo)
}

export function leaf(
  P: ParseState,
  type: string,
  tok: { start: number; end: number },
): TsNode {
  return mk(P, type, tok.start, tok.end, [])
}
