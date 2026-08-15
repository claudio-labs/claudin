/**
 * Bash word parser — bare words, quoted strings, dollar expansions, brace
 * expressions, backtick command substitutions.
 *
 * Extracted from bashParser.ts (11f PR3a). Mutually recursive with both
 * commands (via `$(...)` and backticks) and expressions (via `$((...))`)
 * — see expressions.ts header for the ESM-cycle rationale.
 */

import { DECL_KEYWORDS, SPECIAL_VARS, type Token } from 'src/platform/bash/bashParser/tokens.js'
import {
  advance,
  isDigit,
  isHeredocDelimChar,
  isIdentChar,
  isIdentStart,
  isWordChar,
  nextToken,
  peek,
  restoreLex,
  saveLex,
  skipBlanks,
} from 'src/platform/bash/bashParser/lexer.js'
import {
  leaf,
  mk,
  sliceBytes,
  type ParseState,
  type TsNode,
} from 'src/platform/bash/bashParser/parserContext.js'
import {
  parseArithCommaList,
  parseArithExpr,
  parseTestExpr,
} from 'src/platform/bash/bashParser/expressions.js'
import {
  parseAndOr,
  parseProcessSub,
  parseStatements,
  parseSubscriptIndexInline,
  scanHeredocBodies,
  tryParseRedirect,
} from 'src/platform/bash/bashParser/commands.js'

/**
 * Parse a word-position element: bare word, string, expansion, or concatenation
 * thereof. Returns a single node; if multiple adjacent fragments, wraps in
 * concatenation.
 */
export function parseWord(P: ParseState, _ctx: 'cmd' | 'arg'): TsNode | null {
  skipBlanks(P.L)
  const parts: TsNode[] = []
  while (P.L.i < P.L.len) {
    const c = peek(P.L)
    if (
      c === ' ' ||
      c === '\t' ||
      c === '\n' ||
      c === '\r' ||
      c === '' ||
      c === '|' ||
      c === '&' ||
      c === ';' ||
      c === '(' ||
      c === ')'
    ) {
      break
    }
    // < > are redirect operators unless <( >( (process substitution)
    if (c === '<' || c === '>') {
      if (peek(P.L, 1) === '(') {
        const ps = parseProcessSub(P)
        if (ps) parts.push(ps)
        continue
      }
      break
    }
    if (c === '"') {
      parts.push(parseDoubleQuoted(P))
      continue
    }
    if (c === "'") {
      const tok = nextToken(P.L, 'arg')
      parts.push(leaf(P, 'raw_string', tok))
      continue
    }
    if (c === '$') {
      const c1 = peek(P.L, 1)
      if (c1 === "'") {
        const tok = nextToken(P.L, 'arg')
        parts.push(leaf(P, 'ansi_c_string', tok))
        continue
      }
      if (c1 === '"') {
        // Translated string: emit $ leaf + string node
        const dTok: Token = {
          type: 'DOLLAR',
          value: '$',
          start: P.L.b,
          end: P.L.b + 1,
        }
        advance(P.L)
        parts.push(leaf(P, '$', dTok))
        parts.push(parseDoubleQuoted(P))
        continue
      }
      if (c1 === '`') {
        // `$` followed by backtick — tree-sitter elides the $ entirely
        // and emits just (command_substitution). Consume $ and let next
        // iteration handle the backtick.
        advance(P.L)
        continue
      }
      const exp = parseDollarLike(P)
      if (exp) parts.push(exp)
      continue
    }
    if (c === '`') {
      if (P.inBacktick > 0) break
      const bt = parseBacktick(P)
      if (bt) parts.push(bt)
      continue
    }
    // Brace expression {1..5} or {a,b,c} — only if looks like one
    if (c === '{') {
      const be = tryParseBraceExpr(P)
      if (be) {
        parts.push(be)
        continue
      }
      // SECURITY: if `{` is immediately followed by a command terminator
      // (; | & newline or EOF), it's a standalone word — don't slurp the
      // rest of the line via tryParseBraceLikeCat. `echo {;touch /tmp/evil`
      // must split on `;` so the security walker sees `touch`.
      const nc = peek(P.L, 1)
      if (
        nc === ';' ||
        nc === '|' ||
        nc === '&' ||
        nc === '\n' ||
        nc === '' ||
        nc === ')' ||
        nc === ' ' ||
        nc === '\t'
      ) {
        const bStart = P.L.b
        advance(P.L)
        parts.push(mk(P, 'word', bStart, P.L.b, []))
        continue
      }
      // Otherwise treat { and } as word fragments
      const cat = tryParseBraceLikeCat(P)
      if (cat) {
        for (const p of cat) parts.push(p)
        continue
      }
    }
    // Standalone `}` in arg position is a word (e.g., `echo }foo`).
    // parseBareWord breaks on `}` so handle it here.
    if (c === '}') {
      const bStart = P.L.b
      advance(P.L)
      parts.push(mk(P, 'word', bStart, P.L.b, []))
      continue
    }
    // `[` and `]` are single-char word fragments (tree-sitter splits at
    // brackets: `[:lower:]` → `[` `:lower:` `]`, `{o[k]}` → 6 words).
    if (c === '[' || c === ']') {
      const bStart = P.L.b
      advance(P.L)
      parts.push(mk(P, 'word', bStart, P.L.b, []))
      continue
    }
    // Bare word fragment
    const frag = parseBareWord(P)
    if (!frag) break
    // `NN#${...}` or `NN#$(...)` → (number (expansion|command_substitution)).
    // Grammar: number can be seq(/-?(0x)?[0-9]+#/, choice(expansion, cmd_sub)).
    // `10#${cmd}` must NOT be concatenation — it's a single number node with
    // the expansion as child. Detect here: frag ends with `#`, next is $ {/(.
    if (
      frag.type === 'word' &&
      /^-?(0x)?[0-9]+#$/.test(frag.text) &&
      peek(P.L) === '$' &&
      (peek(P.L, 1) === '{' || peek(P.L, 1) === '(')
    ) {
      const exp = parseDollarLike(P)
      if (exp) {
        // Prefix `NN#` is an anonymous pattern in grammar — only the
        // expansion/cmd_sub is a named child.
        parts.push(mk(P, 'number', frag.startIndex, exp.endIndex, [exp]))
        continue
      }
    }
    parts.push(frag)
  }
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]!
  // Concatenation
  const first = parts[0]!
  const last = parts[parts.length - 1]!
  return mk(P, 'concatenation', first.startIndex, last.endIndex, parts)
}

