/**
 * Bash test (`[[...]]`) and arithmetic (`((...))`) expression parsers.
 *
 * Extracted from bashParser.ts (11f PR3a). Mutual recursion with the word
 * parser is unavoidable: `[[ ... ]]` operands reuse `parseWord`, and
 * `$((...))` inside words re-enters `parseArithExpr`. ESM handles cycles
 * fine here because nothing executes at module load — all symbols are
 * resolved at call time via the live module namespace.
 */

import { SPECIAL_VARS, type Token } from 'src/platform/bash/bashParser/tokens.js'
import {
  advance,
  isBaseDigit,
  isDigit,
  isHexDigit,
  isIdentChar,
  isIdentStart,
  nextToken,
  peek,
  restoreLex,
  saveLex,
  skipBlanks,
} from 'src/platform/bash/bashParser/lexer.js'
import {
  leaf,
  mk,
  type ParseState,
  type TsNode,
} from 'src/platform/bash/bashParser/parserContext.js'
import {
  parseDollarLike,
  parseDoubleQuoted,
  parseWord,
} from 'src/platform/bash/bashParser/words.js'

export function parseTestExpr(P: ParseState, closer: string): TsNode | null {
  return parseTestOr(P, closer)
}

export function parseTestOr(P: ParseState, closer: string): TsNode | null {
  let left = parseTestAnd(P, closer)
  if (!left) return null
  while (true) {
    skipBlanks(P.L)
    const save = saveLex(P.L)
    if (peek(P.L) === '|' && peek(P.L, 1) === '|') {
      const s = P.L.b
      advance(P.L)
      advance(P.L)
      const op = mk(P, '||', s, P.L.b, [])
      const right = parseTestAnd(P, closer)
      if (!right) {
        restoreLex(P.L, save)
        break
      }
      left = mk(P, 'binary_expression', left.startIndex, right.endIndex, [
        left,
        op,
        right,
      ])
    } else {
      break
    }
  }
  return left
}

export function parseTestAnd(P: ParseState, closer: string): TsNode | null {
  let left = parseTestUnary(P, closer)
  if (!left) return null
  while (true) {
    skipBlanks(P.L)
    if (peek(P.L) === '&' && peek(P.L, 1) === '&') {
      const s = P.L.b
      advance(P.L)
      advance(P.L)
      const op = mk(P, '&&', s, P.L.b, [])
      const right = parseTestUnary(P, closer)
      if (!right) break
      left = mk(P, 'binary_expression', left.startIndex, right.endIndex, [
        left,
        op,
        right,
      ])
    } else {
      break
    }
  }
  return left
}

export function parseTestUnary(P: ParseState, closer: string): TsNode | null {
  skipBlanks(P.L)
  const c = peek(P.L)
  if (c === '(') {
    const s = P.L.b
    advance(P.L)
    const open = mk(P, '(', s, P.L.b, [])
    const inner = parseTestOr(P, closer)
    skipBlanks(P.L)
    let close: TsNode
    if (peek(P.L) === ')') {
      const cs = P.L.b
      advance(P.L)
      close = mk(P, ')', cs, P.L.b, [])
    } else {
      close = mk(P, ')', P.L.b, P.L.b, [])
    }
    const kids = inner ? [open, inner, close] : [open, close]
    return mk(
      P,
      'parenthesized_expression',
      open.startIndex,
      close.endIndex,
      kids,
    )
  }
  return parseTestBinary(P, closer)
}

/**
 * Parse `!`-negated or test-operator (`-f`) or parenthesized primary — but NOT
 * a binary comparison. Used as LHS of binary_expression so `! x =~ y` binds
 * `!` to `x` only, not the whole `x =~ y`.
 */
export function parseTestNegatablePrimary(
  P: ParseState,
  closer: string,
): TsNode | null {
  skipBlanks(P.L)
  const c = peek(P.L)
  if (c === '!') {
    const s = P.L.b
    advance(P.L)
    const bang = mk(P, '!', s, P.L.b, [])
    const inner = parseTestNegatablePrimary(P, closer)
    if (!inner) return bang
    return mk(P, 'unary_expression', bang.startIndex, inner.endIndex, [
      bang,
      inner,
    ])
  }
  if (c === '-' && isIdentStart(peek(P.L, 1))) {
    const s = P.L.b
    advance(P.L)
    while (isIdentChar(peek(P.L))) advance(P.L)
    const op = mk(P, 'test_operator', s, P.L.b, [])
    skipBlanks(P.L)
    const arg = parseTestPrimary(P, closer)
    if (!arg) return op
    return mk(P, 'unary_expression', op.startIndex, arg.endIndex, [op, arg])
  }
  return parseTestPrimary(P, closer)
}

