// Byte-level JSONL helpers for resume.
//
// When a tool result is too large, its `tool_result` content becomes a
// `<persisted-output>` preview, but the line still carries the raw result as
// the top-level `toolUseResult` member (see buildLargeToolResultMessage in
// src/agent/tools/toolResultStorage.ts). Resume cuts that member out of the
// bytes before anything is parsed. It walks bytes on purpose: parsing the line
// would materialize the raw result, which can be megabytes long, and that is
// what ran long sessions out of memory. Every other byte comes back as it was,
// because transcripts are files users keep across versions.

const LF = 0x0a
const CR = 0x0d
const TAB = 0x09
const SPACE = 0x20
const QUOTE = 0x22
const COMMA = 0x2c
const BACKSLASH = 0x5c
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d
const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d

const PREVIEW_TAG = Buffer.from('<persisted-output>')
const RAW_RESULT_MEMBER = Buffer.from('"toolUseResult":')

type Span = readonly [start: number, end: number]

function isJsonWhitespace(byte: number | undefined): boolean {
  return byte === SPACE || byte === TAB || byte === LF || byte === CR
}

function skipWhitespaceForward(bytes: Uint8Array, from: number): number {
  let i = from
  while (i < bytes.length && isJsonWhitespace(bytes[i])) i++
  return i
}

function skipWhitespaceBackward(bytes: Uint8Array, from: number): number {
  let i = from
  while (i >= 0 && isJsonWhitespace(bytes[i])) i--
  return i
}

/** Index just past the quote that closes the string opened at `open`, or the end. */
function stringEnd(bytes: Buffer, open: number): number {
  let from = open + 1
  for (;;) {
    const quote = bytes.indexOf(QUOTE, from)
    if (quote === -1) return bytes.length
    let backslashes = 0
    while (bytes[quote - 1 - backslashes] === BACKSLASH) backslashes++
    if (backslashes % 2 === 0) return quote + 1
    from = quote + 1
  }
}

// Brackets are balanced by count, whatever their kind, and strings are
// skipped, so a raw result that is not valid JSON is still cut exactly.
function containerEnd(bytes: Buffer, open: number): number {
  let depth = 0
  let i = open
  while (i < bytes.length) {
    const byte = bytes[i]
    if (byte === QUOTE) {
      i = stringEnd(bytes, i)
      continue
    }
    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth++
    else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return bytes.length
}

/** A number, `true`, `false` or `null` runs up to the next `,` or `}`. */
function scalarEnd(bytes: Uint8Array, start: number): number {
  for (let i = start; i < bytes.length; i++) {
    if (bytes[i] === COMMA || bytes[i] === CLOSE_BRACE) return i
  }
  return bytes.length
}

function valueEnd(bytes: Buffer, start: number): number {
  const first = bytes[start]
  if (first === undefined) return bytes.length
  if (first === QUOTE) return stringEnd(bytes, start)
  if (first === OPEN_BRACE || first === OPEN_BRACKET) return containerEnd(bytes, start)
  return scalarEnd(bytes, start)
}

function startsWithAt(bytes: Buffer, prefix: Buffer, at: number): boolean {
  const end = at + prefix.length
  return end <= bytes.length && bytes.compare(prefix, 0, prefix.length, at, end) === 0
}

/** Where the outermost object's first member spelled exactly `member` starts, or -1. */
function topLevelMemberStart(line: Buffer, member: Buffer): number {
  let depth = 0
  let outerIsObject = false
  let i = 0
  while (i < line.length) {
    const byte = line[i]
    if (byte === QUOTE) {
      if (depth === 1 && outerIsObject && startsWithAt(line, member, i)) return i
      i = stringEnd(line, i)
      continue
    }
    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      if (depth === 0) outerIsObject = byte === OPEN_BRACE
      depth++
    } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      if (depth <= 1) return -1
      depth--
    }
    i++
  }
  return -1
}

/** The bytes of `line` to cut so that its raw result goes, or `undefined`. */
function rawResultSpan(line: Buffer): Span | undefined {
  if (!line.includes(RAW_RESULT_MEMBER)) return undefined
  const member = topLevelMemberStart(line, RAW_RESULT_MEMBER)
  if (member === -1) return undefined
  const end = valueEnd(line, skipWhitespaceForward(line, member + RAW_RESULT_MEMBER.length))
  const after = skipWhitespaceForward(line, end)
  if (line[after] === COMMA) return [member, after + 1]
  const before = skipWhitespaceBackward(line, member - 1)
  if (line[before] === COMMA) return [before, end]
  return [member, end]
}

function withoutSpans(buf: Buffer, spans: readonly Span[]): Buffer {
  const kept: Buffer[] = []
  let from = 0
  for (const [start, end] of spans) {
    kept.push(buf.subarray(from, start))
    from = end
  }
  kept.push(buf.subarray(from))
  return Buffer.concat(kept)
}

/**
 * Removes the raw `toolUseResult` from every line that also carries a
 * `<persisted-output>` preview. Returns the same buffer when nothing changed,
 * and never modifies the input.
 */
export function stripPersistedToolUseResultsFromJSONLBuffer(buf: Buffer): Buffer {
  if (!buf.includes(RAW_RESULT_MEMBER)) return buf
  const spans: Span[] = []
  let from = 0
  while (from < buf.length) {
    const tag = buf.indexOf(PREVIEW_TAG, from)
    if (tag === -1) break
    const lineStart = buf.lastIndexOf(LF, tag) + 1
    const newline = buf.indexOf(LF, tag)
    const lineEnd = newline === -1 ? buf.length : newline
    const span = rawResultSpan(buf.subarray(lineStart, lineEnd))
    if (span) spans.push([lineStart + span[0], lineStart + span[1]])
    from = lineEnd + 1
  }
  return spans.length === 0 ? buf : withoutSpans(buf, spans)
}

function visitLine<T>(text: string, visit: (entry: T) => void): void {
  let entry: T
  try {
    entry = JSON.parse(text) as T
  } catch {
    // A damaged line is skipped; the rest of the transcript still loads.
    return
  }
  try {
    visit(entry)
  } catch {
    // Kept on purpose: the resume loader's visitor reads `entry.type` without
    // a null check, and a stored `null` line is survived only because of this.
  }
}

/**
 * Parses each non-blank line (trimmed, so CR and byte-order marks go) and
 * hands its value to `visit`, in order. Lines that do not parse are skipped.
 */
export function forEachParsedJSONLBufferEntry<T>(buf: Buffer, visit: (entry: T) => void): void {
  let start = 0
  while (start < buf.length) {
    const newline = buf.indexOf(LF, start)
    const end = newline === -1 ? buf.length : newline
    const text = buf.toString('utf8', start, end).trim()
    if (text !== '') visitLine(text, visit)
    start = end + 1
  }
}