export function parseBareWord(P: ParseState): TsNode | null {
  const start = P.L.b
  const startI = P.L.i
  while (P.L.i < P.L.len) {
    const c = peek(P.L)
    if (c === '\\') {
      if (P.L.i + 1 >= P.L.len) {
        // Trailing unpaired `\` at true EOF — tree-sitter emits word WITHOUT
        // the `\` plus a sibling ERROR node. Stop here; caller emits ERROR.
        break
      }
      const nx = P.L.src[P.L.i + 1]
      if (nx === '\n' || (nx === '\r' && P.L.src[P.L.i + 2] === '\n')) {
        // Line continuation BREAKS the word (tree-sitter quirk) — handles \r?\n
        break
      }
      advance(P.L)
      advance(P.L)
      continue
    }
    if (
      c === ' ' ||
      c === '\t' ||
      c === '\n' ||
      c === '\r' ||
      c === '' ||
      c === '|' ||
      c === '&' ||
      c === ';' ||
      c === '(' ||
      c === ')' ||
      c === '<' ||
      c === '>' ||
      c === '"' ||
      c === "'" ||
      c === '$' ||
      c === '`' ||
      c === '{' ||
      c === '}' ||
      c === '[' ||
      c === ']'
    ) {
      break
    }
    advance(P.L)
  }
  if (P.L.b === start) return null
  const text = P.src.slice(startI, P.L.i)
  const type = /^-?\d+$/.test(text) ? 'number' : 'word'
  return mk(P, type, start, P.L.b, [])
}

export function tryParseBraceExpr(P: ParseState): TsNode | null {
  // {N..M} where N, M are numbers or single chars
  const save = saveLex(P.L)
  if (peek(P.L) !== '{') return null
  const oStart = P.L.b
  advance(P.L)
  const oEnd = P.L.b
  // First part
  const p1Start = P.L.b
  while (isDigit(peek(P.L)) || isIdentStart(peek(P.L))) advance(P.L)
  const p1End = P.L.b
  if (p1End === p1Start || peek(P.L) !== '.' || peek(P.L, 1) !== '.') {
    restoreLex(P.L, save)
    return null
  }
  const dotStart = P.L.b
  advance(P.L)
  advance(P.L)
  const dotEnd = P.L.b
  const p2Start = P.L.b
  while (isDigit(peek(P.L)) || isIdentStart(peek(P.L))) advance(P.L)
  const p2End = P.L.b
  if (p2End === p2Start || peek(P.L) !== '}') {
    restoreLex(P.L, save)
    return null
  }
  const cStart = P.L.b
  advance(P.L)
  const cEnd = P.L.b
  const p1Text = sliceBytes(P, p1Start, p1End)
  const p2Text = sliceBytes(P, p2Start, p2End)
  const p1IsNum = /^\d+$/.test(p1Text)
  const p2IsNum = /^\d+$/.test(p2Text)
  // Valid brace expression: both numbers OR both single chars. Mixed = reject.
  if (p1IsNum !== p2IsNum) {
    restoreLex(P.L, save)
    return null
  }
  if (!p1IsNum && (p1Text.length !== 1 || p2Text.length !== 1)) {
    restoreLex(P.L, save)
    return null
  }
  const p1Type = p1IsNum ? 'number' : 'word'
  const p2Type = p2IsNum ? 'number' : 'word'
  return mk(P, 'brace_expression', oStart, cEnd, [
    mk(P, '{', oStart, oEnd, []),
    mk(P, p1Type, p1Start, p1End, []),
    mk(P, '..', dotStart, dotEnd, []),
    mk(P, p2Type, p2Start, p2End, []),
    mk(P, '}', cStart, cEnd, []),
  ])
}