export function parseTestBinary(P: ParseState, closer: string): TsNode | null {
  skipBlanks(P.L)
  // `!` in test context binds tighter than =~/==.
  // `[[ ! "x" =~ y ]]` → (binary_expression (unary_expression (string)) (regex))
  // `[[ ! -f x ]]` → (unary_expression ! (unary_expression (test_operator) (word)))
  const left = parseTestNegatablePrimary(P, closer)
  if (!left) return null
  skipBlanks(P.L)
  // Binary comparison: == != =~ -eq -lt etc.
  const c = peek(P.L)
  const c1 = peek(P.L, 1)
  let op: TsNode | null = null
  const os = P.L.b
  if (c === '=' && c1 === '=') {
    advance(P.L)
    advance(P.L)
    op = mk(P, '==', os, P.L.b, [])
  } else if (c === '!' && c1 === '=') {
    advance(P.L)
    advance(P.L)
    op = mk(P, '!=', os, P.L.b, [])
  } else if (c === '=' && c1 === '~') {
    advance(P.L)
    advance(P.L)
    op = mk(P, '=~', os, P.L.b, [])
  } else if (c === '=' && c1 !== '=') {
    advance(P.L)
    op = mk(P, '=', os, P.L.b, [])
  } else if (c === '<' && c1 !== '<') {
    advance(P.L)
    op = mk(P, '<', os, P.L.b, [])
  } else if (c === '>' && c1 !== '>') {
    advance(P.L)
    op = mk(P, '>', os, P.L.b, [])
  } else if (c === '-' && isIdentStart(c1)) {
    advance(P.L)
    while (isIdentChar(peek(P.L))) advance(P.L)
    op = mk(P, 'test_operator', os, P.L.b, [])
  }
  if (!op) return left
  skipBlanks(P.L)
  // In [[ ]], RHS of ==/!=/=/=~ gets special pattern parsing: paren counting
  // so @(a|b|c) doesn't break on |, and segments become extglob_pattern/regex.
  if (closer === ']]') {
    const opText = op.type
    if (opText === '=~') {
      skipBlanks(P.L)
      // If the ENTIRE RHS is a quoted string, emit string/raw_string not
      // regex: `[[ "$x" =~ "$y" ]]` → (binary_expression (string) (string)).
      // If there's content after the quote (`' boop '(.*)$`), the whole RHS
      // stays a single (regex). Peek past the quote to check.
      const rc = peek(P.L)
      let rhs: TsNode | null = null
      if (rc === '"' || rc === "'") {
        const save = saveLex(P.L)
        const quoted =
          rc === '"'
            ? parseDoubleQuoted(P)
            : leaf(P, 'raw_string', nextToken(P.L, 'arg'))
        // Check if RHS ends here: only whitespace then ]] or &&/|| or newline
        let j = P.L.i
        while (j < P.L.len && (P.src[j] === ' ' || P.src[j] === '\t')) j++
        const nc = P.src[j] ?? ''
        const nc1 = P.src[j + 1] ?? ''
        if (
          (nc === ']' && nc1 === ']') ||
          (nc === '&' && nc1 === '&') ||
          (nc === '|' && nc1 === '|') ||
          nc === '\n' ||
          nc === ''
        ) {
          rhs = quoted
        } else {
          restoreLex(P.L, save)
        }
      }
      if (!rhs) rhs = parseTestRegexRhs(P)
      if (!rhs) return left
      return mk(P, 'binary_expression', left.startIndex, rhs.endIndex, [
        left,
        op,
        rhs,
      ])
    }
    // Single `=` emits (regex) per tree-sitter; `==` and `!=` emit extglob_pattern
    if (opText === '=') {
      const rhs = parseTestRegexRhs(P)
      if (!rhs) return left
      return mk(P, 'binary_expression', left.startIndex, rhs.endIndex, [
        left,
        op,
        rhs,
      ])
    }
    if (opText === '==' || opText === '!=') {
      const parts = parseTestExtglobRhs(P)
      if (parts.length === 0) return left
      const last = parts[parts.length - 1]!
      return mk(P, 'binary_expression', left.startIndex, last.endIndex, [
        left,
        op,
        ...parts,
      ])
    }
  }
  const right = parseTestPrimary(P, closer)
  if (!right) return left
  return mk(P, 'binary_expression', left.startIndex, right.endIndex, [
    left,
    op,
    right,
  ])
}

