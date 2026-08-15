/**
 * Bash lexer — produces context-sensitive tokens from a source string.
 *
 * Tracks both JS-string index (for charAt) and UTF-8 byte offset (for TsNode
 * positions). ASCII fast path: byte == char index. Non-ASCII advances byte
 * count per-codepoint.
 *
 * Heredoc body scanning is performed by the parser (which knows when a `<<`
 * token appears) — this module only exposes the pending list.
 */

import type { Token } from 'src/services/bash/bashParser/tokens.js'

type HeredocPending = {
  delim: string
  stripTabs: boolean
  quoted: boolean
  /** Filled after body scan */
  bodyStart: number
  bodyEnd: number
  endStart: number
  endEnd: number
}

export type Lexer = {
  src: string
  len: number
  /** JS string index */
  i: number
  /** UTF-8 byte offset */
  b: number
  /** Pending heredoc delimiters awaiting body scan at next newline */
  heredocs: HeredocPending[]
  /** Precomputed byte offset for each char index (lazy for non-ASCII) */
  byteTable: Uint32Array | null
}

export type { HeredocPending }

export function makeLexer(src: string): Lexer {
  return {
    src,
    len: src.length,
    i: 0,
    b: 0,
    heredocs: [],
    byteTable: null,
  }
}

/** Advance one JS char, updating byte offset for UTF-8. */
export function advance(L: Lexer): void {
  const c = L.src.charCodeAt(L.i)
  L.i++
  if (c < 0x80) {
    L.b++
  } else if (c < 0x800) {
    L.b += 2
  } else if (c >= 0xd800 && c <= 0xdbff) {
    // High surrogate — next char completes the pair, total 4 UTF-8 bytes
    L.b += 4
    L.i++
  } else {
    L.b += 3
  }
}

export function peek(L: Lexer, off = 0): string {
  return L.i + off < L.len ? L.src[L.i + off]! : ''
}

export function byteAt(L: Lexer, charIdx: number): number {
  // Fast path: ASCII-only prefix means char idx == byte idx
  if (L.byteTable) return L.byteTable[charIdx]!
  // Build table on first non-trivial lookup
  const t = new Uint32Array(L.len + 1)
  let b = 0
  let i = 0
  while (i < L.len) {
    t[i] = b
    const c = L.src.charCodeAt(i)
    if (c < 0x80) {
      b++
      i++
    } else if (c < 0x800) {
      b += 2
      i++
    } else if (c >= 0xd800 && c <= 0xdbff) {
      t[i + 1] = b + 2
      b += 4
      i += 2
    } else {
      b += 3
      i++
    }
  }
  t[L.len] = b
  L.byteTable = t
  return t[charIdx]!
}

export function isWordChar(c: string): boolean {
  // Bash word chars: alphanumeric + various punctuation that doesn't start operators
  return (
    (c >= 'a' && c <= 'z') ||
    (c >= 'A' && c <= 'Z') ||
    (c >= '0' && c <= '9') ||
    c === '_' ||
    c === '/' ||
    c === '.' ||
    c === '-' ||
    c === '+' ||
    c === ':' ||
    c === '@' ||
    c === '%' ||
    c === ',' ||
    c === '~' ||
    c === '^' ||
    c === '?' ||
    c === '*' ||
    c === '!' ||
    c === '=' ||
    c === '[' ||
    c === ']'
  )
}

export function isWordStart(c: string): boolean {
  return isWordChar(c) || c === '\\'
}

export function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'
}

export function isIdentChar(c: string): boolean {
  return isIdentStart(c) || (c >= '0' && c <= '9')
}

export function isDigit(c: string): boolean {
  return c >= '0' && c <= '9'
}