export function tryParseBraceLikeCat(P: ParseState): TsNode[] | null {
  // {a,b,c} or {} → split into word fragments like tree-sitter does
  if (peek(P.L) !== '{') return null
  const oStart = P.L.b
  advance(P.L)
  const oEnd = P.L.b
  const inner: TsNode[] = [mk(P, 'word', oStart, oEnd, [])]
  while (P.L.i < P.L.len) {
    const bc = peek(P.L)
    // SECURITY: stop at command terminators so `{foo;rm x` splits correctly.
    if (
      bc === '}' ||
      bc === '\n' ||
      bc === ';' ||
      bc === '|' ||
      bc === '&' ||
      bc === ' ' ||
      bc === '\t' ||
      bc === '<' ||
      bc === '>' ||
      bc === '(' ||
      bc === ')'
    ) {
      break
    }
    // `[` and `]` are single-char words: {o[k]} → { o [ k ] }
    if (bc === '[' || bc === ']') {
      const bStart = P.L.b
      advance(P.L)
      inner.push(mk(P, 'word', bStart, P.L.b, []))
      continue
    }
    const midStart = P.L.b
    while (P.L.i < P.L.len) {
      const mc = peek(P.L)
      if (
        mc === '}' ||
        mc === '\n' ||
        mc === ';' ||
        mc === '|' ||
        mc === '&' ||
        mc === ' ' ||
        mc === '\t' ||
        mc === '<' ||
        mc === '>' ||
        mc === '(' ||
        mc === ')' ||
        mc === '[' ||
        mc === ']'
      ) {
        break
      }
      advance(P.L)
    }
    const midEnd = P.L.b
    if (midEnd > midStart) {
      const midText = sliceBytes(P, midStart, midEnd)
      const midType = /^-?\d+$/.test(midText) ? 'number' : 'word'
      inner.push(mk(P, midType, midStart, midEnd, []))
    } else {
      break
    }
  }
  if (peek(P.L) === '}') {
    const cStart = P.L.b
    advance(P.L)
    inner.push(mk(P, 'word', cStart, P.L.b, []))
  }
  return inner
}

export function parseDoubleQuoted(P: ParseState): TsNode {
  const qStart = P.L.b
  advance(P.L)
  const qEnd = P.L.b
  const openQ = mk(P, '"', qStart, qEnd, [])
  const parts: TsNode[] = [openQ]
  let contentStart = P.L.b
  let contentStartI = P.L.i
  const flushContent = (): void => {
    if (P.L.b > contentStart) {
      // Tree-sitter's extras rule /\s/ has higher precedence than
      // string_content (prec -1), so whitespace-only segments are elided.
      // `" ${x} "` → (string (expansion)) not (string (string_content)(expansion)(string_content)).
      // Note: this intentionally diverges from preserving all content — cc
      // tests relying on whitespace-only string_content need updating
      // (CCReconcile).
      const txt = P.src.slice(contentStartI, P.L.i)
      if (!/^[ \t]+$/.test(txt)) {
        parts.push(mk(P, 'string_content', contentStart, P.L.b, []))
      }
    }
  }
  while (P.L.i < P.L.len) {
    const c = peek(P.L)
    if (c === '"') break
    if (c === '\\' && P.L.i + 1 < P.L.len) {
      advance(P.L)
      advance(P.L)
      continue
    }
    if (c === '\n') {
      // Split string_content at newline
      flushContent()
      advance(P.L)
      contentStart = P.L.b
      contentStartI = P.L.i
      continue
    }
    if (c === '$') {
      const c1 = peek(P.L, 1)
      if (
        c1 === '(' ||
        c1 === '{' ||
        isIdentStart(c1) ||
        SPECIAL_VARS.has(c1) ||
        isDigit(c1)
      ) {
        flushContent()
        const exp = parseDollarLike(P)
        if (exp) parts.push(exp)
        contentStart = P.L.b
        contentStartI = P.L.i
        continue
      }
      // Bare $ not at end-of-string: tree-sitter emits it as an anonymous
      // '$' token, which splits string_content. $ immediately before the
      // closing " is absorbed into the preceding string_content.
      if (c1 !== '"' && c1 !== '') {
        flushContent()
        const dS = P.L.b
        advance(P.L)
        parts.push(mk(P, '$', dS, P.L.b, []))
        contentStart = P.L.b
        contentStartI = P.L.i
        continue
      }
    }
    if (c === '`') {
      flushContent()
      const bt = parseBacktick(P)
      if (bt) parts.push(bt)
      contentStart = P.L.b
      contentStartI = P.L.i
      continue
    }
    advance(P.L)
  }
  flushContent()
  let close: TsNode
  if (peek(P.L) === '"') {
    const cStart = P.L.b
    advance(P.L)
    close = mk(P, '"', cStart, P.L.b, [])
  } else {
    close = mk(P, '"', P.L.b, P.L.b, [])
  }
  parts.push(close)
  return mk(P, 'string', qStart, close.endIndex, parts)
}