// RHS of =~ in [[ ]] — scan as single (regex) node with paren/bracket counting
// so | ( ) inside the regex don't break parsing. Stop at ]] or ws+&&/||.
export function parseTestRegexRhs(P: ParseState): TsNode | null {
  skipBlanks(P.L)
  const start = P.L.b
  let parenDepth = 0
  let bracketDepth = 0
  while (P.L.i < P.L.len) {
    const c = peek(P.L)
    if (c === '\\' && P.L.i + 1 < P.L.len) {
      advance(P.L)
      advance(P.L)
      continue
    }
    if (c === '\n') break
    if (parenDepth === 0 && bracketDepth === 0) {
      if (c === ']' && peek(P.L, 1) === ']') break
      if (c === ' ' || c === '\t') {
        // Peek past blanks for ]] or &&/||
        let j = P.L.i
        while (j < P.L.len && (P.L.src[j] === ' ' || P.L.src[j] === '\t')) j++
        const nc = P.L.src[j] ?? ''
        const nc1 = P.L.src[j + 1] ?? ''
        if (
          (nc === ']' && nc1 === ']') ||
          (nc === '&' && nc1 === '&') ||
          (nc === '|' && nc1 === '|')
        ) {
          break
        }
        advance(P.L)
        continue
      }
    }
    if (c === '(') parenDepth++
    else if (c === ')' && parenDepth > 0) parenDepth--
    else if (c === '[') bracketDepth++
    else if (c === ']' && bracketDepth > 0) bracketDepth--
    advance(P.L)
  }
  if (P.L.b === start) return null
  return mk(P, 'regex', start, P.L.b, [])
}

// RHS of ==/!=/= in [[ ]] — returns array of parts. Bare text → extglob_pattern
// (with paren counting for @(a|b)); $(...)/${}/quoted → proper node types.
// Multiple parts become flat children of binary_expression per tree-sitter.
export function parseTestExtglobRhs(P: ParseState): TsNode[] {
  skipBlanks(P.L)
  const parts: TsNode[] = []
  let segStart = P.L.b
  let segStartI = P.L.i
  let parenDepth = 0
  const flushSeg = () => {
    if (P.L.i > segStartI) {
      const text = P.src.slice(segStartI, P.L.i)
      // Pure number stays number; everything else is extglob_pattern
      const type = /^\d+$/.test(text) ? 'number' : 'extglob_pattern'
      parts.push(mk(P, type, segStart, P.L.b, []))
    }
  }
  while (P.L.i < P.L.len) {
    const c = peek(P.L)
    if (c === '\\' && P.L.i + 1 < P.L.len) {
      advance(P.L)
      advance(P.L)
      continue
    }
    if (c === '\n') break
    if (parenDepth === 0) {
      if (c === ']' && peek(P.L, 1) === ']') break
      if (c === ' ' || c === '\t') {
        let j = P.L.i
        while (j < P.L.len && (P.L.src[j] === ' ' || P.L.src[j] === '\t')) j++
        const nc = P.L.src[j] ?? ''
        const nc1 = P.L.src[j + 1] ?? ''
        if (
          (nc === ']' && nc1 === ']') ||
          (nc === '&' && nc1 === '&') ||
          (nc === '|' && nc1 === '|')
        ) {
          break
        }
        advance(P.L)
        continue
      }
    }
    // $ " ' must be parsed even inside @( ) extglob parens — parseDollarLike
    // consumes matching ) so parenDepth stays consistent.
    if (c === '$') {
      const c1 = peek(P.L, 1)
      if (
        c1 === '(' ||
        c1 === '{' ||
        isIdentStart(c1) ||
        SPECIAL_VARS.has(c1)
      ) {
        flushSeg()
        const exp = parseDollarLike(P)
        if (exp) parts.push(exp)
        segStart = P.L.b
        segStartI = P.L.i
        continue
      }
    }
    if (c === '"') {
      flushSeg()
      parts.push(parseDoubleQuoted(P))
      segStart = P.L.b
      segStartI = P.L.i
      continue
    }
    if (c === "'") {
      flushSeg()
      const tok = nextToken(P.L, 'arg')
      parts.push(leaf(P, 'raw_string', tok))
      segStart = P.L.b
      segStartI = P.L.i
      continue
    }
    if (c === '(') parenDepth++
    else if (c === ')' && parenDepth > 0) parenDepth--
    advance(P.L)
  }
  flushSeg()
  return parts
}

