// Reads one string member out of raw JSONL text without parsing it, for
// listings that only look at the head and tail of large files. The text is
// usually cut at both ends, so an occurrence that does not close is ignored.

const QUOTE = '"'
const BACKSLASH = '\\'
const HEX4 = /^[0-9a-fA-F]{4}$/
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

type Occurrence = { at: number; valueStart: number }

/** The member opened compactly, and with one space after the colon. */
function openersOf(key: string): readonly [string, string] {
  return [`"${key}":"`, `"${key}": "`]
}

function occurrence(at: number, opener: string): Occurrence | undefined {
  return at === -1 ? undefined : { at, valueStart: at + opener.length }
}

function earlier(a: Occurrence | undefined, b: Occurrence | undefined): Occurrence | undefined {
  if (!a || !b) return a ?? b
  return a.at <= b.at ? a : b
}

function later(a: Occurrence | undefined, b: Occurrence | undefined): Occurrence | undefined {
  if (!a || !b) return a ?? b
  return a.at >= b.at ? a : b
}

/** The raw body of the string starting at `valueStart`, if it closes before the text ends. */
function closedBody(text: string, valueStart: number): string | undefined {
  for (let i = valueStart; i < text.length; i++) {
    const char = text[i]
    if (char === BACKSLASH) i++
    else if (char === QUOTE) return text.slice(valueStart, i)
  }
  return undefined
}

// JSON string rules: raw control characters are not allowed, and only the
// listed escapes are. `undefined` means the body is not valid JSON.
function decodeValidBody(body: string): string | undefined {
  let decoded = ''
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char < ' ') return undefined
    if (char !== BACKSLASH) {
      decoded += char
      continue
    }
    const escape = body[++i]
    if (escape === 'u') {
      const hex = body.slice(i + 1, i + 5)
      if (!HEX4.test(hex)) return undefined
      decoded += String.fromCharCode(Number.parseInt(hex, 16))
      i += 4
      continue
    }
    const replacement = escape === undefined ? undefined : SIMPLE_ESCAPES[escape]
    if (replacement === undefined) return undefined
    decoded += replacement
  }
  return decoded
}

/** Decoded by JSON string rules, or returned as it is when that fails. */
function decodeBody(body: string): string {
  if (!body.includes(BACKSLASH)) return body
  return decodeValidBody(body) ?? body
}

/** The first complete occurrence of the string member `key`, by position. */
export function extractJsonStringField(text: string, key: string): string | undefined {
  const [compact, spaced] = openersOf(key)
  let from = 0
  for (;;) {
    const next = earlier(
      occurrence(text.indexOf(compact, from), compact),
      occurrence(text.indexOf(spaced, from), spaced),
    )
    if (!next) return undefined
    const body = closedBody(text, next.valueStart)
    if (body !== undefined) return decodeBody(body)
    from = next.at + 1
  }
}

/** The last complete occurrence of the string member `key`, by position. */
export function extractLastJsonStringField(text: string, key: string): string | undefined {
  const [compact, spaced] = openersOf(key)
  let from = text.length
  while (from >= 0) {
    const previous = later(
      occurrence(text.lastIndexOf(compact, from), compact),
      occurrence(text.lastIndexOf(spaced, from), spaced),
    )
    if (!previous) return undefined
    const body = closedBody(text, previous.valueStart)
    if (body !== undefined) return decodeBody(body)
    from = previous.at - 1
  }
  return undefined
}