export function parseDollarLike(P: ParseState): TsNode | null {
  const c1 = peek(P.L, 1)
  const dStart = P.L.b
  if (c1 === '(' && peek(P.L, 2) === '(') {
    // $(( arithmetic ))
    advance(P.L)
    advance(P.L)
    advance(P.L)
    const open = mk(P, '$((', dStart, P.L.b, [])
    const exprs = parseArithCommaList(P, '))', 'var')
    skipBlanks(P.L)
    let close: TsNode
    if (peek(P.L) === ')' && peek(P.L, 1) === ')') {
      const cStart = P.L.b
      advance(P.L)
      advance(P.L)
      close = mk(P, '))', cStart, P.L.b, [])
    } else {
      close = mk(P, '))', P.L.b, P.L.b, [])
    }
    return mk(P, 'arithmetic_expansion', dStart, close.endIndex, [
      open,
      ...exprs,
      close,
    ])
  }
  if (c1 === '[') {
    // $[ arithmetic ] — legacy bash syntax, same as $((...))
    advance(P.L)
    advance(P.L)
    const open = mk(P, '$[', dStart, P.L.b, [])
    const exprs = parseArithCommaList(P, ']', 'var')
    skipBlanks(P.L)
    let close: TsNode
    if (peek(P.L) === ']') {
      const cStart = P.L.b
      advance(P.L)
      close = mk(P, ']', cStart, P.L.b, [])
    } else {
      close = mk(P, ']', P.L.b, P.L.b, [])
    }
    return mk(P, 'arithmetic_expansion', dStart, close.endIndex, [
      open,
      ...exprs,
      close,
    ])
  }
  if (c1 === '(') {
    advance(P.L)
    advance(P.L)
    const open = mk(P, '$(', dStart, P.L.b, [])
    let body = parseStatements(P, ')')
    skipBlanks(P.L)
    let close: TsNode
    if (peek(P.L) === ')') {
      const cStart = P.L.b
      advance(P.L)
      close = mk(P, ')', cStart, P.L.b, [])
    } else {
      close = mk(P, ')', P.L.b, P.L.b, [])
    }
    // $(< file) shorthand: unwrap redirected_statement → bare file_redirect
    // tree-sitter emits (command_substitution (file_redirect (word))) directly
    if (
      body.length === 1 &&
      body[0]!.type === 'redirected_statement' &&
      body[0]!.children.length === 1 &&
      body[0]!.children[0]!.type === 'file_redirect'
    ) {
      body = body[0]!.children
    }
    return mk(P, 'command_substitution', dStart, close.endIndex, [
      open,
      ...body,
      close,
    ])
  }
  if (c1 === '{') {
    advance(P.L)
    advance(P.L)
    const open = mk(P, '${', dStart, P.L.b, [])
    const inner = parseExpansionBody(P)
    let close: TsNode
    if (peek(P.L) === '}') {
      const cStart = P.L.b
      advance(P.L)
      close = mk(P, '}', cStart, P.L.b, [])
    } else {
      close = mk(P, '}', P.L.b, P.L.b, [])
    }
    return mk(P, 'expansion', dStart, close.endIndex, [open, ...inner, close])
  }
  // Simple expansion $VAR or $? $$ $@ etc
  advance(P.L)
  const dEnd = P.L.b
  const dollar = mk(P, '$', dStart, dEnd, [])
  const nc = peek(P.L)
  // $_ is special_variable_name only when not followed by more ident chars
  if (nc === '_' && !isIdentChar(peek(P.L, 1))) {
    const vStart = P.L.b
    advance(P.L)
    const vn = mk(P, 'special_variable_name', vStart, P.L.b, [])
    return mk(P, 'simple_expansion', dStart, P.L.b, [dollar, vn])
  }
  if (isIdentStart(nc)) {
    const vStart = P.L.b
    while (isIdentChar(peek(P.L))) advance(P.L)
    const vn = mk(P, 'variable_name', vStart, P.L.b, [])
    return mk(P, 'simple_expansion', dStart, P.L.b, [dollar, vn])
  }
  if (isDigit(nc)) {
    const vStart = P.L.b
    advance(P.L)
    const vn = mk(P, 'variable_name', vStart, P.L.b, [])
    return mk(P, 'simple_expansion', dStart, P.L.b, [dollar, vn])
  }
  if (SPECIAL_VARS.has(nc)) {
    const vStart = P.L.b
    advance(P.L)
    const vn = mk(P, 'special_variable_name', vStart, P.L.b, [])
    return mk(P, 'simple_expansion', dStart, P.L.b, [dollar, vn])
  }
  // Bare $ — just a $ leaf (tree-sitter treats trailing $ as literal)
  return dollar
}

