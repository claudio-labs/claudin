// Reads the structure of one compact JSONL line straight from its bytes,
// without parsing it: where a string ends, and whether an offset names a member
// of the line's outermost object. Large tool outputs stay unparsed this way.

const QUOTE = 0x22
const BACKSLASH = 0x5c
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d
const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d

/** Every offset in `buf[from, to)` where `needle` starts, ascending. */
export function occurrences(
  buf: Buffer,
  needle: Buffer,
  from: number,
  to: number,
): number[] {
  // A view bounds the search to the line, so a miss does not scan the rest of the buffer.
  const range = buf.subarray(from, to)
  const found: number[] = []
  for (let at = range.indexOf(needle); at !== -1; at = range.indexOf(needle, at + 1)) {
    found.push(from + at)
  }
  return found
}

/** Offset of the quote closing the string opened at `open`, or -1 if none does before `end`. */
export function stringEnd(buf: Buffer, open: number, end: number): number {
  let from = open + 1
  while (from < end) {
    const quote = buf.indexOf(QUOTE, from)
    if (quote === -1 || quote >= end) return -1
    let backslashes = 0
    while (buf[quote - 1 - backslashes] === BACKSLASH) backslashes++
    // An odd run escapes the quote; an even run is escaped backslashes before a real one.
    if (backslashes % 2 === 0) return quote
    from = quote + 1
  }
  return -1
}

/**
 * The first of `candidates` (ascending offsets of a quote opening a member
 * name) that names a member of the outermost object of the line starting at
 * `lineStart`, or -1. String contents are skipped whole, so braces, brackets
 * and escaped quotes inside them never change the depth.
 */
export function firstTopLevelMember(
  buf: Buffer,
  lineStart: number,
  candidates: readonly number[],
): number {
  const last = candidates.at(-1)
  if (last === undefined) return -1
  const wanted = new Set(candidates)
  let depth = 0
  let at = lineStart
  while (at <= last) {
    const byte = buf[at]
    if (byte === QUOTE) {
      if (depth === 1 && wanted.has(at)) return at
      const close = stringEnd(buf, at, buf.length)
      if (close === -1) return -1
      at = close + 1
      continue
    }
    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth++
    else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) depth--
    at++
  }
  return -1
}