export function isHexDigit(c: string): boolean {
  return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

export function isBaseDigit(c: string): boolean {
  // Bash BASE#DIGITS: digits, letters, @ and _ (up to base 64)
  return isIdentChar(c) || c === '@'
}

/**
 * Unquoted heredoc delimiter chars. Bash accepts most non-metacharacters —
 * not just identifiers. Stop at whitespace, redirects, pipe/list operators,
 * and structural tokens. Allows !, -, ., +, etc. (e.g. <<!HEREDOC!).
 */
export function isHeredocDelimChar(c: string): boolean {
  return (
    c !== '' &&
    c !== ' ' &&
    c !== '\t' &&
    c !== '\n' &&
    c !== '<' &&
    c !== '>' &&
    c !== '|' &&
    c !== '&' &&
    c !== ';' &&
    c !== '(' &&
    c !== ')' &&
    c !== "'" &&
    c !== '"' &&
    c !== '`' &&
    c !== '\\'
  )
}

export function skipBlanks(L: Lexer): void {
  while (L.i < L.len) {
    const c = L.src[L.i]!
    if (c === ' ' || c === '\t' || c === '\r') {
      // \r is whitespace per tree-sitter-bash extras /\s/ — handles CRLF inputs
      advance(L)
    } else if (c === '\\') {
      const nx = L.src[L.i + 1]
      if (nx === '\n' || (nx === '\r' && L.src[L.i + 2] === '\n')) {
        // Line continuation — tree-sitter extras: /\\\r?\n/
        advance(L)
        advance(L)
        if (nx === '\r') advance(L)
      } else if (nx === ' ' || nx === '\t') {
        // \<space> or \<tab> — tree-sitter's _whitespace is /\\?[ \t\v]+/
        advance(L)
        advance(L)
      } else {
        break
      }
    } else {
      break
    }
  }
}

/**
 * Scan next token. Context-sensitive: `cmd` mode treats [ as operator (test
 * command start), `arg` mode treats [ as word char (glob/subscript).
 */
export function nextToken(L: Lexer, ctx: 'cmd' | 'arg' = 'arg'): Token {
  skipBlanks(L)
  const start = L.b
  if (L.i >= L.len) return { type: 'EOF', value: '', start, end: start }

  const c = L.src[L.i]!
  const c1 = peek(L, 1)
  const c2 = peek(L, 2)

  if (c === '\n') {
    advance(L)
    return { type: 'NEWLINE', value: '\n', start, end: L.b }
  }

  if (c === '#') {
    const si = L.i
    while (L.i < L.len && L.src[L.i] !== '\n') advance(L)
    return {
      type: 'COMMENT',
      value: L.src.slice(si, L.i),
      start,
      end: L.b,
    }
  }

  // Multi-char operators (longest match first)
  if (c === '&' && c1 === '&') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '&&', start, end: L.b }
  }
  if (c === '|' && c1 === '|') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '||', start, end: L.b }
  }
  if (c === '|' && c1 === '&') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '|&', start, end: L.b }
  }
  if (c === ';' && c1 === ';' && c2 === '&') {
    advance(L)
    advance(L)
    advance(L)
    return { type: 'OP', value: ';;&', start, end: L.b }
  }
  if (c === ';' && c1 === ';') {
    advance(L)
    advance(L)
    return { type: 'OP', value: ';;', start, end: L.b }
  }
  if (c === ';' && c1 === '&') {
    advance(L)
    advance(L)
    return { type: 'OP', value: ';&', start, end: L.b }
  }
  if (c === '>' && c1 === '>') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '>>', start, end: L.b }
  }
  if (c === '>' && c1 === '&' && c2 === '-') {
    advance(L)
    advance(L)
    advance(L)
    return { type: 'OP', value: '>&-', start, end: L.b }
  }
  if (c === '>' && c1 === '&') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '>&', start, end: L.b }
  }
  if (c === '>' && c1 === '|') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '>|', start, end: L.b }
  }
  if (c === '&' && c1 === '>' && c2 === '>') {
    advance(L)
    advance(L)
    advance(L)
    return { type: 'OP', value: '&>>', start, end: L.b }
  }
  if (c === '&' && c1 === '>') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '&>', start, end: L.b }
  }
  if (c === '<' && c1 === '<' && c2 === '<') {
    advance(L)
    advance(L)
    advance(L)
    return { type: 'OP', value: '<<<', start, end: L.b }
  }
  if (c === '<' && c1 === '<' && c2 === '-') {
    advance(L)
    advance(L)
    advance(L)
    return { type: 'OP', value: '<<-', start, end: L.b }
  }
  if (c === '<' && c1 === '<') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '<<', start, end: L.b }
  }
  if (c === '<' && c1 === '&' && c2 === '-') {
    advance(L)
    advance(L)
    advance(L)
    return { type: 'OP', value: '<&-', start, end: L.b }
  }
  if (c === '<' && c1 === '&') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '<&', start, end: L.b }
  }
  if (c === '<' && c1 === '(') {
    advance(L)
    advance(L)
    return { type: 'LT_PAREN', value: '<(', start, end: L.b }
  }
  if (c === '>' && c1 === '(') {
    advance(L)
    advance(L)
    return { type: 'GT_PAREN', value: '>(', start, end: L.b }
  }
  if (c === '(' && c1 === '(') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '((', start, end: L.b }
  }
  if (c === ')' && c1 === ')') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '))', start, end: L.b }
  }

  if (c === '|' || c === '&' || c === ';' || c === '>' || c === '<') {
    advance(L)
    return { type: 'OP', value: c, start, end: L.b }
  }
  if (c === '(' || c === ')') {
    advance(L)
    return { type: 'OP', value: c, start, end: L.b }
  }

  // In cmd position, [ [[ { start test/group; in arg position they're word chars
  if (ctx === 'cmd') {
    if (c === '[' && c1 === '[') {
      advance(L)
      advance(L)
      return { type: 'OP', value: '[[', start, end: L.b }
    }
    if (c === '[') {
      advance(L)
      return { type: 'OP', value: '[', start, end: L.b }
    }
    if (c === '{' && (c1 === ' ' || c1 === '\t' || c1 === '\n')) {
      advance(L)
      return { type: 'OP', value: '{', start, end: L.b }
    }
    if (c === '}') {
      advance(L)
      return { type: 'OP', value: '}', start, end: L.b }
    }
    if (c === '!' && (c1 === ' ' || c1 === '\t')) {
      advance(L)
      return { type: 'OP', value: '!', start, end: L.b }
    }
  }

  if (c === '"') {
    advance(L)
    return { type: 'DQUOTE', value: '"', start, end: L.b }
  }
  if (c === "'") {
    const si = L.i
    advance(L)
    while (L.i < L.len && L.src[L.i] !== "'") advance(L)
    if (L.i < L.len) advance(L)
    return {
      type: 'SQUOTE',
      value: L.src.slice(si, L.i),
      start,
      end: L.b,
    }
  }

  if (c === '$') {
    if (c1 === '(' && c2 === '(') {
      advance(L)
      advance(L)
      advance(L)
      return { type: 'DOLLAR_DPAREN', value: '$((', start, end: L.b }
    }
    if (c1 === '(') {
      advance(L)
      advance(L)
      return { type: 'DOLLAR_PAREN', value: '$(', start, end: L.b }
    }
    if (c1 === '{') {
      advance(L)
      advance(L)
      return { type: 'DOLLAR_BRACE', value: '${', start, end: L.b }
    }
    if (c1 === "'") {
      // ANSI-C string $'...'
      const si = L.i
      advance(L)
      advance(L)
      while (L.i < L.len && L.src[L.i] !== "'") {
        if (L.src[L.i] === '\\' && L.i + 1 < L.len) advance(L)
        advance(L)
      }
      if (L.i < L.len) advance(L)
      return {
        type: 'ANSI_C',
        value: L.src.slice(si, L.i),
        start,
        end: L.b,
      }
    }
    advance(L)
    return { type: 'DOLLAR', value: '$', start, end: L.b }
  }

  if (c === '`') {
    advance(L)
    return { type: 'BACKTICK', value: '`', start, end: L.b }
  }

  // File descriptor before redirect: digit+ immediately followed by > or <
  if (isDigit(c)) {
    let j = L.i
    while (j < L.len && isDigit(L.src[j]!)) j++
    const after = j < L.len ? L.src[j]! : ''
    if (after === '>' || after === '<') {
      const si = L.i
      while (L.i < j) advance(L)
      return {
        type: 'WORD',
        value: L.src.slice(si, L.i),
        start,
        end: L.b,
      }
    }
  }

  // Word / number
  if (isWordStart(c) || c === '{' || c === '}') {
    const si = L.i
    while (L.i < L.len) {
      const ch = L.src[L.i]!
      if (ch === '\\') {
        if (L.i + 1 >= L.len) {
          // Trailing `\` at EOF — tree-sitter excludes it from the word and
          // emits a sibling ERROR. Stop here so the word ends before `\`.
          break
        }
        // Escape next char (including \n for line continuation mid-word)
        if (L.src[L.i + 1] === '\n') {
          advance(L)
          advance(L)
          continue
        }
        advance(L)
        advance(L)
        continue
      }
      if (!isWordChar(ch) && ch !== '{' && ch !== '}') {
        break
      }
      advance(L)
    }
    if (L.i > si) {
      const v = L.src.slice(si, L.i)
      // Number: optional sign then digits only
      if (NUMBER_RE.test(v)) {
        return { type: 'NUMBER', value: v, start, end: L.b }
      }
      return { type: 'WORD', value: v, start, end: L.b }
    }
    // Empty word (lone `\` at EOF) — fall through to single-char consumer
  }

  // Unknown char — consume as single-char word
  advance(L)
  return { type: 'WORD', value: c, start, end: L.b }
}

/** Matches integer literal (optional sign). Hoisted to module scope per
 * `.claudin/rules/typescript-patterns.md` — was inline in legacy code. */
const NUMBER_RE = /^-?\d+$/

/** Packed as (b << 16) | i — avoids heap alloc on every backtrack. */
export type LexSave = number
export function saveLex(L: Lexer): LexSave {
  return L.b * 0x10000 + L.i
}
export function restoreLex(L: Lexer, s: LexSave): void {
  L.i = s & 0xffff
  L.b = s >>> 16
}