export function parseExpansionBody(P: ParseState): TsNode[] {
  const out: TsNode[] = []
  skipBlanks(P.L)
  // Bizarre cases: ${#!} ${!#} ${!##} ${!# } ${!## } all emit empty (expansion)
  // — both # and ! become anonymous nodes when only combined with each other
  // and optional trailing space before }. Note ${!##/} does NOT match (has
  // content after), so it parses normally as (special_variable_name)(regex).
  {
    const c0 = peek(P.L)
    const c1 = peek(P.L, 1)
    if (c0 === '#' && c1 === '!' && peek(P.L, 2) === '}') {
      advance(P.L)
      advance(P.L)
      return out
    }
    if (c0 === '!' && c1 === '#') {
      // ${!#} ${!##} with optional trailing space then }
      let j = 2
      if (peek(P.L, j) === '#') j++
      if (peek(P.L, j) === ' ') j++
      if (peek(P.L, j) === '}') {
        while (j-- > 0) advance(P.L)
        return out
      }
    }
  }
  // Optional # prefix for length
  if (peek(P.L) === '#') {
    const s = P.L.b
    advance(P.L)
    out.push(mk(P, '#', s, P.L.b, []))
  }
  // Optional ! prefix for indirect expansion: ${!varname} ${!prefix*} ${!prefix@}
  // Only when followed by an identifier — ${!} alone is special var $!
  // Also = ~ prefixes (zsh-style ${=var} ${~var})
  const pc = peek(P.L)
  if (
    (pc === '!' || pc === '=' || pc === '~') &&
    (isIdentStart(peek(P.L, 1)) || isDigit(peek(P.L, 1)))
  ) {
    const s = P.L.b
    advance(P.L)
    out.push(mk(P, pc, s, P.L.b, []))
  }
  skipBlanks(P.L)
  // Variable name
  if (isIdentStart(peek(P.L))) {
    const s = P.L.b
    while (isIdentChar(peek(P.L))) advance(P.L)
    out.push(mk(P, 'variable_name', s, P.L.b, []))
  } else if (isDigit(peek(P.L))) {
    const s = P.L.b
    while (isDigit(peek(P.L))) advance(P.L)
    out.push(mk(P, 'variable_name', s, P.L.b, []))
  } else if (SPECIAL_VARS.has(peek(P.L))) {
    const s = P.L.b
    advance(P.L)
    out.push(mk(P, 'special_variable_name', s, P.L.b, []))
  }
  // Optional subscript [idx] — parsed arithmetically
  if (peek(P.L) === '[') {
    const varNode = out[out.length - 1]
    const brOpen = P.L.b
    advance(P.L)
    const brOpenNode = mk(P, '[', brOpen, P.L.b, [])
    const idx = parseSubscriptIndexInline(P)
    skipBlanks(P.L)
    const brClose = P.L.b
    if (peek(P.L) === ']') advance(P.L)
    const brCloseNode = mk(P, ']', brClose, P.L.b, [])
    if (varNode) {
      const kids = idx
        ? [varNode, brOpenNode, idx, brCloseNode]
        : [varNode, brOpenNode, brCloseNode]
      out[out.length - 1] = mk(P, 'subscript', varNode.startIndex, P.L.b, kids)
    }
  }
  skipBlanks(P.L)
  // Trailing * or @ for indirect expansion (${!prefix*} ${!prefix@}) or
  // @operator for parameter transformation (${var@U} ${var@Q}) — anonymous
  const tc = peek(P.L)
  if ((tc === '*' || tc === '@') && peek(P.L, 1) === '}') {
    const s = P.L.b
    advance(P.L)
    out.push(mk(P, tc, s, P.L.b, []))
    return out
  }
  if (tc === '@' && isIdentStart(peek(P.L, 1))) {
    // ${var@U} transformation — @ is anonymous, consume op char(s)
    const s = P.L.b
    advance(P.L)
    out.push(mk(P, '@', s, P.L.b, []))
    while (isIdentChar(peek(P.L))) advance(P.L)
    return out
  }
  // Operator :- := :? :+ - = ? + # ## % %% / // ^ ^^ , ,, etc.
  const c = peek(P.L)
  // Bare `:` substring operator ${var:off:len} — offset and length parsed
  // arithmetically. Must come BEFORE the generic operator handling so `(` after
  // `:` goes to parenthesized_expression not the array path. `:-` `:=` `:?`
  // `:+` (no space) remain default-value operators; `: -1` (with space before
  // -1) is substring with negative offset.
  if (c === ':') {
    const c1 = peek(P.L, 1)
    // `:\n` or `:}` — empty substring expansion, emits nothing (variable_name only)
    if (c1 === '\n' || c1 === '}') {
      advance(P.L)
      while (peek(P.L) === '\n') advance(P.L)
      return out
    }
    if (c1 !== '-' && c1 !== '=' && c1 !== '?' && c1 !== '+') {
      advance(P.L)
      skipBlanks(P.L)
      // Offset — arithmetic. `-N` at top level is a single number node per
      // tree-sitter; inside parens it's unary_expression(number).
      const offC = peek(P.L)
      let off: TsNode | null
      if (offC === '-' && isDigit(peek(P.L, 1))) {
        const ns = P.L.b
        advance(P.L)
        while (isDigit(peek(P.L))) advance(P.L)
        off = mk(P, 'number', ns, P.L.b, [])
      } else {
        off = parseArithExpr(P, ':}', 'var')
      }
      if (off) out.push(off)
      skipBlanks(P.L)
      if (peek(P.L) === ':') {
        advance(P.L)
        skipBlanks(P.L)
        const lenC = peek(P.L)
        let len: TsNode | null
        if (lenC === '-' && isDigit(peek(P.L, 1))) {
          const ns = P.L.b
          advance(P.L)
          while (isDigit(peek(P.L))) advance(P.L)
          len = mk(P, 'number', ns, P.L.b, [])
        } else {
          len = parseArithExpr(P, '}', 'var')
        }
        if (len) out.push(len)
      }
      return out
    }
  }
  if (
    c === ':' ||
    c === '#' ||
    c === '%' ||
    c === '/' ||
    c === '^' ||
    c === ',' ||
    c === '-' ||
    c === '=' ||
    c === '?' ||
    c === '+'
  ) {
    const s = P.L.b
    const c1 = peek(P.L, 1)
    let op = c
    if (c === ':' && (c1 === '-' || c1 === '=' || c1 === '?' || c1 === '+')) {
      advance(P.L)
      advance(P.L)
      op = c + c1
    } else if (
      (c === '#' || c === '%' || c === '/' || c === '^' || c === ',') &&
      c1 === c
    ) {
      // Doubled operators: ## %% // ^^ ,,
      advance(P.L)
      advance(P.L)
      op = c + c
    } else {
      advance(P.L)
    }
    out.push(mk(P, op, s, P.L.b, []))
    // Rest is the default/replacement — parse as word or regex until }
    // Pattern-matching operators (# ## % %% / // ^ ^^ , ,,) emit regex;
    // value-substitution operators (:- := :? :+ - = ? + :) emit word.
    // `/` and `//` split at next `/` into (regex)+(word) for pat/repl.
    const isPattern =
      op === '#' ||
      op === '##' ||
      op === '%' ||
      op === '%%' ||
      op === '/' ||
      op === '//' ||
      op === '^' ||
      op === '^^' ||
      op === ',' ||
      op === ',,'
    if (op === '/' || op === '//') {
      // Optional /# or /% anchor prefix — anonymous node
      const ac = peek(P.L)
      if (ac === '#' || ac === '%') {
        const aStart = P.L.b
        advance(P.L)
        out.push(mk(P, ac, aStart, P.L.b, []))
      }
      // Pattern: per grammar _expansion_regex_replacement, pattern is
      // choice(regex, string, cmd_sub, seq(string, regex)). If it STARTS
      // with ", emit (string) and any trailing chars become (regex).
      // `${v//"${old}"/}` → (string(expansion)); `${v//"${c}"\//}` →
      // (string)(regex).
      if (peek(P.L) === '"') {
        out.push(parseDoubleQuoted(P))
        const tail = parseExpansionRest(P, 'regex', true)
        if (tail) out.push(tail)
      } else {
        const regex = parseExpansionRest(P, 'regex', true)
        if (regex) out.push(regex)
      }
      if (peek(P.L) === '/') {
        const sepStart = P.L.b
        advance(P.L)
        out.push(mk(P, '/', sepStart, P.L.b, []))
        // Replacement: per grammar, choice includes `seq(cmd_sub, word)`
        // which emits TWO siblings (not concatenation). Also `(` at start
        // of replacement is a regular word char, NOT array — unlike `:-`
        // default-value context. `${v/(/(Gentoo ${x}, }` replacement
        // `(Gentoo ${x}, ` is (concatenation (word)(expansion)(word)).
        const repl = parseExpansionRest(P, 'replword', false)
        if (repl) {
          // seq(cmd_sub, word) special case → siblings. Detected when
          // replacement is a concatenation of exactly 2 parts with first
          // being command_substitution.
          if (
            repl.type === 'concatenation' &&
            repl.children.length === 2 &&
            repl.children[0]!.type === 'command_substitution'
          ) {
            out.push(repl.children[0]!)
            out.push(repl.children[1]!)
          } else {
            out.push(repl)
          }
        }
      }
    } else if (op === '#' || op === '##' || op === '%' || op === '%%') {
      // Pattern-removal: per grammar _expansion_regex, pattern is
      // repeat(choice(regex, string, raw_string, ')')). Each quote/string
      // is a SIBLING, not absorbed into one regex. `${f%'str'*}` →
      // (raw_string)(regex); `${f/'str'*}` (slash) stays single regex.
      for (const p of parseExpansionRegexSegmented(P)) out.push(p)
    } else {
      const rest = parseExpansionRest(P, isPattern ? 'regex' : 'word', false)
      if (rest) out.push(rest)
    }
  }
  return out
}

