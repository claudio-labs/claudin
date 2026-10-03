/**
 * Turns a 64 KiB window of a JSONL transcript into the entries it shows.
 *
 * A window is cut wherever the byte count falls, so its lines come in three
 * kinds: whole lines, parsed as JSON; a line cut at its end (the last line of
 * a head window), of which only the top-level members written before the cut
 * are known; and a line cut at its start (the first line of a tail window),
 * which is dropped, because nothing tells which nesting level it starts at.
 */

/** The top-level members of one transcript line. */
export type WindowEntry = Readonly<Record<string, unknown>>

const NEWLINE = '\n'
const QUOTE = '"'
const BACKSLASH = '\\'
const OPENERS = new Set(['{', '['])
const CLOSERS = new Set(['}', ']'])
const WHITESPACE = new Set([' ', '\t', '\r', '\n'])
const LITERAL_ENDS = new Set([',', '}', ']', ' ', '\t', '\r', '\n'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A whole line as an object, or undefined when it is not one. */
function parseWholeLine(line: string): WindowEntry | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return isPlainObject(value) ? value : undefined
  } catch {
    // A cut or corrupt line is expected in a window; the caller falls back.
    return undefined
  }
}

function skipWhitespace(text: string, from: number): number {
  let i = from
  while (i < text.length && WHITESPACE.has(text[i]!)) i++
  return i
}

/** The index just past the string opening at `from`, or -1 when it is cut. */
function endOfString(text: string, from: number): number {
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] === BACKSLASH) i++
    else if (text[i] === QUOTE) return i + 1
  }
  return -1
}

/** The index just past the object or array opening at `from`, or -1 when it is cut. */
function endOfContainer(text: string, from: number): number {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const char = text[i]!
    if (char === QUOTE) {
      const next = endOfString(text, i)
      if (next === -1) return -1
      i = next - 1
    } else if (OPENERS.has(char)) {
      depth++
    } else if (CLOSERS.has(char)) {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/** The index just past a number, boolean or null, or -1 when the text ends inside it. */
function endOfLiteral(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (LITERAL_ENDS.has(text[i]!)) return i
  }
  return -1
}

function endOfValue(text: string, from: number): number {
  const char = text[from]
  if (char === undefined) return -1
  if (char === QUOTE) return endOfString(text, from)
  if (OPENERS.has(char)) return endOfContainer(text, from)
  return endOfLiteral(text, from)
}

function decodeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    // Not a JSON value: the member is left out.
    return undefined
  }
}

/**
 * The scalar top-level members a line holds before it ends, read one member
 * at a time. Object and array values are skipped: a cut line rarely holds
 * them whole, and no listed field needs them.
 */
export function leadingMembers(line: string): WindowEntry | undefined {
  let i = skipWhitespace(line, 0)
  if (line[i] !== '{') return undefined
  const members: Record<string, unknown> = {}
  i++
  for (;;) {
    i = skipWhitespace(line, i)
    if (line[i] !== QUOTE) return members
    const keyEnd = endOfString(line, i)
    if (keyEnd === -1) return members
    const key = decodeJson(line.slice(i, keyEnd))
    i = skipWhitespace(line, keyEnd)
    if (typeof key !== 'string' || line[i] !== ':') return members
    const valueStart = skipWhitespace(line, i + 1)
    const valueEnd = endOfValue(line, valueStart)
    if (valueEnd === -1) return members
    if (!OPENERS.has(line[valueStart]!)) {
      const value = decodeJson(line.slice(valueStart, valueEnd))
      if (value !== undefined) members[key] = value
    }
    i = skipWhitespace(line, valueEnd)
    if (line[i] !== ',') return members
    i++
  }
}

/**
 * The entries of a window, in order. `startsMidLine` says the window does
 * not begin at the start of the file, so its first line may be a fragment.
 */
export function windowEntries(window: string, startsMidLine: boolean): WindowEntry[] {
  const entries: WindowEntry[] = []
  window.split(NEWLINE).forEach((line, index) => {
    if (line.trim() === '') return
    const whole = parseWholeLine(line)
    if (whole) {
      entries.push(whole)
      return
    }
    if (index === 0 && startsMidLine) return
    const partial = leadingMembers(line)
    if (partial && Object.keys(partial).length > 0) entries.push(partial)
  })
  return entries
}