export function parseTestPrimary(P: ParseState, closer: string): TsNode | null {
  skipBlanks(P.L)
  // Stop at closer
  if (closer === ']' && peek(P.L) === ']') return null
  if (closer === ']]' && peek(P.L) === ']' && peek(P.L, 1) === ']') return null
  return parseWord(P, 'arg')
}

/**
 * Arithmetic context modes:
 * - 'var': bare identifiers → variable_name (default, used in $((..)), ((..)))
 * - 'word': bare identifiers → word (c-style for head condition/update clauses)
 * - 'assign': identifiers with = → variable_assignment (c-style for init clause)
 */
type ArithMode = 'var' | 'word' | 'assign'

/** Operator precedence table (higher = tighter binding). */
const ARITH_PREC: Record<string, number> = {
  '=': 2,
  '+=': 2,
  '-=': 2,
  '*=': 2,
  '/=': 2,
  '%=': 2,
  '<<=': 2,
  '>>=': 2,
  '&=': 2,
  '^=': 2,
  '|=': 2,
  '||': 4,
  '&&': 5,
  '|': 6,
  '^': 7,
  '&': 8,
  '==': 9,
  '!=': 9,
  '<': 10,
  '>': 10,
  '<=': 10,
  '>=': 10,
  '<<': 11,
  '>>': 11,
  '+': 12,
  '-': 12,
  '*': 13,
  '/': 13,
  '%': 13,
  '**': 14,
}

/** Right-associative operators (assignment and exponent). */
const ARITH_RIGHT_ASSOC = new Set([
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '<<=',
  '>>=',
  '&=',
  '^=',
  '|=',
  '**',
])

export function parseArithExpr(
  P: ParseState,
  stop: string,
  mode: ArithMode = 'var',
): TsNode | null {
  return parseArithTernary(P, stop, mode)
}

/** Top-level: comma-separated list. arithmetic_expansion emits multiple children. */
export function parseArithCommaList(
  P: ParseState,
  stop: string,
  mode: ArithMode = 'var',
): TsNode[] {
  const out: TsNode[] = []
  while (true) {
    const e = parseArithTernary(P, stop, mode)
    if (e) out.push(e)
    skipBlanks(P.L)
    if (peek(P.L) === ',' && !isArithStop(P, stop)) {
      advance(P.L)
      continue
    }
    break
  }
  return out
}

export function parseArithTernary(
  P: ParseState,
  stop: string,
  mode: ArithMode,
): TsNode | null {
  const cond = parseArithBinary(P, stop, 0, mode)
  if (!cond) return null
  skipBlanks(P.L)
  if (peek(P.L) === '?') {
    const qs = P.L.b
    advance(P.L)
    const q = mk(P, '?', qs, P.L.b, [])
    const t = parseArithBinary(P, ':', 0, mode)
    skipBlanks(P.L)
    let colon: TsNode
    if (peek(P.L) === ':') {
      const cs = P.L.b
      advance(P.L)
      colon = mk(P, ':', cs, P.L.b, [])
    } else {
      colon = mk(P, ':', P.L.b, P.L.b, [])
    }
    const f = parseArithTernary(P, stop, mode)
    const last = f ?? colon
    const kids: TsNode[] = [cond, q]
    if (t) kids.push(t)
    kids.push(colon)
    if (f) kids.push(f)
    return mk(P, 'ternary_expression', cond.startIndex, last.endIndex, kids)
  }
  return cond
}