export function parseExpansionRest(
  P: ParseState,
  nodeType: string,
  stopAtSlash: boolean,
): TsNode | null {
  // Don't skipBlanks — `${var:- }` space IS the word. Stop at } or newline
  // (`${var:\n}` emits no word). stopAtSlash=true stops at `/` for pat/repl
  // split in ${var/pat/repl}. nodeType 'replword' is word-mode for the
  // replacement in `/` `//` — same as 'word' but `(` is NOT array.
  const start = P.L.b
  // Value-substitution RHS starting with `(` parses as array: ${var:-(x)} →
  // (expansion (variable_name) (array (word))). Only for 'word' context (not
  // pattern-matching operators which emit regex, and not 'replword' where `(`
  // is a regular char per grammar `_expansion_regex_replacement`).
  if (nodeType === 'word' && peek(P.L) === '(') {
    advance(P.L)
    const open = mk(P, '(', start, P.L.b, [])
    const elems: TsNode[] = [open]
    while (P.L.i < P.L.len) {
      skipBlanks(P.L)
      const c = peek(P.L)
      if (c === ')' || c === '}' || c === '\n' || c === '') break
      const wStart = P.L.b
      while (P.L.i < P.L.len) {
        const wc = peek(P.L)
        if (
          wc === ')' ||
          wc === '}' ||
          wc === ' ' ||
          wc === '\t' ||
          wc === '\n' ||
          wc === ''
        ) {
          break
        }
        advance(P.L)
      }
      if (P.L.b > wStart) elems.push(mk(P, 'word', wStart, P.L.b, []))
      else break
    }
    if (peek(P.L) === ')') {
      const cStart = P.L.b
      advance(P.L)
      elems.push(mk(P, ')', cStart, P.L.b, []))
    }
    while (peek(P.L) === '\n') advance(P.L)
    return mk(P, 'array', start, P.L.b, elems)
  }
  // REGEX mode: flat single-span scan. Quotes are opaque (skipped past so
  // `/` inside them doesn't break stopAtSlash), but NOT emitted as separate
  // nodes — the entire range becomes one regex node.
  if (nodeType === 'regex') {
    let braceDepth = 0
    while (P.L.i < P.L.len) {
      const c = peek(P.L)
      if (c === '\n') break
      if (braceDepth === 0) {
        if (c === '}') break
        if (stopAtSlash && c === '/') break
      }
      if (c === '\\' && P.L.i + 1 < P.L.len) {
        advance(P.L)
        advance(P.L)
        continue
      }
      if (c === '"' || c === "'") {
        advance(P.L)
        while (P.L.i < P.L.len && peek(P.L) !== c) {
          if (peek(P.L) === '\\' && P.L.i + 1 < P.L.len) advance(P.L)
          advance(P.L)
        }
        if (peek(P.L) === c) advance(P.L)
        continue
      }
      // Skip past nested ${...} $(...) $[...] so their } / don't terminate us
      if (c === '$') {
        const c1 = peek(P.L, 1)
        if (c1 === '{') {
          let d = 0
          advance(P.L)
          advance(P.L)
          d++
          while (P.L.i < P.L.len && d > 0) {
            const nc = peek(P.L)
            if (nc === '{') d++
            else if (nc === '}') d--
            advance(P.L)
          }
          continue
        }
        if (c1 === '(') {
          let d = 0
          advance(P.L)
          advance(P.L)
          d++
          while (P.L.i < P.L.len && d > 0) {
            const nc = peek(P.L)
            if (nc === '(') d++
            else if (nc === ')') d--
            advance(P.L)
          }
          continue
        }
      }
      if (c === '{') braceDepth++
      else if (c === '}' && braceDepth > 0) braceDepth--
      advance(P.L)
    }
    const end = P.L.b
    while (peek(P.L) === '\n') advance(P.L)
    if (end === start) return null
    return mk(P, 'regex', start, end, [])
  }
  // WORD mode: segmenting parser — recognize nested ${...}, $(...), $'...',
  // "...", '...', $ident, <(...)/>(...); bare chars accumulate into word
  // segments. Multiple parts → wrapped in concatenation.
  const parts: TsNode[] = []
  let segStart = P.L.b
  let braceDepth = 0
  const flushSeg = (): void => {
    if (P.L.b > segStart) {
      parts.push(mk(P, 'word', segStart, P.L.b, []))
    }
  }
  while (P.L.i < P.L.len) {
    const c = peek(P.L)
    if (c === '\n') break
    if (braceDepth === 0) {
      if (c === '}') break
      if (stopAtSlash && c === '/') break
    }
    if (c === '\\' && P.L.i + 1 < P.L.len) {
      advance(P.L)
      advance(P.L)
      continue
    }
    const c1 = peek(P.L, 1)
    if (c === '$') {
      if (c1 === '{' || c1 === '(' || c1 === '[') {
        flushSeg()
        const exp = parseDollarLike(P)
        if (exp) parts.push(exp)
        segStart = P.L.b
        continue
      }
      if (c1 === "'") {
        // $'...' ANSI-C string
        flushSeg()
        const aStart = P.L.b
        advance(P.L)
        advance(P.L)
        while (P.L.i < P.L.len && peek(P.L) !== "'") {
          if (peek(P.L) === '\\' && P.L.i + 1 < P.L.len) advance(P.L)
          advance(P.L)
        }
        if (peek(P.L) === "'") advance(P.L)
        parts.push(mk(P, 'ansi_c_string', aStart, P.L.b, []))
        segStart = P.L.b
        continue
      }
      if (isIdentStart(c1) || isDigit(c1) || SPECIAL_VARS.has(c1)) {
        flushSeg()
        const exp = parseDollarLike(P)
        if (exp) parts.push(exp)
        segStart = P.L.b
        continue
      }
    }
    if (c === '"') {
      flushSeg()
      parts.push(parseDoubleQuoted(P))
      segStart = P.L.b
      continue
    }
    if (c === "'") {
      flushSeg()
      const rStart = P.L.b
      advance(P.L)
      while (P.L.i < P.L.len && peek(P.L) !== "'") advance(P.L)
      if (peek(P.L) === "'") advance(P.L)
      parts.push(mk(P, 'raw_string', rStart, P.L.b, []))
      segStart = P.L.b
      continue
    }
    if ((c === '<' || c === '>') && c1 === '(') {
      flushSeg()
      const ps = parseProcessSub(P)
      if (ps) parts.push(ps)
      segStart = P.L.b
      continue
    }
    if (c === '`') {
      flushSeg()
      const bt = parseBacktick(P)
      if (bt) parts.push(bt)
      segStart = P.L.b
      continue
    }
    // Brace tracking so nested {a,b} brace-expansion chars don't prematurely
    // terminate (rare, but the `?` in `${cond}? (` should be treated as word).
    if (c === '{') braceDepth++
    else if (c === '}' && braceDepth > 0) braceDepth--
    advance(P.L)
  }
  flushSeg()
  // Consume trailing newlines before } so caller sees }
  while (peek(P.L) === '\n') advance(P.L)
  // Tree-sitter skips leading whitespace (extras) in expansion RHS when
  // there's content after: `${2+ ${2}}` → just (expansion). But `${v:- }`
  // (space-only RHS) keeps the space as (word). So drop leading whitespace-
  // only word segment if it's NOT the only part.
  if (
    parts.length > 1 &&
    parts[0]!.type === 'word' &&
    /^[ \t]+$/.test(parts[0]!.text)
  ) {
    parts.shift()
  }
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]!
  // Multiple parts: wrap in concatenation (word mode keeps concat wrapping;
  // regex mode also concats per tree-sitter for mixed quote+glob patterns).
  const last = parts[parts.length - 1]!
  return mk(P, 'concatenation', parts[0]!.startIndex, last.endIndex, parts)
}

