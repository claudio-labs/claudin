/**
 * Provenance fingerprints: what the clean-base rewrite gate compares a file
 * against. See docs/tech/rewrite/README.md for the process this serves.
 *
 * Two measures, because each is blind where the other sees:
 *
 *  - LINES: a distinctive line (trimmed, whitespace collapsed, at least
 *    LINE_MIN_LENGTH characters, containing a letter) hashed verbatim. It is the
 *    only measure that sees copied comments and prose, which the token stream
 *    drops.
 *  - TOKENS: the code as a token stream in which every identifier, string,
 *    template, number and regex collapses to its kind, cut into K-token grams and
 *    winnowed (Schleimer, Wilkerson & Aiken 2003, the algorithm behind MOSS).
 *    Renaming variables, retyping or reformatting leaves this measure unchanged,
 *    which is the point: a refactored copy is still a copy.
 *
 * Import and re-export statements are dropped from the token stream. They are
 * wiring, identical in shape across any two TypeScript codebases, and without
 * the drop every import block would match every other one.
 *
 * Only 32-bit hashes are ever stored, never text: the reference sets describe
 * code this repository has no right to reproduce. A set of a few hundred
 * thousand 32-bit hashes answers "yes" by chance about once per ten thousand
 * lookups, so a hit only counts inside a run of at least MIN_RUN hits, which
 * pushes chance matches to around one in a hundred million.
 */

/** A shorter line is too generic to say anything about where it came from. */
export const LINE_MIN_LENGTH = 25

/** Tokens per gram. 30 found no more renamed copies and 40% more chance matches. */
export const K = 40

/** Winnowing window: every shared run of K + W - 1 tokens keeps a fingerprint. */
export const W = 16

/** Consecutive hits (lines or grams) before any of them counts. */
export const MIN_RUN = 2

/**
 * Different token kinds a gram needs before it says anything (see gramHashes).
 * Calibrated 2026-09-27 against opencode (678k lines of unrelated TypeScript):
 * 10 took chance coverage from 16.8% to 0.08% and kept 80% on inherited files;
 * 13 bought 0.03% for four points of detection.
 */
export const MIN_DISTINCT = 10

/**
 * Everything that decides a hash. A reference built under other values is
 * unusable, so bump `version` with any change to how the tokenizer cuts a
 * stream, and rebuild fingerprints.bin in the same commit.
 */
export const PARAMS = { LINE_MIN_LENGTH, K, W, MIN_RUN, MIN_DISTINCT, version: 3 } as const

// ---------------------------------------------------------------------------
// Hashing

/** FNV-1a over UTF-16 code units, finished with the murmur3 mixer. */
export function hash32(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return mix32(h)
}

