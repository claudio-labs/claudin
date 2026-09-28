/**
 * git's config file syntax, read the way `git config` reads it, from the text
 * to the value of one key.
 *
 * Two deliberate differences from git. Where git refuses a whole file, this
 * parser drops the line it cannot read and goes on, because a best-effort
 * answer serves the callers better than none. And the first value of a key
 * wins where `git config --get` prints the last, because for
 * remote.origin.url the first is the url git fetches from.
 */

export type ConfigKey = {
  /** Matched without regard to case. */
  section: string
  /** Matched exactly. Null matches only a section written without one. */
  subsection: string | null
  /** Matched without regard to case. */
  key: string
}

type Section = { name: string; subsection: string | null }

type Assignment = {
  /** Null outside any section, or under a header that could not be read. */
  section: Section | null
  key: string
  /** Null for a key written without `=`. */
  value: string | null
}

const BYTE_ORDER_MARK = '\uFEFF'
const CRLF = /\r\n/g
const LETTER = /^[A-Za-z]$/
const KEY_CHARACTER = /^[A-Za-z0-9-]$/
/** The old `[section.subsection]` spelling puts dots in the name. */
const SECTION_CHARACTER = /^[A-Za-z0-9.-]$/
const ESCAPES: ReadonlyMap<string, string> = new Map([
  ['t', '\t'],
  ['n', '\n'],
  ['b', '\b'],
  ['\\', '\\'],
  ['"', '"'],
])

/** git's own notion of a blank, carriage return included. */
function isBlank(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\r'
}

/** Reads one more line end once the text runs out, as git's reader does. */
class Cursor {
  private position = 0

  constructor(private readonly text: string) {}

  get exhausted(): boolean {
    return this.position >= this.text.length
  }

  peek(): string {
    return this.exhausted ? '\n' : this.text.charAt(this.position)
  }

  take(): string {
    const character = this.peek()
    this.position += 1
    return character
  }

  /** Moves up to the end of the line, and leaves the line end to be read. */
  skipLine(): void {
    while (!this.exhausted && this.text.charAt(this.position) !== '\n') this.position += 1
  }
}

/**
 * `[name "subsection"]`, after its opening blank. `\x` stands for `x`. Only
 * `peek` looks at what could be the line end, so a bad header never swallows
 * the line after it.
 */
function readQuotedSubsection(cursor: Cursor, name: string): Section | null {
  while (isBlank(cursor.peek())) cursor.take()
  if (cursor.peek() !== '"') return null
  cursor.take()
  let subsection = ''
  for (;;) {
    if (cursor.peek() === '\n') return null
    let character = cursor.take()
    if (character === '"') break
    if (character === '\\') {
      if (cursor.peek() === '\n') return null
      character = cursor.take()
    }
    subsection += character
  }
  if (cursor.peek() !== ']') return null
  cursor.take()
  return { name, subsection }
}

/** A dotted name is git's old spelling of a subsection, which it reads in lower case. */
function dottedSection(name: string): Section {
  const dot = name.indexOf('.')
  return dot < 0 ? { name, subsection: null } : { name: name.slice(0, dot), subsection: name.slice(dot + 1) }
}

/** Everything after `[`. Null for a header git would refuse. */
function readSectionHeader(cursor: Cursor): Section | null {
  let name = ''
  for (;;) {
    if (cursor.peek() === '\n') return null
    const character = cursor.take()
    if (character === ']') return name === '' ? null : dottedSection(name)
    if (isBlank(character)) return name === '' ? null : readQuotedSubsection(cursor, name)
    if (!SECTION_CHARACTER.test(character)) return null
    name += character.toLowerCase()
  }
}

/**
 * A value after `=`. Quotes keep blanks and comment characters, blanks inside
 * the value are kept as written, and a backslash escapes the next character
 * in quotes or not. A backslash at the end of a line continues the value on
 * the next one. A quote left open ends with its line.
 */
function readValue(cursor: Cursor): string {
  let value = ''
  let pendingBlanks = ''
  let quoted = false
  for (;;) {
    if (cursor.peek() === '\n') return value
    const character = cursor.take()
    if (!quoted && isBlank(character)) {
      if (value !== '') pendingBlanks += character
      continue
    }
    if (!quoted && (character === '#' || character === ';')) {
      cursor.skipLine()
      return value
    }
    value += pendingBlanks
    pendingBlanks = ''
    if (character === '\\') {
      const escaped = cursor.take()
      if (escaped !== '\n') value += ESCAPES.get(escaped) ?? escaped
      continue
    }
    if (character === '"') {
      quoted = !quoted
      continue
    }
    value += character
  }
}

/** A key and what follows it on its line. Null when git would refuse the line. */
function readAssignment(cursor: Cursor, first: string): { key: string; value: string | null } | null {
  let key = first.toLowerCase()
  while (KEY_CHARACTER.test(cursor.peek())) key += cursor.take().toLowerCase()
  while (cursor.peek() === ' ' || cursor.peek() === '\t') cursor.take()
  if (cursor.peek() === '\n') return { key, value: null }
  if (cursor.take() !== '=') return null
  return { key, value: readValue(cursor) }
}

function* assignments(text: string): Generator<Assignment> {
  const body = text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text
  const cursor = new Cursor(body.replace(CRLF, '\n'))
  let section: Section | null = null
  while (!cursor.exhausted) {
    const character = cursor.take()
    if (character === '\n' || isBlank(character)) continue
    if (character === '#' || character === ';') {
      cursor.skipLine()
      continue
    }
    if (character === '[') {
      section = readSectionHeader(cursor)
      if (section === null) cursor.skipLine()
      continue
    }
    const assignment = LETTER.test(character) ? readAssignment(cursor, character) : null
    if (assignment === null) {
      cursor.skipLine()
      continue
    }
    yield { section, ...assignment }
  }
}

/** The first value assigned to `wanted`, in file order. */
export function findConfigValue(text: string, wanted: ConfigKey): string | null {
  const sectionName = wanted.section.toLowerCase()
  const keyName = wanted.key.toLowerCase()
  for (const { section, key, value } of assignments(text)) {
    if (value === null || key !== keyName || section === null) continue
    if (section.name === sectionName && section.subsection === wanted.subsection) return value
  }
  return null
}