// Pattern for # ## % %% operators — per grammar _expansion_regex:
// repeat(choice(regex, string, raw_string, ')', /\s+/→regex)). Each quote
// becomes a SIBLING node, not absorbed. `${f%'str'*}` → (raw_string)(regex).
export function parseExpansionRegexSegmented(P: ParseState): TsNode[] {
  const out: TsNode[] = []
  let segStart = P.L.b
  const flushRegex = (): void => {
    if (P.L.b > segStart) out.push(mk(P, 'regex', segStart, P.L.b, []))
  }
  while (P.L.i < P.L.len) {
    const c = peek(P.L)
    if (c === '}' || c === '\n') break
    if (c === '\\' && P.L.i + 1 < P.L.len) {
      advance(P.L)
      advance(P.L)
      continue
    }
    if (c === '"') {
      flushRegex()
      out.push(parseDoubleQuoted(P))
      segStart = P.L.b
      continue
    }
    if (c === "'") {
      flushRegex()
      const rStart = P.L.b
      advance(P.L)
      while (P.L.i < P.L.len && peek(P.L) !== "'") advance(P.L)
      if (peek(P.L) === "'") advance(P.L)
      out.push(mk(P, 'raw_string', rStart, P.L.b, []))
      segStart = P.L.b
      continue
    }
    // Nested ${...} $(...) — opaque scan so their } doesn't terminate us
    if (c === '$') {
      const c1 = peek(P.L, 1)
      if (c1 === '{') {
        let d = 1
        advance(P.L)
        advance(P.L)
        while (P.L.i < P.L.len && d > 0) {
          const nc = peek(P.L)
          if (nc === '{') d++
          else if (nc === '}') d--
          advance(P.L)
        }
        continue
      }
      if (c1 === '(') {
        let d = 1
        advance(P.L)
        advance(P.L)
        while (P.L.i < P.L.len && d > 0) {
          const nc = peek(P.L)
          if (nc === '(') d++
          else if (nc === ')') d--
          advance(P.L)
        }
        continue
      }
    }
    advance(P.L)
  }
  flushRegex()
  while (peek(P.L) === '\n') advance(P.L)
  return out
}