/** Scan next arithmetic binary operator; returns [text, length] or null. */
export function scanArithOp(P: ParseState): [string, number] | null {
  const c = peek(P.L)
  const c1 = peek(P.L, 1)
  const c2 = peek(P.L, 2)
  // 3-char: <<= >>=
  if (c === '<' && c1 === '<' && c2 === '=') return ['<<=', 3]
  if (c === '>' && c1 === '>' && c2 === '=') return ['>>=', 3]
  // 2-char
  if (c === '*' && c1 === '*') return ['**', 2]
  if (c === '<' && c1 === '<') return ['<<', 2]
  if (c === '>' && c1 === '>') return ['>>', 2]
  if (c === '=' && c1 === '=') return ['==', 2]
  if (c === '!' && c1 === '=') return ['!=', 2]
  if (c === '<' && c1 === '=') return ['<=', 2]
  if (c === '>' && c1 === '=') return ['>=', 2]
  if (c === '&' && c1 === '&') return ['&&', 2]
  if (c === '|' && c1 === '|') return ['||', 2]
  if (c === '+' && c1 === '=') return ['+=', 2]
  if (c === '-' && c1 === '=') return ['-=', 2]
  if (c === '*' && c1 === '=') return ['*=', 2]
  if (c === '/' && c1 === '=') return ['/=', 2]
  if (c === '%' && c1 === '=') return ['%=', 2]
  if (c === '&' && c1 === '=') return ['&=', 2]
  if (c === '^' && c1 === '=') return ['^=', 2]
  if (c === '|' && c1 === '=') return ['|=', 2]
  // 1-char — but NOT ++ -- (those are pre/postfix)
  if (c === '+' && c1 !== '+') return ['+', 1]
  if (c === '-' && c1 !== '-') return ['-', 1]
  if (c === '*') return ['*', 1]
  if (c === '/') return ['/', 1]
  if (c === '%') return ['%', 1]
  if (c === '<') return ['<', 1]
  if (c === '>') return ['>', 1]
  if (c === '&') return ['&', 1]
  if (c === '|') return ['|', 1]
  if (c === '^') return ['^', 1]
  if (c === '=') return ['=', 1]
  return null
}

/** Precedence-climbing binary expression parser. */
export function parseArithBinary(
  P: ParseState,
  stop: string,
  minPrec: number,
  mode: ArithMode,
): TsNode | null {
  let left = parseArithUnary(P, stop, mode)
  if (!left) return null
  while (true) {
    skipBlanks(P.L)
    if (isArithStop(P, stop)) break
    if (peek(P.L) === ',') break
    const opInfo = scanArithOp(P)
    if (!opInfo) break
    const [opText, opLen] = opInfo
    const prec = ARITH_PREC[opText]
    if (prec === undefined || prec < minPrec) break
    const os = P.L.b
    for (let k = 0; k < opLen; k++) advance(P.L)
    const op = mk(P, opText, os, P.L.b, [])
    const nextMin = ARITH_RIGHT_ASSOC.has(opText) ? prec : prec + 1
    const right = parseArithBinary(P, stop, nextMin, mode)
    if (!right) break
    left = mk(P, 'binary_expression', left.startIndex, right.endIndex, [
      left,
      op,
      right,
    ])
  }
  return left
}

export function parseArithUnary(
  P: ParseState,
  stop: string,
  mode: ArithMode,
): TsNode | null {
  skipBlanks(P.L)
  if (isArithStop(P, stop)) return null
  const c = peek(P.L)
  const c1 = peek(P.L, 1)
  // Prefix ++ --
  if ((c === '+' && c1 === '+') || (c === '-' && c1 === '-')) {
    const s = P.L.b
    advance(P.L)
    advance(P.L)
    const op = mk(P, c + c1, s, P.L.b, [])
    const inner = parseArithUnary(P, stop, mode)
    if (!inner) return op
    return mk(P, 'unary_expression', op.startIndex, inner.endIndex, [op, inner])
  }
  if (c === '-' || c === '+' || c === '!' || c === '~') {
    // In 'word'/'assign' mode (c-style for head), `-N` is a single number
    // literal per tree-sitter, not unary_expression. 'var' mode uses unary.
    if (mode !== 'var' && c === '-' && isDigit(c1)) {
      const s = P.L.b
      advance(P.L)
      while (isDigit(peek(P.L))) advance(P.L)
      return mk(P, 'number', s, P.L.b, [])
    }
    const s = P.L.b
    advance(P.L)
    const op = mk(P, c, s, P.L.b, [])
    const inner = parseArithUnary(P, stop, mode)
    if (!inner) return op
    return mk(P, 'unary_expression', op.startIndex, inner.endIndex, [op, inner])
  }
  return parseArithPostfix(P, stop, mode)
}

export function parseArithPostfix(
  P: ParseState,
  stop: string,
  mode: ArithMode,
): TsNode | null {
  const prim = parseArithPrimary(P, stop, mode)
  if (!prim) return null
  const c = peek(P.L)
  const c1 = peek(P.L, 1)
  if ((c === '+' && c1 === '+') || (c === '-' && c1 === '-')) {
    const s = P.L.b
    advance(P.L)
    advance(P.L)
    const op = mk(P, c + c1, s, P.L.b, [])
    return mk(P, 'postfix_expression', prim.startIndex, op.endIndex, [prim, op])
  }
  return prim
}