function mix32(value: number): number {
  let h = value
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

// ---------------------------------------------------------------------------
// Lines

/**
 * A line of module wiring: `import …`, `export … from …`, or the `} from '…'`
 * that closes a multi-line import. Dropped from the line measure for the same
 * reason the token measure drops it: two unrelated files that both import
 * `randomBytes` from 'crypto' and `join` from 'path' share nothing worth
 * counting.
 */
const WIRING_LINE = /^(import\b|export\s+(\*|type\s*\{|\{)[^;]*\bfrom\b|\}\s*from\s*['"])/

/**
 * The first line of an import or re-export whose braces close on a later
 * line. Its member lines (`  activateConditionalSkillsForPaths,`) are long
 * enough to count, and two files importing the same names one per line would
 * otherwise match as a run.
 */
const WIRING_BLOCK_START = /^(import\b[^'"]*|export\s+(type\s+)?)\{[^}]*$/

export function normalizeLine(line: string): string | null {
  const text = line.trim().replace(/\s+/g, ' ')
  if (text.length < LINE_MIN_LENGTH || !/[A-Za-z]/.test(text)) return null
  if (WIRING_LINE.test(text)) return null
  return text
}

export type LineHash = { line: number; hash: number }

/** One entry per distinctive line, with its zero-based line number. */
export function lineHashes(source: string): LineHash[] {
  const out: LineHash[] = []
  const lines = source.split('\n')
  let inWiringBlock = false
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim()
    if (inWiringBlock) {
      if (trimmed.includes('}')) inWiringBlock = false
      continue
    }
    if (WIRING_BLOCK_START.test(trimmed)) {
      inWiringBlock = true
      continue
    }
    const text = normalizeLine(lines[i]!)
    if (text !== null) out.push({ line: i, hash: hash32(text) })
  }
  return out
}

// ---------------------------------------------------------------------------
// Tokens

const KEYWORDS = new Set([
  'abstract', 'any', 'as', 'async', 'await', 'bigint', 'boolean', 'break',
  'case', 'catch', 'class', 'const', 'constructor', 'continue', 'debugger',
  'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
  'false', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements',
  'import', 'in', 'infer', 'instanceof', 'interface', 'is', 'keyof', 'let',
  'module', 'namespace', 'never', 'new', 'null', 'number', 'object', 'of',
  'private', 'protected', 'public', 'readonly', 'return', 'satisfies', 'set',
  'static', 'string', 'super', 'switch', 'symbol', 'this', 'throw', 'true',
  'try', 'type', 'typeof', 'undefined', 'unknown', 'var', 'void', 'while',
  'with', 'yield',
])

/**
 * After one of these, a `/` starts a regex literal rather than a division.
 * `)` and `]` are left out on purpose: `(a) / b` is far more common than a
 * regex after a parenthesis.
 */
const REGEX_PRECEDERS = new Set([
  '', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-',
  '*', '%', '<', '>', '~', '^', 'return', 'typeof', 'case', 'do', 'else',
  'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await',
])

export type TokenStream = { kinds: string[]; lines: number[] }

const isIdentStart = (c: string) => /[A-Za-z_$\u00c0-\uffff]/.test(c)
const isIdentPart = (c: string) => /[A-Za-z0-9_$\u00c0-\uffff]/.test(c)
const isDigit = (c: string) => c >= '0' && c <= '9'

/**
 * A deliberately small scanner. It does not need to parse TypeScript, only to
 * cut any two copies of the same code into the same stream; where it guesses
 * wrong (a regex it reads as division), it guesses wrong the same way on both
 * sides.
 */
export function tokenize(source: string): TokenStream {
  const kinds: string[] = []
  const lines: number[] = []
  let i = 0
  let line = 0
  const n = source.length

  const push = (kind: string, at: number) => {
    kinds.push(kind)
    lines.push(at)
  }

  const skipQuoted = (quote: string) => {
    i++
    while (i < n) {
      const c = source[i]!
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === quote) {
        i++
        return
      }
      if (c === '\n') return
      i++
    }
  }

  const skipTemplate = () => {
    i++
    while (i < n) {
      const c = source[i]!
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '`') {
        i++
        return
      }
      if (c === '\n') line++
      if (c === '$' && source[i + 1] === '{') {
        i += 2
        skipBraced()
        continue
      }
      i++
    }
  }

  // The expression inside `${…}`: balanced braces, with strings, templates and
  // comments inside it skipped so a `}` in them cannot end it early.
  const skipBraced = () => {
    let depth = 1
    while (i < n && depth > 0) {
      const c = source[i]!
      if (c === '\n') {
        line++
        i++
      } else if (c === '\'' || c === '"') skipQuoted(c)
      else if (c === '`') skipTemplate()
      else if (c === '/' && source[i + 1] === '/') {
        while (i < n && source[i] !== '\n') i++
      } else if (c === '/' && source[i + 1] === '*') skipBlockComment()
      else {
        if (c === '{') depth++
        else if (c === '}') depth--
        i++
      }
    }
  }

  const skipBlockComment = () => {
    i += 2
    while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
      if (source[i] === '\n') line++
      i++
    }
    i += 2
  }

  const skipRegex = () => {
    i++
    let inClass = false
    while (i < n) {
      const c = source[i]!
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '\n') return
      if (inClass) {
        if (c === ']') inClass = false
      } else if (c === '[') inClass = true
      else if (c === '/') {
        i++
        while (i < n && isIdentPart(source[i]!)) i++
        return
      }
      i++
    }
  }

  const previous = () => (kinds.length === 0 ? '' : kinds[kinds.length - 1]!)

  while (i < n) {
    const c = source[i]!
    if (c === '\n') {
      line++
      i++
    } else if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '\ufeff') {
      i++
    } else if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++
    } else if (c === '/' && source[i + 1] === '*') {
      skipBlockComment()
    } else if (c === '\'' || c === '"') {
      push('S', line)
      skipQuoted(c)
    } else if (c === '`') {
      push('S', line)
      skipTemplate()
    } else if (c === '/' && REGEX_PRECEDERS.has(previous())) {
      push('R', line)
      skipRegex()
    } else if (isDigit(c) || (c === '.' && isDigit(source[i + 1] ?? ''))) {
      push('N', line)
      i++
      while (i < n && (isIdentPart(source[i]!) || source[i] === '.')) i++
    } else if (isIdentStart(c) || (c === '#' && isIdentStart(source[i + 1] ?? ''))) {
      const start = i
      i++
      while (i < n && isIdentPart(source[i]!)) i++
      const word = source.slice(start, i)
      push(KEYWORDS.has(word) ? word : 'I', line)
    } else {
      push(c, line)
      i++
    }
  }

  return dropModuleWiring({ kinds, lines })
}