export function parseBacktick(P: ParseState): TsNode | null {
  const start = P.L.b
  advance(P.L)
  const open = mk(P, '`', start, P.L.b, [])
  P.inBacktick++
  // Parse statements inline — stop at closing backtick
  const body: TsNode[] = []
  while (true) {
    skipBlanks(P.L)
    if (peek(P.L) === '`' || peek(P.L) === '') break
    const save = saveLex(P.L)
    const t = nextToken(P.L, 'cmd')
    if (t.type === 'EOF' || t.type === 'BACKTICK') {
      restoreLex(P.L, save)
      break
    }
    if (t.type === 'NEWLINE') continue
    restoreLex(P.L, save)
    const stmt = parseAndOr(P)
    if (!stmt) break
    body.push(stmt)
    skipBlanks(P.L)
    if (peek(P.L) === '`') break
    const save2 = saveLex(P.L)
    const sep = nextToken(P.L, 'cmd')
    if (sep.type === 'OP' && (sep.value === ';' || sep.value === '&')) {
      body.push(leaf(P, sep.value, sep))
    } else if (sep.type !== 'NEWLINE') {
      restoreLex(P.L, save2)
    }
  }
  P.inBacktick--
  let close: TsNode
  if (peek(P.L) === '`') {
    const cStart = P.L.b
    advance(P.L)
    close = mk(P, '`', cStart, P.L.b, [])
  } else {
    close = mk(P, '`', P.L.b, P.L.b, [])
  }
  // Empty backticks (whitespace/newline only) are elided entirely by
  // tree-sitter — used as a line-continuation hack: "foo"`<newline>`"bar"
  // → (concatenation (string) (string)) with no command_substitution.
  if (body.length === 0) return null
  return mk(P, 'command_substitution', start, close.endIndex, [
    open,
    ...body,
    close,
  ])
}