export function parseArithPrimary(
  P: ParseState,
  stop: string,
  mode: ArithMode,
): TsNode | null {
  skipBlanks(P.L)
  if (isArithStop(P, stop)) return null
  const c = peek(P.L)
  if (c === '(') {
    const s = P.L.b
    advance(P.L)
    const open = mk(P, '(', s, P.L.b, [])
    // Parenthesized expression may contain comma-separated exprs
    const inners = parseArithCommaList(P, ')', mode)
    skipBlanks(P.L)
    let close: TsNode
    if (peek(P.L) === ')') {
      const cs = P.L.b
      advance(P.L)
      close = mk(P, ')', cs, P.L.b, [])
    } else {
      close = mk(P, ')', P.L.b, P.L.b, [])
    }
    return mk(P, 'parenthesized_expression', open.startIndex, close.endIndex, [
      open,
      ...inners,
      close,
    ])
  }
  if (c === '"') {
    return parseDoubleQuoted(P)
  }
  if (c === '$') {
    return parseDollarLike(P)
  }
  if (isDigit(c)) {
    const s = P.L.b
    while (isDigit(peek(P.L))) advance(P.L)
    // Hex: 0x1f
    if (
      P.L.b - s === 1 &&
      c === '0' &&
      (peek(P.L) === 'x' || peek(P.L) === 'X')
    ) {
      advance(P.L)
      while (isHexDigit(peek(P.L))) advance(P.L)
    }
    // Base notation: BASE#DIGITS e.g. 2#1010, 16#ff
    else if (peek(P.L) === '#') {
      advance(P.L)
      while (isBaseDigit(peek(P.L))) advance(P.L)
    }
    return mk(P, 'number', s, P.L.b, [])
  }
  if (isIdentStart(c)) {
    const s = P.L.b
    while (isIdentChar(peek(P.L))) advance(P.L)
    const nc = peek(P.L)
    // Assignment in 'assign' mode (c-style for init): emit variable_assignment
    // so chained `a = b = c = 1` nests correctly. Other modes treat `=` as a
    // binary_expression operator via the precedence table.
    if (mode === 'assign') {
      skipBlanks(P.L)
      const ac = peek(P.L)
      const ac1 = peek(P.L, 1)
      if (ac === '=' && ac1 !== '=') {
        const vn = mk(P, 'variable_name', s, P.L.b, [])
        const es = P.L.b
        advance(P.L)
        const eq = mk(P, '=', es, P.L.b, [])
        // RHS may itself be another assignment (chained)
        const val = parseArithTernary(P, stop, mode)
        const end = val ? val.endIndex : eq.endIndex
        const kids = val ? [vn, eq, val] : [vn, eq]
        return mk(P, 'variable_assignment', s, end, kids)
      }
    }
    // Subscript
    if (nc === '[') {
      const vn = mk(P, 'variable_name', s, P.L.b, [])
      const brS = P.L.b
      advance(P.L)
      const brOpen = mk(P, '[', brS, P.L.b, [])
      const idx = parseArithTernary(P, ']', 'var') ?? parseDollarLike(P)
      skipBlanks(P.L)
      let brClose: TsNode
      if (peek(P.L) === ']') {
        const cs = P.L.b
        advance(P.L)
        brClose = mk(P, ']', cs, P.L.b, [])
      } else {
        brClose = mk(P, ']', P.L.b, P.L.b, [])
      }
      const kids = idx ? [vn, brOpen, idx, brClose] : [vn, brOpen, brClose]
      return mk(P, 'subscript', s, brClose.endIndex, kids)
    }
    // Bare identifier: variable_name in 'var' mode, word in 'word'/'assign' mode.
    // 'assign' mode falls through to word when no `=` follows (c-style for
    // cond/update clauses: `c<=5` → binary_expression(word, number)).
    const identType = mode === 'var' ? 'variable_name' : 'word'
    return mk(P, identType, s, P.L.b, [])
  }
  return null
}

export function isArithStop(P: ParseState, stop: string): boolean {
  const c = peek(P.L)
  if (stop === '))') return c === ')' && peek(P.L, 1) === ')'
  if (stop === ')') return c === ')'
  if (stop === ';') return c === ';'
  if (stop === ':') return c === ':'
  if (stop === ']') return c === ']'
  if (stop === '}') return c === '}'
  if (stop === ':}') return c === ':' || c === '}'
  return c === '' || c === '\n'
}