/** What can follow `import` when it starts a declaration or a dynamic import. */
const IMPORT_FOLLOWERS = new Set(['I', '{', '*', 'S', '(', 'type'])

/** The longest import this repo has is ~60 tokens; anything past this is a misread. */
const MAX_IMPORT_TOKENS = 400

/**
 * Remove `import … 'specifier'`, `import('specifier')`, `export … from
 * 'specifier'` and `export { a, b }`. `import.meta` and a property named
 * `import` stay: they are expressions, not wiring.
 */
export function dropModuleWiring(stream: TokenStream): TokenStream {
  const { kinds, lines } = stream
  const keep: boolean[] = new Array(kinds.length).fill(true)
  const n = kinds.length

  // Semicolon-free code ends a statement with a newline, so the first token of
  // a line counts as a statement start too.
  const statementStart = (at: number) => {
    if (at === 0 || lines[at - 1] !== lines[at]) return true
    const before = kinds[at - 1]!
    return before === ';' || before === '}' || before === '{'
  }

  for (let i = 0; i < n; i++) {
    const kind = kinds[i]
    if (kind === 'import' && kinds[i - 1] !== '.' && IMPORT_FOLLOWERS.has(kinds[i + 1] ?? '')) {
      // Bounded, so a misread `import` cannot swallow the file up to the next
      // string it happens to meet.
      let j = i + 1
      while (j < n && j - i < MAX_IMPORT_TOKENS && kinds[j] !== 'S') j++
      if (kinds[j] !== 'S') continue
      if (kinds[j + 1] === ')') j++
      if (kinds[j + 1] === ';') j++
      for (let x = i; x <= Math.min(j, n - 1); x++) keep[x] = false
      i = j
    } else if (kind === 'export' && statementStart(i)) {
      let j = i + 1
      if (kinds[j] === 'type') j++
      if (kinds[j] !== '{' && kinds[j] !== '*') continue
      if (kinds[j] === '{') {
        while (j < n && kinds[j] !== '}') j++
      } else if (kinds[j + 1] === 'as') {
        j += 2
      }
      if (kinds[j + 1] === 'from') j += 2
      if (kinds[j + 1] === ';') j++
      for (let x = i; x <= Math.min(j, n - 1); x++) keep[x] = false
      i = j
    }
  }

  const out: TokenStream = { kinds: [], lines: [] }
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue
    out.kinds.push(kinds[i]!)
    out.lines.push(lines[i]!)
  }
  return out
}

// ---------------------------------------------------------------------------
// Grams

const kindIds = new Map<string, number>()
function kindId(kind: string): number {
  let id = kindIds.get(kind)
  if (id === undefined) {
    id = hash32(kind) | 1
    kindIds.set(kind, id)
  }
  return id
}

/** Marks a gram too repetitive to fingerprint. Never a real hash (see gramHashes). */
export const UNINFORMATIVE = 0

/**
 * The hash of every K-token window, in order. A polynomial rolling hash in
 * 32-bit arithmetic, mixed at the end so winnowing's "smallest in the window"
 * picks evenly.
 *
 * A window with fewer than MIN_DISTINCT different kinds gets UNINFORMATIVE
 * instead. Normalization turns every table (`key: 'value',` a thousand times,
 * a switch of `case 'x': return 'y'`) into the same stream, so on an unrelated
 * codebase those windows were most of the chance matches.
 */
export function gramHashes(kinds: readonly string[]): number[] {
  const n = kinds.length - K + 1
  if (n <= 0) return []
  const BASE = 0x9e3779b1
  let top = 1
  for (let i = 0; i < K - 1; i++) top = Math.imul(top, BASE)

  const counts = new Map<string, number>()
  let distinct = 0
  const enter = (kind: string) => {
    const c = counts.get(kind) ?? 0
    if (c === 0) distinct++
    counts.set(kind, c + 1)
  }
  const leave = (kind: string) => {
    const c = counts.get(kind)!
    if (c === 1) distinct--
    counts.set(kind, c - 1)
  }
  const finish = (h: number) => {
    if (distinct < MIN_DISTINCT) return UNINFORMATIVE
    return mix32(h) || 1
  }

  let h = 0
  for (let i = 0; i < K; i++) {
    h = (Math.imul(h, BASE) + kindId(kinds[i]!)) | 0
    enter(kinds[i]!)
  }
  const out = new Array<number>(n)
  out[0] = finish(h)
  for (let i = 1; i < n; i++) {
    h = (h - Math.imul(kindId(kinds[i - 1]!), top)) | 0
    h = (Math.imul(h, BASE) + kindId(kinds[i + K - 1]!)) | 0
    leave(kinds[i - 1]!)
    enter(kinds[i + K - 1]!)
    out[i] = finish(h)
  }
  return out
}

/**
 * Winnowing: in every window of W consecutive gram hashes keep the smallest
 * (the rightmost one on a tie), skipping UNINFORMATIVE ones. Any informative
 * run of K + W - 1 tokens two streams share therefore leaves at least one
 * fingerprint in both.
 */
export function winnow(hashes: readonly number[]): number[] {
  const picked: number[] = []
  const windows = Math.max(1, hashes.length - W + 1)
  const width = Math.min(W, hashes.length)
  let lastPick = -1
  for (let start = 0; start < windows; start++) {
    let min = -1
    for (let j = start; j < start + width; j++) {
      const value = hashes[j]!
      if (value === UNINFORMATIVE) continue
      if (min === -1 || value <= hashes[min]!) min = j
    }
    if (min !== -1 && min !== lastPick) {
      picked.push(hashes[min]!)
      lastPick = min
    }
  }
  return picked
}

// ---------------------------------------------------------------------------
// Reference sets

export type ReferenceSets = {
  lines: Set<number>
  grams: Set<number>
}

/** Every fingerprint one source file contributes to a reference set. */
export function fileFingerprints(source: string, withTokens: boolean): { lines: number[]; grams: number[] } {
  const lines = lineHashes(source).map(l => l.hash)
  const grams = withTokens ? winnow(gramHashes(tokenize(source).kinds)) : []
  return { lines, grams }
}

// ---------------------------------------------------------------------------
// Matching

/**
 * Which zero-based lines of `source` match `ref`, by either measure, counting a
 * hit only inside a run of at least MIN_RUN.
 *
 * Grams are looked up at every position, not only the winnowed ones: the
 * reference keeps a sample, and querying all of them is what finds each sampled
 * gram wherever the copied run starts.
 */
export function matchedLines(source: string, ref: ReferenceSets, withTokens: boolean): Set<number> {
  const covered = new Set<number>()

  const hashes = lineHashes(source)
  let run: number[] = []
  const flushLines = () => {
    if (run.length >= MIN_RUN) for (const l of run) covered.add(l)
    run = []
  }
  for (const { line, hash } of hashes) {
    if (ref.lines.has(hash)) run.push(line)
    else flushLines()
  }
  flushLines()

  if (!withTokens) return covered

  const stream = tokenize(source)
  const grams = gramHashes(stream.kinds)
  // A run of grams: hits whose windows overlap (start positions less than K
  // apart). Chance hits land far apart; a copied block keeps overlapping.
  let first = -1
  let last = -1
  let hits = 0
  const flushGrams = () => {
    if (hits >= MIN_RUN) {
      for (let t = first; t <= last + K - 1; t++) covered.add(stream.lines[t]!)
    }
    first = -1
    last = -1
    hits = 0
  }
  for (let g = 0; g < grams.length; g++) {
    const gram = grams[g]!
    if (gram === UNINFORMATIVE || !ref.grams.has(gram)) continue
    if (hits > 0 && g - last >= K) flushGrams()
    if (hits === 0) first = g
    last = g
    hits++
  }
  flushGrams()
  return covered
}

/** The extensions the token measure understands. Everything else gets lines only. */
export const CODE_EXTENSION = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

/** Text worth checking for copied prose and data by the line measure alone. */
export const TEXT_EXTENSION = /\.(md|txt)$/
