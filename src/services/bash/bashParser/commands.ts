/**
 * Bash command parser — statements, pipelines, simple/compound commands,
 * redirects, heredocs, assignments, control-flow (if/while/for/case),
 * function definitions, and declaration commands (export/declare/...).
 *
 * Extracted from bashParser.ts (11f PR3a). Mutually recursive with words
 * (commands consume words as arguments; `$(...)` re-enters statements)
 * and expressions (`((...))` arithmetic commands, `[[...]]` test commands).
 */

import {
  DECL_KEYWORDS,
  SHELL_KEYWORDS,
  SPECIAL_VARS,
  type Token,
} from 'src/services/bash/bashParser/tokens.js'
import {
  advance,
  byteAt,
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
} from 'src/services/bash/bashParser/lexer.js'
import {
  leaf,
  mk,
  sliceBytes,
  type ParseState,
  type TsNode,
} from 'src/services/bash/bashParser/parserContext.js'
import {
  parseArithCommaList,
  parseArithExpr,
  parseTestExpr,
} from 'src/services/bash/bashParser/expressions.js'
import {
  parseBacktick,
  parseBareWord,
  parseDollarLike,
  parseDoubleQuoted,
  parseWord,
} from 'src/services/bash/bashParser/words.js'

/**
 * Parse a sequence of statements separated by ; & newline. Returns a flat list
 * where ; and & are sibling leaves (NOT wrapped in 'list' — only && || get
 * that). Stops at terminator or EOF.
 */
export function parseStatements(P: ParseState, terminator: string | null): TsNode[] {
  const out: TsNode[] = []
  while (true) {
    skipBlanks(P.L)
    const save = saveLex(P.L)
    const t = nextToken(P.L, 'cmd')
    if (t.type === 'EOF') {
      restoreLex(P.L, save)
      break
    }
    if (t.type === 'NEWLINE') {
      // Process pending heredocs
      if (P.L.heredocs.length > 0) {
        scanHeredocBodies(P)
      }
      continue
    }
    if (t.type === 'COMMENT') {
      out.push(leaf(P, 'comment', t))
      continue
    }
    if (terminator && t.type === 'OP' && t.value === terminator) {
      restoreLex(P.L, save)
      break
    }
    if (
      t.type === 'OP' &&
      (t.value === ')' ||
        t.value === '}' ||
        t.value === ';;' ||
        t.value === ';&' ||
        t.value === ';;&' ||
        t.value === '))' ||
        t.value === ']]' ||
        t.value === ']')
    ) {
      restoreLex(P.L, save)
      break
    }
    if (t.type === 'BACKTICK' && P.inBacktick > 0) {
      restoreLex(P.L, save)
      break
    }
    if (
      t.type === 'WORD' &&
      (t.value === 'then' ||
        t.value === 'elif' ||
        t.value === 'else' ||
        t.value === 'fi' ||
        t.value === 'do' ||
        t.value === 'done' ||
        t.value === 'esac')
    ) {
      restoreLex(P.L, save)
      break
    }
    restoreLex(P.L, save)
    const stmt = parseAndOr(P)
    if (!stmt) break
    out.push(stmt)
    // Look for separator
    skipBlanks(P.L)
    const save2 = saveLex(P.L)
    const sep = nextToken(P.L, 'cmd')
    if (sep.type === 'OP' && (sep.value === ';' || sep.value === '&')) {
      // Check if terminator follows — if so, emit separator but stop
      const save3 = saveLex(P.L)
      const after = nextToken(P.L, 'cmd')
      restoreLex(P.L, save3)
      out.push(leaf(P, sep.value, sep))
      if (
        after.type === 'EOF' ||
        (after.type === 'OP' &&
          (after.value === ')' ||
            after.value === '}' ||
            after.value === ';;' ||
            after.value === ';&' ||
            after.value === ';;&')) ||
        (after.type === 'WORD' &&
          (after.value === 'then' ||
            after.value === 'elif' ||
            after.value === 'else' ||
            after.value === 'fi' ||
            after.value === 'do' ||
            after.value === 'done' ||
            after.value === 'esac'))
      ) {
        // Trailing separator — don't include it at program level unless
        // there's content after. But at inner levels we keep it.
        continue
      }
    } else if (sep.type === 'NEWLINE') {
      if (P.L.heredocs.length > 0) {
        scanHeredocBodies(P)
      }
      continue
    } else {
      restoreLex(P.L, save2)
    }
  }
  // Trim trailing separator if at program level
  return out
}

/**
 * Parse pipeline chains joined by && ||. Left-associative nesting.
 * tree-sitter quirk: trailing redirect on the last pipeline wraps the ENTIRE
 * list in a redirected_statement — `a > x && b > y` becomes
 * redirected_statement(list(redirected_statement(a,>x), &&, b), >y).
 */
export function parseAndOr(P: ParseState): TsNode | null {
  let left = parsePipeline(P)
  if (!left) return null
  while (true) {
    const save = saveLex(P.L)
    const t = nextToken(P.L, 'cmd')
    if (t.type === 'OP' && (t.value === '&&' || t.value === '||')) {
      const op = leaf(P, t.value, t)
      skipNewlines(P)
      const right = parsePipeline(P)
      if (!right) {
        left = mk(P, 'list', left.startIndex, op.endIndex, [left, op])
        break
      }
      // If right is a redirected_statement, hoist its redirects to wrap the list.
      if (right.type === 'redirected_statement' && right.children.length >= 2) {
        const inner = right.children[0]!
        const redirs = right.children.slice(1)
        const listNode = mk(P, 'list', left.startIndex, inner.endIndex, [
          left,
          op,
          inner,
        ])
        const lastR = redirs[redirs.length - 1]!
        left = mk(
          P,
          'redirected_statement',
          listNode.startIndex,
          lastR.endIndex,
          [listNode, ...redirs],
        )
      } else {
        left = mk(P, 'list', left.startIndex, right.endIndex, [left, op, right])
      }
    } else {
      restoreLex(P.L, save)
      break
    }
  }
  return left
}

export function skipNewlines(P: ParseState): void {
  while (true) {
    const save = saveLex(P.L)
    const t = nextToken(P.L, 'cmd')
    if (t.type !== 'NEWLINE') {
      restoreLex(P.L, save)
      break
    }
  }
}

/**
 * Parse commands joined by | or |&. Flat children with operator leaves.
 * tree-sitter quirk: `a | b 2>nul | c` hoists the redirect on `b` to wrap
 * the preceding pipeline fragment — pipeline(redirected_statement(
 * pipeline(a,|,b), 2>nul), |, c).
 */
export function parsePipeline(P: ParseState): TsNode | null {
  let first = parseCommand(P)
  if (!first) return null
  const parts: TsNode[] = [first]
  while (true) {
    const save = saveLex(P.L)
    const t = nextToken(P.L, 'cmd')
    if (t.type === 'OP' && (t.value === '|' || t.value === '|&')) {
      const op = leaf(P, t.value, t)
      skipNewlines(P)
      const next = parseCommand(P)
      if (!next) {
        parts.push(op)
        break
      }
      // Hoist trailing redirect on `next` to wrap current pipeline fragment
      if (
        next.type === 'redirected_statement' &&
        next.children.length >= 2 &&
        parts.length >= 1
      ) {
        const inner = next.children[0]!
        const redirs = next.children.slice(1)
        // Wrap existing parts + op + inner as a pipeline
        const pipeKids = [...parts, op, inner]
        const pipeNode = mk(
          P,
          'pipeline',
          pipeKids[0]!.startIndex,
          inner.endIndex,
          pipeKids,
        )
        const lastR = redirs[redirs.length - 1]!
        const wrapped = mk(
          P,
          'redirected_statement',
          pipeNode.startIndex,
          lastR.endIndex,
          [pipeNode, ...redirs],
        )
        parts.length = 0
        parts.push(wrapped)
        first = wrapped
        continue
      }
      parts.push(op, next)
    } else {
      restoreLex(P.L, save)
      break
    }
  }
  if (parts.length === 1) return parts[0]!
  const last = parts[parts.length - 1]!
  return mk(P, 'pipeline', parts[0]!.startIndex, last.endIndex, parts)
}

/** Parse a single command: simple, compound, or control structure. */
export function parseCommand(P: ParseState): TsNode | null {
  skipBlanks(P.L)
  const save = saveLex(P.L)
  const t = nextToken(P.L, 'cmd')

  if (t.type === 'EOF') {
    restoreLex(P.L, save)
    return null
  }

  // Negation — tree-sitter wraps just the command, redirects go outside.
  // `! cmd > out` → redirected_statement(negated_command(!, cmd), >out)
  if (t.type === 'OP' && t.value === '!') {
    const bang = leaf(P, '!', t)
    const inner = parseCommand(P)
    if (!inner) {
      restoreLex(P.L, save)
      return null
    }
    // If inner is a redirected_statement, hoist redirects outside negation
    if (inner.type === 'redirected_statement' && inner.children.length >= 2) {
      const cmd = inner.children[0]!
      const redirs = inner.children.slice(1)
      const neg = mk(P, 'negated_command', bang.startIndex, cmd.endIndex, [
        bang,
        cmd,
      ])
      const lastR = redirs[redirs.length - 1]!
      return mk(P, 'redirected_statement', neg.startIndex, lastR.endIndex, [
        neg,
        ...redirs,
      ])
    }
    return mk(P, 'negated_command', bang.startIndex, inner.endIndex, [
      bang,
      inner,
    ])
  }

  if (t.type === 'OP' && t.value === '(') {
    const open = leaf(P, '(', t)
    const body = parseStatements(P, ')')
    const closeTok = nextToken(P.L, 'cmd')
    const close =
      closeTok.type === 'OP' && closeTok.value === ')'
        ? leaf(P, ')', closeTok)
        : mk(P, ')', open.endIndex, open.endIndex, [])
    const node = mk(P, 'subshell', open.startIndex, close.endIndex, [
      open,
      ...body,
      close,
    ])
    return maybeRedirect(P, node)
  }

  if (t.type === 'OP' && t.value === '((') {
    const open = leaf(P, '((', t)
    const exprs = parseArithCommaList(P, '))', 'var')
    const closeTok = nextToken(P.L, 'cmd')
    const close =
      closeTok.value === '))'
        ? leaf(P, '))', closeTok)
        : mk(P, '))', open.endIndex, open.endIndex, [])
    return mk(P, 'compound_statement', open.startIndex, close.endIndex, [
      open,
      ...exprs,
      close,
    ])
  }

  if (t.type === 'OP' && t.value === '{') {
    const open = leaf(P, '{', t)
    const body = parseStatements(P, '}')
    const closeTok = nextToken(P.L, 'cmd')
    const close =
      closeTok.type === 'OP' && closeTok.value === '}'
        ? leaf(P, '}', closeTok)
        : mk(P, '}', open.endIndex, open.endIndex, [])
    const node = mk(P, 'compound_statement', open.startIndex, close.endIndex, [
      open,
      ...body,
      close,
    ])
    return maybeRedirect(P, node)
  }

  if (t.type === 'OP' && (t.value === '[' || t.value === '[[')) {
    const open = leaf(P, t.value, t)
    const closer = t.value === '[' ? ']' : ']]'
    // Grammar: `[` can contain choice(_expression, redirected_statement).
    // Try _expression first; if we don't reach `]`, backtrack and parse as
    // redirected_statement (handles `[ ! cmd -v go &>/dev/null ]`).
    const exprSave = saveLex(P.L)
    let expr = parseTestExpr(P, closer)
    skipBlanks(P.L)
    if (t.value === '[' && peek(P.L) !== ']') {
      // Expression parse didn't reach `]` — try as redirected_statement.
      // Thread `]` stop-token so parseSimpleCommand doesn't eat it as arg.
      restoreLex(P.L, exprSave)
      const prevStop = P.stopToken
      P.stopToken = ']'
      const rstmt = parseCommand(P)
      P.stopToken = prevStop
      if (rstmt && rstmt.type === 'redirected_statement') {
        expr = rstmt
      } else {
        // Neither worked — restore and keep the expression result
        restoreLex(P.L, exprSave)
        expr = parseTestExpr(P, closer)
      }
      skipBlanks(P.L)
    }
    const closeTok = nextToken(P.L, 'arg')
    let close: TsNode
    if (closeTok.value === closer) {
      close = leaf(P, closer, closeTok)
    } else {
      close = mk(P, closer, open.endIndex, open.endIndex, [])
    }
    const kids = expr ? [open, expr, close] : [open, close]
    return mk(P, 'test_command', open.startIndex, close.endIndex, kids)
  }

  if (t.type === 'WORD') {
    if (t.value === 'if') return maybeRedirect(P, parseIf(P, t), true)
    if (t.value === 'while' || t.value === 'until')
      return maybeRedirect(P, parseWhile(P, t), true)
    if (t.value === 'for') return maybeRedirect(P, parseFor(P, t), true)
    if (t.value === 'select') return maybeRedirect(P, parseFor(P, t), true)
    if (t.value === 'case') return maybeRedirect(P, parseCase(P, t), true)
    if (t.value === 'function') return parseFunction(P, t)
    if (DECL_KEYWORDS.has(t.value))
      return maybeRedirect(P, parseDeclaration(P, t))
    if (t.value === 'unset' || t.value === 'unsetenv') {
      return maybeRedirect(P, parseUnset(P, t))
    }
  }

  restoreLex(P.L, save)
  return parseSimpleCommand(P)
}

/**
 * Parse a simple command: [assignment]* word [arg|redirect]*
 * Returns variable_assignment if only one assignment and no command.
 */
export function parseSimpleCommand(P: ParseState): TsNode | null {
  const start = P.L.b
  const assignments: TsNode[] = []
  const preRedirects: TsNode[] = []

  while (true) {
    skipBlanks(P.L)
    const a = tryParseAssignment(P)
    if (a) {
      assignments.push(a)
      continue
    }
    const r = tryParseRedirect(P)
    if (r) {
      preRedirects.push(r)
      continue
    }
    break
  }

  skipBlanks(P.L)
  const save = saveLex(P.L)
  const nameTok = nextToken(P.L, 'cmd')
  if (
    nameTok.type === 'EOF' ||
    nameTok.type === 'NEWLINE' ||
    nameTok.type === 'COMMENT' ||
    (nameTok.type === 'OP' &&
      nameTok.value !== '{' &&
      nameTok.value !== '[' &&
      nameTok.value !== '[[') ||
    (nameTok.type === 'WORD' &&
      SHELL_KEYWORDS.has(nameTok.value) &&
      nameTok.value !== 'in')
  ) {
    restoreLex(P.L, save)
    // No command — standalone assignment(s) or redirect
    if (assignments.length === 1 && preRedirects.length === 0) {
      return assignments[0]!
    }
    if (preRedirects.length > 0 && assignments.length === 0) {
      // Bare redirect → redirected_statement with just file_redirect children
      const last = preRedirects[preRedirects.length - 1]!
      return mk(
        P,
        'redirected_statement',
        preRedirects[0]!.startIndex,
        last.endIndex,
        preRedirects,
      )
    }
    if (assignments.length > 1 && preRedirects.length === 0) {
      // `A=1 B=2` with no command → variable_assignments (plural)
      const last = assignments[assignments.length - 1]!
      return mk(
        P,
        'variable_assignments',
        assignments[0]!.startIndex,
        last.endIndex,
        assignments,
      )
    }
    if (assignments.length > 0 || preRedirects.length > 0) {
      const all = [...assignments, ...preRedirects]
      const last = all[all.length - 1]!
      return mk(P, 'command', start, last.endIndex, all)
    }
    return null
  }
  restoreLex(P.L, save)

  // Check for function definition: name() { ... }
  const fnSave = saveLex(P.L)
  const nm = parseWord(P, 'cmd')
  if (nm && nm.type === 'word') {
    skipBlanks(P.L)
    if (peek(P.L) === '(' && peek(P.L, 1) === ')') {
      const oTok = nextToken(P.L, 'cmd')
      const cTok = nextToken(P.L, 'cmd')
      const oParen = leaf(P, '(', oTok)
      const cParen = leaf(P, ')', cTok)
      skipBlanks(P.L)
      skipNewlines(P)
      const body = parseCommand(P)
      if (body) {
        // If body is redirected_statement(compound_statement, file_redirect...),
        // hoist redirects to function_definition level per tree-sitter grammar
        let bodyKids: TsNode[] = [body]
        if (
          body.type === 'redirected_statement' &&
          body.children.length >= 2 &&
          body.children[0]!.type === 'compound_statement'
        ) {
          bodyKids = body.children
        }
        const last = bodyKids[bodyKids.length - 1]!
        return mk(P, 'function_definition', nm.startIndex, last.endIndex, [
          nm,
          oParen,
          cParen,
          ...bodyKids,
        ])
      }
    }
  }
  restoreLex(P.L, fnSave)

  const nameArg = parseWord(P, 'cmd')
  if (!nameArg) {
    if (assignments.length === 1) return assignments[0]!
    return null
  }

  const cmdName = mk(P, 'command_name', nameArg.startIndex, nameArg.endIndex, [
    nameArg,
  ])

  const args: TsNode[] = []
  const redirects: TsNode[] = []
  let heredocRedirect: TsNode | null = null

  while (true) {
    skipBlanks(P.L)
    // Post-command redirects are greedy (repeat1 $._literal) — once a redirect
    // appears after command_name, subsequent literals attach to it per grammar's
    // prec.left. `grep 2>/dev/null -q foo` → file_redirect eats `-q foo`.
    // Args parsed BEFORE the first redirect still go to command (cat a b > out).
    const r = tryParseRedirect(P, true)
    if (r) {
      if (r.type === 'heredoc_redirect') {
        heredocRedirect = r
      } else if (r.type === 'herestring_redirect') {
        args.push(r)
      } else {
        redirects.push(r)
      }
      continue
    }
    // Once a file_redirect has been seen, command args are done — grammar's
    // command rule doesn't allow file_redirect in its post-name choice, so
    // anything after belongs to redirected_statement's file_redirect children.
    if (redirects.length > 0) break
    // `[` test_command backtrack — stop at `]` so outer handler can consume it
    if (P.stopToken === ']' && peek(P.L) === ']') break
    const save2 = saveLex(P.L)
    const pk = nextToken(P.L, 'arg')
    if (
      pk.type === 'EOF' ||
      pk.type === 'NEWLINE' ||
      pk.type === 'COMMENT' ||
      (pk.type === 'OP' &&
        (pk.value === '|' ||
          pk.value === '|&' ||
          pk.value === '&&' ||
          pk.value === '||' ||
          pk.value === ';' ||
          pk.value === ';;' ||
          pk.value === ';&' ||
          pk.value === ';;&' ||
          pk.value === '&' ||
          pk.value === ')' ||
          pk.value === '}' ||
          pk.value === '))'))
    ) {
      restoreLex(P.L, save2)
      break
    }
    restoreLex(P.L, save2)
    const arg = parseWord(P, 'arg')
    if (!arg) {
      // Lone `(` in arg position — tree-sitter parses this as subshell arg
      // e.g., `echo =(cmd)` → command has ERROR(=), subshell(cmd) as args
      if (peek(P.L) === '(') {
        const oTok = nextToken(P.L, 'cmd')
        const open = leaf(P, '(', oTok)
        const body = parseStatements(P, ')')
        const cTok = nextToken(P.L, 'cmd')
        const close =
          cTok.type === 'OP' && cTok.value === ')'
            ? leaf(P, ')', cTok)
            : mk(P, ')', open.endIndex, open.endIndex, [])
        args.push(
          mk(P, 'subshell', open.startIndex, close.endIndex, [
            open,
            ...body,
            close,
          ]),
        )
        continue
      }
      break
    }
    // Lone `=` in arg position is a parse error in bash — tree-sitter wraps
    // it in ERROR for recovery. Happens in `echo =(cmd)` (zsh process-sub).
    if (arg.type === 'word' && arg.text === '=') {
      args.push(mk(P, 'ERROR', arg.startIndex, arg.endIndex, [arg]))
      continue
    }
    // Word immediately followed by `(` (no whitespace) is a parse error —
    // bash doesn't allow glob-then-subshell adjacency. tree-sitter wraps the
    // word in ERROR. Catches zsh glob qualifiers like `*.(e:'cmd':)`.
    if (
      (arg.type === 'word' || arg.type === 'concatenation') &&
      peek(P.L) === '(' &&
      P.L.b === arg.endIndex
    ) {
      args.push(mk(P, 'ERROR', arg.startIndex, arg.endIndex, [arg]))
      continue
    }
    args.push(arg)
  }

  // preRedirects (e.g., `2>&1 cat`, `<<<str cmd`) go INSIDE the command node
  // before command_name per tree-sitter grammar, not in redirected_statement
  const cmdChildren = [...assignments, ...preRedirects, cmdName, ...args]
  const cmdEnd =
    cmdChildren.length > 0
      ? cmdChildren[cmdChildren.length - 1]!.endIndex
      : cmdName.endIndex
  const cmdStart = cmdChildren[0]!.startIndex
  const cmd = mk(P, 'command', cmdStart, cmdEnd, cmdChildren)

  if (heredocRedirect) {
    // Scan heredoc body now
    scanHeredocBodies(P)
    const hd = P.L.heredocs.shift()
    if (hd && heredocRedirect.children.length >= 2) {
      const bodyNode = mk(
        P,
        'heredoc_body',
        hd.bodyStart,
        hd.bodyEnd,
        hd.quoted ? [] : parseHeredocBodyContent(P, hd.bodyStart, hd.bodyEnd),
      )
      const endNode = mk(P, 'heredoc_end', hd.endStart, hd.endEnd, [])
      heredocRedirect.children.push(bodyNode, endNode)
      heredocRedirect.endIndex = hd.endEnd
      heredocRedirect.text = sliceBytes(
        P,
        heredocRedirect.startIndex,
        hd.endEnd,
      )
    }
    const allR = [...preRedirects, heredocRedirect, ...redirects]
    const rStart =
      preRedirects.length > 0
        ? Math.min(cmd.startIndex, preRedirects[0]!.startIndex)
        : cmd.startIndex
    return mk(P, 'redirected_statement', rStart, heredocRedirect.endIndex, [
      cmd,
      ...allR,
    ])
  }

  if (redirects.length > 0) {
    const last = redirects[redirects.length - 1]!
    return mk(P, 'redirected_statement', cmd.startIndex, last.endIndex, [
      cmd,
      ...redirects,
    ])
  }

  return cmd
}

export function maybeRedirect(
  P: ParseState,
  node: TsNode,
  allowHerestring = false,
): TsNode {
  const redirects: TsNode[] = []
  while (true) {
    skipBlanks(P.L)
    const save = saveLex(P.L)
    const r = tryParseRedirect(P)
    if (!r) break
    if (r.type === 'herestring_redirect' && !allowHerestring) {
      restoreLex(P.L, save)
      break
    }
    redirects.push(r)
  }
  if (redirects.length === 0) return node
  const last = redirects[redirects.length - 1]!
  return mk(P, 'redirected_statement', node.startIndex, last.endIndex, [
    node,
    ...redirects,
  ])
}

export function tryParseAssignment(P: ParseState): TsNode | null {
  const save = saveLex(P.L)
  skipBlanks(P.L)
  const startB = P.L.b
  // Must start with identifier
  if (!isIdentStart(peek(P.L))) {
    restoreLex(P.L, save)
    return null
  }
  while (isIdentChar(peek(P.L))) advance(P.L)
  const nameEnd = P.L.b
  // Optional subscript
  let subEnd = nameEnd
  if (peek(P.L) === '[') {
    advance(P.L)
    let depth = 1
    while (P.L.i < P.L.len && depth > 0) {
      const c = peek(P.L)
      if (c === '[') depth++
      else if (c === ']') depth--
      advance(P.L)
    }
    subEnd = P.L.b
  }
  const c = peek(P.L)
  const c1 = peek(P.L, 1)
  let op: string
  if (c === '=' && c1 !== '=') {
    op = '='
  } else if (c === '+' && c1 === '=') {
    op = '+='
  } else {
    restoreLex(P.L, save)
    return null
  }
  const nameNode = mk(P, 'variable_name', startB, nameEnd, [])
  // Subscript handling: wrap in subscript node if present
  let lhs: TsNode = nameNode
  if (subEnd > nameEnd) {
    const brOpen = mk(P, '[', nameEnd, nameEnd + 1, [])
    const idx = parseSubscriptIndex(P, nameEnd + 1, subEnd - 1)
    const brClose = mk(P, ']', subEnd - 1, subEnd, [])
    lhs = mk(P, 'subscript', startB, subEnd, [nameNode, brOpen, idx, brClose])
  }
  const opStart = P.L.b
  advance(P.L)
  if (op === '+=') advance(P.L)
  const opEnd = P.L.b
  const opNode = mk(P, op, opStart, opEnd, [])
  let val: TsNode | null = null
  if (peek(P.L) === '(') {
    // Array
    const aoTok = nextToken(P.L, 'cmd')
    const aOpen = leaf(P, '(', aoTok)
    const elems: TsNode[] = [aOpen]
    while (true) {
      skipBlanks(P.L)
      if (peek(P.L) === ')') break
      const e = parseWord(P, 'arg')
      if (!e) break
      elems.push(e)
    }
    const acTok = nextToken(P.L, 'cmd')
    const aClose =
      acTok.value === ')'
        ? leaf(P, ')', acTok)
        : mk(P, ')', aOpen.endIndex, aOpen.endIndex, [])
    elems.push(aClose)
    val = mk(P, 'array', aOpen.startIndex, aClose.endIndex, elems)
  } else {
    const c2 = peek(P.L)
    if (
      c2 &&
      c2 !== ' ' &&
      c2 !== '\t' &&
      c2 !== '\n' &&
      c2 !== ';' &&
      c2 !== '&' &&
      c2 !== '|' &&
      c2 !== ')' &&
      c2 !== '}'
    ) {
      val = parseWord(P, 'arg')
    }
  }
  const kids = val ? [lhs, opNode, val] : [lhs, opNode]
  const end = val ? val.endIndex : opEnd
  return mk(P, 'variable_assignment', startB, end, kids)
}

/**
 * Parse subscript index content. Parsed arithmetically per tree-sitter grammar:
 * `${a[1+2]}` → binary_expression; `${a[++i]}` → unary_expression(word);
 * `${a[(($n+1))]}` → compound_statement(binary_expression). Falls back to
 * simple patterns (@, *) as word.
 */
export function parseSubscriptIndexInline(P: ParseState): TsNode | null {
  skipBlanks(P.L)
  const c = peek(P.L)
  // @ or * alone → word (associative array all-keys)
  if ((c === '@' || c === '*') && peek(P.L, 1) === ']') {
    const s = P.L.b
    advance(P.L)
    return mk(P, 'word', s, P.L.b, [])
  }
  // ((expr)) → compound_statement wrapping the inner arithmetic
  if (c === '(' && peek(P.L, 1) === '(') {
    const oStart = P.L.b
    advance(P.L)
    advance(P.L)
    const open = mk(P, '((', oStart, P.L.b, [])
    const inner = parseArithExpr(P, '))', 'var')
    skipBlanks(P.L)
    let close: TsNode
    if (peek(P.L) === ')' && peek(P.L, 1) === ')') {
      const cs = P.L.b
      advance(P.L)
      advance(P.L)
      close = mk(P, '))', cs, P.L.b, [])
    } else {
      close = mk(P, '))', P.L.b, P.L.b, [])
    }
    const kids = inner ? [open, inner, close] : [open, close]
    return mk(P, 'compound_statement', open.startIndex, close.endIndex, kids)
  }
  // Arithmetic — but bare identifiers in subscript use 'word' mode per
  // tree-sitter (${words[++counter]} → unary_expression(word)).
  return parseArithExpr(P, ']', 'word')
}

/** Legacy byte-range subscript index parser — kept for callers that pre-scan. */
export function parseSubscriptIndex(
  P: ParseState,
  startB: number,
  endB: number,
): TsNode {
  const text = sliceBytes(P, startB, endB)
  if (/^\d+$/.test(text)) return mk(P, 'number', startB, endB, [])
  const m = /^\$([a-zA-Z_]\w*)$/.exec(text)
  if (m) {
    const dollar = mk(P, '$', startB, startB + 1, [])
    const vn = mk(P, 'variable_name', startB + 1, endB, [])
    return mk(P, 'simple_expansion', startB, endB, [dollar, vn])
  }
  if (text.length === 2 && text[0] === '$' && SPECIAL_VARS.has(text[1]!)) {
    const dollar = mk(P, '$', startB, startB + 1, [])
    const vn = mk(P, 'special_variable_name', startB + 1, endB, [])
    return mk(P, 'simple_expansion', startB, endB, [dollar, vn])
  }
  return mk(P, 'word', startB, endB, [])
}

/**
 * Can the current position start a redirect destination literal?
 * Returns false at redirect ops, terminators, or file-descriptor-prefixed ops
 * so file_redirect's repeat1($._literal) stops at the right boundary.
 */
export function isRedirectLiteralStart(P: ParseState): boolean {
  const c = peek(P.L)
  if (c === '' || c === '\n') return false
  // Shell terminators and operators
  if (c === '|' || c === '&' || c === ';' || c === '(' || c === ')')
    return false
  // Redirect operators (< > with any suffix; <( >( handled by caller)
  if (c === '<' || c === '>') {
    // <( >( are process substitutions — those ARE literals
    return peek(P.L, 1) === '('
  }
  // N< N> file descriptor prefix — starts a new redirect, not a literal
  if (isDigit(c)) {
    let j = P.L.i
    while (j < P.L.len && isDigit(P.L.src[j]!)) j++
    const after = j < P.L.len ? P.L.src[j]! : ''
    if (after === '>' || after === '<') return false
  }
  // `}` only terminates if we're in a context where it's a closer — but
  // file_redirect sees `}` as word char (e.g., `>$HOME}` is valid path char).
  // Actually `}` at top level terminates compound_statement — need to stop.
  if (c === '}') return false
  // Test command closer — when parseSimpleCommand is called from `[` context,
  // `]` must terminate so parseCommand can return and `[` handler consume it.
  if (P.stopToken === ']' && c === ']') return false
  return true
}

/**
 * Parse a redirect operator + destination(s).
 * @param greedy When true, file_redirect consumes repeat1($._literal) per
 *   grammar's prec.left — `cmd >f a b c` attaches `a b c` to the redirect.
 *   When false (preRedirect context), takes only 1 destination because
 *   command's dynamic precedence beats redirected_statement's prec(-1).
 */
export function tryParseRedirect(P: ParseState, greedy = false): TsNode | null {
  const save = saveLex(P.L)
  skipBlanks(P.L)
  // File descriptor prefix?
  let fd: TsNode | null = null
  if (isDigit(peek(P.L))) {
    const startB = P.L.b
    let j = P.L.i
    while (j < P.L.len && isDigit(P.L.src[j]!)) j++
    const after = j < P.L.len ? P.L.src[j]! : ''
    if (after === '>' || after === '<') {
      while (P.L.i < j) advance(P.L)
      fd = mk(P, 'file_descriptor', startB, P.L.b, [])
    }
  }
  const t = nextToken(P.L, 'arg')
  if (t.type !== 'OP') {
    restoreLex(P.L, save)
    return null
  }
  const v = t.value
  if (v === '<<<') {
    const op = leaf(P, '<<<', t)
    skipBlanks(P.L)
    const target = parseWord(P, 'arg')
    const end = target ? target.endIndex : op.endIndex
    const kids = target ? [op, target] : [op]
    return mk(
      P,
      'herestring_redirect',
      fd ? fd.startIndex : op.startIndex,
      end,
      fd ? [fd, ...kids] : kids,
    )
  }
  if (v === '<<' || v === '<<-') {
    const op = leaf(P, v, t)
    // Heredoc start — delimiter word (may be quoted)
    skipBlanks(P.L)
    const dStart = P.L.b
    let quoted = false
    let delim = ''
    const dc = peek(P.L)
    if (dc === "'" || dc === '"') {
      quoted = true
      advance(P.L)
      while (P.L.i < P.L.len && peek(P.L) !== dc) {
        delim += peek(P.L)
        advance(P.L)
      }
      if (P.L.i < P.L.len) advance(P.L)
    } else if (dc === '\\') {
      // Backslash-escaped delimiter: \X — exactly one escaped char, body is
      // quoted (literal). Covers <<\EOF <<\' <<\\ etc.
      quoted = true
      advance(P.L)
      if (P.L.i < P.L.len && peek(P.L) !== '\n') {
        delim += peek(P.L)
        advance(P.L)
      }
      // May be followed by more ident chars (e.g. <<\EOF → delim "EOF")
      while (P.L.i < P.L.len && isIdentChar(peek(P.L))) {
        delim += peek(P.L)
        advance(P.L)
      }
    } else {
      // Unquoted delimiter: bash accepts most non-metacharacters (not just
      // identifiers). Allow !, -, ., etc. — stop at shell metachars.
      while (P.L.i < P.L.len && isHeredocDelimChar(peek(P.L))) {
        delim += peek(P.L)
        advance(P.L)
      }
    }
    const dEnd = P.L.b
    const startNode = mk(P, 'heredoc_start', dStart, dEnd, [])
    // Register pending heredoc — body scanned at next newline
    P.L.heredocs.push({
      delim,
      stripTabs: v === '<<-',
      quoted,
      bodyStart: 0,
      bodyEnd: 0,
      endStart: 0,
      endEnd: 0,
    })
    const kids = fd ? [fd, op, startNode] : [op, startNode]
    const startIdx = fd ? fd.startIndex : op.startIndex
    // SECURITY: tree-sitter nests any pipeline/list/file_redirect appearing
    // between heredoc_start and the newline as a CHILD of heredoc_redirect.
    // `ls <<'EOF' | rm -rf /tmp/evil` must not silently drop the rm. Parse
    // trailing words and file_redirects properly (ast.ts walkHeredocRedirect
    // fails closed on any unrecognized child via tooComplex). Pipeline / list
    // operators (| && || ;) are structurally complex — emit ERROR so the same
    // fail-closed path rejects them.
    while (true) {
      skipBlanks(P.L)
      const tc = peek(P.L)
      if (tc === '\n' || tc === '' || P.L.i >= P.L.len) break
      // File redirect after delimiter: cat <<EOF > out.txt
      if (tc === '>' || tc === '<' || isDigit(tc)) {
        const rSave = saveLex(P.L)
        const r = tryParseRedirect(P)
        if (r && r.type === 'file_redirect') {
          kids.push(r)
          continue
        }
        restoreLex(P.L, rSave)
      }
      // Pipeline after heredoc_start: `one <<EOF | grep two` — tree-sitter
      // nests the pipeline as a child of heredoc_redirect. ast.ts
      // walkHeredocRedirect fails closed on pipeline/command via tooComplex.
      if (tc === '|' && peek(P.L, 1) !== '|') {
        advance(P.L)
        skipBlanks(P.L)
        const pipeCmds: TsNode[] = []
        while (true) {
          const cmd = parseCommand(P)
          if (!cmd) break
          pipeCmds.push(cmd)
          skipBlanks(P.L)
          if (peek(P.L) === '|' && peek(P.L, 1) !== '|') {
            const ps = P.L.b
            advance(P.L)
            pipeCmds.push(mk(P, '|', ps, P.L.b, []))
            skipBlanks(P.L)
            continue
          }
          break
        }
        if (pipeCmds.length > 0) {
          const pl = pipeCmds[pipeCmds.length - 1]!
          // tree-sitter always wraps in pipeline after `|`, even single command
          kids.push(
            mk(P, 'pipeline', pipeCmds[0]!.startIndex, pl.endIndex, pipeCmds),
          )
        }
        continue
      }
      // && / || after heredoc_start: `cat <<-EOF || die "..."` — tree-sitter
      // nests just the RHS command (not a list) as a child of heredoc_redirect.
      if (
        (tc === '&' && peek(P.L, 1) === '&') ||
        (tc === '|' && peek(P.L, 1) === '|')
      ) {
        advance(P.L)
        advance(P.L)
        skipBlanks(P.L)
        const rhs = parseCommand(P)
        if (rhs) kids.push(rhs)
        continue
      }
      // Terminator / unhandled metachar — consume rest of line as ERROR so
      // ast.ts rejects it. Covers ; & ( )
      if (tc === '&' || tc === ';' || tc === '(' || tc === ')') {
        const eStart = P.L.b
        while (P.L.i < P.L.len && peek(P.L) !== '\n') advance(P.L)
        kids.push(mk(P, 'ERROR', eStart, P.L.b, []))
        break
      }
      // Trailing word argument: newins <<-EOF - org.freedesktop.service
      const w = parseWord(P, 'arg')
      if (w) {
        kids.push(w)
        continue
      }
      // Unrecognized — consume rest of line as ERROR
      const eStart = P.L.b
      while (P.L.i < P.L.len && peek(P.L) !== '\n') advance(P.L)
      if (P.L.b > eStart) kids.push(mk(P, 'ERROR', eStart, P.L.b, []))
      break
    }
    return mk(P, 'heredoc_redirect', startIdx, P.L.b, kids)
  }
  // Close-fd variants: `<&-` `>&-` have OPTIONAL destination (0 or 1)
  if (v === '<&-' || v === '>&-') {
    const op = leaf(P, v, t)
    const kids: TsNode[] = []
    if (fd) kids.push(fd)
    kids.push(op)
    // Optional single destination — only consume if next is a literal
    skipBlanks(P.L)
    const dSave = saveLex(P.L)
    const dest = isRedirectLiteralStart(P) ? parseWord(P, 'arg') : null
    if (dest) {
      kids.push(dest)
    } else {
      restoreLex(P.L, dSave)
    }
    const startIdx = fd ? fd.startIndex : op.startIndex
    const end = dest ? dest.endIndex : op.endIndex
    return mk(P, 'file_redirect', startIdx, end, kids)
  }
  if (
    v === '>' ||
    v === '>>' ||
    v === '>&' ||
    v === '>|' ||
    v === '&>' ||
    v === '&>>' ||
    v === '<' ||
    v === '<&'
  ) {
    const op = leaf(P, v, t)
    const kids: TsNode[] = []
    if (fd) kids.push(fd)
    kids.push(op)
    // Grammar: destination is repeat1($._literal) — greedily consume literals
    // until a non-literal (redirect op, terminator, etc). tree-sitter's
    // prec.left makes `cmd >f a b c` attach `a b c` to the file_redirect,
    // NOT to the command. Structural quirk but required for corpus parity.
    // In preRedirect context (greedy=false), take only 1 literal because
    // command's dynamic precedence beats redirected_statement's prec(-1).
    let end = op.endIndex
    let taken = 0
    while (true) {
      skipBlanks(P.L)
      if (!isRedirectLiteralStart(P)) break
      if (!greedy && taken >= 1) break
      const tc = peek(P.L)
      const tc1 = peek(P.L, 1)
      let target: TsNode | null = null
      if ((tc === '<' || tc === '>') && tc1 === '(') {
        target = parseProcessSub(P)
      } else {
        target = parseWord(P, 'arg')
      }
      if (!target) break
      kids.push(target)
      end = target.endIndex
      taken++
    }
    const startIdx = fd ? fd.startIndex : op.startIndex
    return mk(P, 'file_redirect', startIdx, end, kids)
  }
  restoreLex(P.L, save)
  return null
}

export function parseProcessSub(P: ParseState): TsNode | null {
  const c = peek(P.L)
  if ((c !== '<' && c !== '>') || peek(P.L, 1) !== '(') return null
  const start = P.L.b
  advance(P.L)
  advance(P.L)
  const open = mk(P, c + '(', start, P.L.b, [])
  const body = parseStatements(P, ')')
  skipBlanks(P.L)
  let close: TsNode
  if (peek(P.L) === ')') {
    const cs = P.L.b
    advance(P.L)
    close = mk(P, ')', cs, P.L.b, [])
  } else {
    close = mk(P, ')', P.L.b, P.L.b, [])
  }
  return mk(P, 'process_substitution', start, close.endIndex, [
    open,
    ...body,
    close,
  ])
}

export function scanHeredocBodies(P: ParseState): void {
  // Skip to newline if not already there
  while (P.L.i < P.L.len && P.L.src[P.L.i] !== '\n') advance(P.L)
  if (P.L.i < P.L.len) advance(P.L)
  for (const hd of P.L.heredocs) {
    hd.bodyStart = P.L.b
    const delimLen = hd.delim.length
    while (P.L.i < P.L.len) {
      const lineStart = P.L.i
      const lineStartB = P.L.b
      // Skip leading tabs if <<-
      let checkI = lineStart
      if (hd.stripTabs) {
        while (checkI < P.L.len && P.L.src[checkI] === '\t') checkI++
      }
      // Check if this line is the delimiter
      if (
        P.L.src.startsWith(hd.delim, checkI) &&
        (checkI + delimLen >= P.L.len ||
          P.L.src[checkI + delimLen] === '\n' ||
          P.L.src[checkI + delimLen] === '\r')
      ) {
        hd.bodyEnd = lineStartB
        // Advance past tabs
        while (P.L.i < checkI) advance(P.L)
        hd.endStart = P.L.b
        // Advance past delimiter
        for (let k = 0; k < delimLen; k++) advance(P.L)
        hd.endEnd = P.L.b
        // Skip trailing newline
        if (P.L.i < P.L.len && P.L.src[P.L.i] === '\n') advance(P.L)
        return
      }
      // Consume line
      while (P.L.i < P.L.len && P.L.src[P.L.i] !== '\n') advance(P.L)
      if (P.L.i < P.L.len) advance(P.L)
    }
    // Unterminated
    hd.bodyEnd = P.L.b
    hd.endStart = P.L.b
    hd.endEnd = P.L.b
  }
}

export function parseHeredocBodyContent(
  P: ParseState,
  start: number,
  end: number,
): TsNode[] {
  // Parse expansions inside an unquoted heredoc body.
  const saved = saveLex(P.L)
  // Position lexer at body start
  restoreLexToByte(P, start)
  const out: TsNode[] = []
  let contentStart = P.L.b
  // tree-sitter-bash's heredoc_body rule hides the initial text segment
  // (_heredoc_body_beginning) — only content AFTER the first expansion is
  // emitted as heredoc_content. Track whether we've seen an expansion yet.
  let sawExpansion = false
  while (P.L.b < end) {
    const c = peek(P.L)
    // Backslash escapes suppress expansion: \$ \` stay literal in heredoc.
    if (c === '\\') {
      const nxt = peek(P.L, 1)
      if (nxt === '$' || nxt === '`' || nxt === '\\') {
        advance(P.L)
        advance(P.L)
        continue
      }
      advance(P.L)
      continue
    }
    if (c === '$' || c === '`') {
      const preB = P.L.b
      const exp = parseDollarLike(P)
      // Bare `$` followed by non-name (e.g. `$'` in a regex) returns a lone
      // '$' leaf, not an expansion — treat as literal content, don't split.
      if (
        exp &&
        (exp.type === 'simple_expansion' ||
          exp.type === 'expansion' ||
          exp.type === 'command_substitution' ||
          exp.type === 'arithmetic_expansion')
      ) {
        if (sawExpansion && preB > contentStart) {
          out.push(mk(P, 'heredoc_content', contentStart, preB, []))
        }
        out.push(exp)
        contentStart = P.L.b
        sawExpansion = true
      }
      continue
    }
    advance(P.L)
  }
  // Only emit heredoc_content children if there were expansions — otherwise
  // the heredoc_body is a leaf node (tree-sitter convention).
  if (sawExpansion) {
    out.push(mk(P, 'heredoc_content', contentStart, end, []))
  }
  restoreLex(P.L, saved)
  return out
}

export function restoreLexToByte(P: ParseState, targetByte: number): void {
  if (!P.L.byteTable) byteAt(P.L, 0)
  const t = P.L.byteTable!
  let lo = 0
  let hi = P.src.length
  while (lo < hi) {
    const m = (lo + hi) >>> 1
    if (t[m]! < targetByte) lo = m + 1
    else hi = m
  }
  P.L.i = lo
  P.L.b = targetByte
}

// ─────────── Compound commands & declarations ───────────

export function parseIf(P: ParseState, ifTok: Token): TsNode {
  const ifKw = leaf(P, 'if', ifTok)
  const kids: TsNode[] = [ifKw]
  const cond = parseStatements(P, null)
  kids.push(...cond)
  consumeKeyword(P, 'then', kids)
  const body = parseStatements(P, null)
  kids.push(...body)
  while (true) {
    const save = saveLex(P.L)
    const t = nextToken(P.L, 'cmd')
    if (t.type === 'WORD' && t.value === 'elif') {
      const eKw = leaf(P, 'elif', t)
      const eCond = parseStatements(P, null)
      const eKids: TsNode[] = [eKw, ...eCond]
      consumeKeyword(P, 'then', eKids)
      const eBody = parseStatements(P, null)
      eKids.push(...eBody)
      const last = eKids[eKids.length - 1]!
      kids.push(mk(P, 'elif_clause', eKw.startIndex, last.endIndex, eKids))
    } else if (t.type === 'WORD' && t.value === 'else') {
      const elKw = leaf(P, 'else', t)
      const elBody = parseStatements(P, null)
      const last = elBody.length > 0 ? elBody[elBody.length - 1]! : elKw
      kids.push(
        mk(P, 'else_clause', elKw.startIndex, last.endIndex, [elKw, ...elBody]),
      )
    } else {
      restoreLex(P.L, save)
      break
    }
  }
  consumeKeyword(P, 'fi', kids)
  const last = kids[kids.length - 1]!
  return mk(P, 'if_statement', ifKw.startIndex, last.endIndex, kids)
}

export function parseWhile(P: ParseState, kwTok: Token): TsNode {
  const kw = leaf(P, kwTok.value, kwTok)
  const kids: TsNode[] = [kw]
  const cond = parseStatements(P, null)
  kids.push(...cond)
  const dg = parseDoGroup(P)
  if (dg) kids.push(dg)
  const last = kids[kids.length - 1]!
  return mk(P, 'while_statement', kw.startIndex, last.endIndex, kids)
}

export function parseFor(P: ParseState, forTok: Token): TsNode {
  const forKw = leaf(P, forTok.value, forTok)
  skipBlanks(P.L)
  // C-style for (( ; ; )) — only for `for`, not `select`
  if (forTok.value === 'for' && peek(P.L) === '(' && peek(P.L, 1) === '(') {
    const oStart = P.L.b
    advance(P.L)
    advance(P.L)
    const open = mk(P, '((', oStart, P.L.b, [])
    const kids: TsNode[] = [forKw, open]
    // init; cond; update — all three use 'assign' mode so `c = expr` emits
    // variable_assignment, while bare idents (c in `c<=5`) → word. Each
    // clause may be a comma-separated list.
    for (let k = 0; k < 3; k++) {
      skipBlanks(P.L)
      const es = parseArithCommaList(P, k < 2 ? ';' : '))', 'assign')
      kids.push(...es)
      if (k < 2) {
        if (peek(P.L) === ';') {
          const s = P.L.b
          advance(P.L)
          kids.push(mk(P, ';', s, P.L.b, []))
        }
      }
    }
    skipBlanks(P.L)
    if (peek(P.L) === ')' && peek(P.L, 1) === ')') {
      const cStart = P.L.b
      advance(P.L)
      advance(P.L)
      kids.push(mk(P, '))', cStart, P.L.b, []))
    }
    // Optional ; or newline
    const save = saveLex(P.L)
    const sep = nextToken(P.L, 'cmd')
    if (sep.type === 'OP' && sep.value === ';') {
      kids.push(leaf(P, ';', sep))
    } else if (sep.type !== 'NEWLINE') {
      restoreLex(P.L, save)
    }
    const dg = parseDoGroup(P)
    if (dg) {
      kids.push(dg)
    } else {
      // C-style for can also use `{ ... }` body instead of `do ... done`
      skipNewlines(P)
      skipBlanks(P.L)
      if (peek(P.L) === '{') {
        const bOpen = P.L.b
        advance(P.L)
        const brace = mk(P, '{', bOpen, P.L.b, [])
        const body = parseStatements(P, '}')
        let bClose: TsNode
        if (peek(P.L) === '}') {
          const cs = P.L.b
          advance(P.L)
          bClose = mk(P, '}', cs, P.L.b, [])
        } else {
          bClose = mk(P, '}', P.L.b, P.L.b, [])
        }
        kids.push(
          mk(P, 'compound_statement', brace.startIndex, bClose.endIndex, [
            brace,
            ...body,
            bClose,
          ]),
        )
      }
    }
    const last = kids[kids.length - 1]!
    return mk(P, 'c_style_for_statement', forKw.startIndex, last.endIndex, kids)
  }
  // Regular for VAR in words; do ... done
  const kids: TsNode[] = [forKw]
  const varTok = nextToken(P.L, 'arg')
  kids.push(mk(P, 'variable_name', varTok.start, varTok.end, []))
  skipBlanks(P.L)
  const save = saveLex(P.L)
  const inTok = nextToken(P.L, 'arg')
  if (inTok.type === 'WORD' && inTok.value === 'in') {
    kids.push(leaf(P, 'in', inTok))
    while (true) {
      skipBlanks(P.L)
      const c = peek(P.L)
      if (c === ';' || c === '\n' || c === '') break
      const w = parseWord(P, 'arg')
      if (!w) break
      kids.push(w)
    }
  } else {
    restoreLex(P.L, save)
  }
  // Separator
  const save2 = saveLex(P.L)
  const sep = nextToken(P.L, 'cmd')
  if (sep.type === 'OP' && sep.value === ';') {
    kids.push(leaf(P, ';', sep))
  } else if (sep.type !== 'NEWLINE') {
    restoreLex(P.L, save2)
  }
  const dg = parseDoGroup(P)
  if (dg) kids.push(dg)
  const last = kids[kids.length - 1]!
  return mk(P, 'for_statement', forKw.startIndex, last.endIndex, kids)
}

export function parseDoGroup(P: ParseState): TsNode | null {
  skipNewlines(P)
  const save = saveLex(P.L)
  const doTok = nextToken(P.L, 'cmd')
  if (doTok.type !== 'WORD' || doTok.value !== 'do') {
    restoreLex(P.L, save)
    return null
  }
  const doKw = leaf(P, 'do', doTok)
  const body = parseStatements(P, null)
  const kids: TsNode[] = [doKw, ...body]
  consumeKeyword(P, 'done', kids)
  const last = kids[kids.length - 1]!
  return mk(P, 'do_group', doKw.startIndex, last.endIndex, kids)
}

export function parseCase(P: ParseState, caseTok: Token): TsNode {
  const caseKw = leaf(P, 'case', caseTok)
  const kids: TsNode[] = [caseKw]
  skipBlanks(P.L)
  const word = parseWord(P, 'arg')
  if (word) kids.push(word)
  skipBlanks(P.L)
  consumeKeyword(P, 'in', kids)
  skipNewlines(P)
  while (true) {
    skipBlanks(P.L)
    skipNewlines(P)
    const save = saveLex(P.L)
    const t = nextToken(P.L, 'arg')
    if (t.type === 'WORD' && t.value === 'esac') {
      kids.push(leaf(P, 'esac', t))
      break
    }
    if (t.type === 'EOF') break
    restoreLex(P.L, save)
    const item = parseCaseItem(P)
    if (!item) break
    kids.push(item)
  }
  const last = kids[kids.length - 1]!
  return mk(P, 'case_statement', caseKw.startIndex, last.endIndex, kids)
}

export function parseCaseItem(P: ParseState): TsNode | null {
  skipBlanks(P.L)
  const start = P.L.b
  const kids: TsNode[] = []
  // Optional leading '(' before pattern — bash allows (pattern) syntax
  if (peek(P.L) === '(') {
    const s = P.L.b
    advance(P.L)
    kids.push(mk(P, '(', s, P.L.b, []))
  }
  // Pattern(s)
  let isFirstAlt = true
  while (true) {
    skipBlanks(P.L)
    const c = peek(P.L)
    if (c === ')' || c === '') break
    const pats = parseCasePattern(P)
    if (pats.length === 0) break
    // tree-sitter quirk: first alternative with quotes is inlined as flat
    // siblings; subsequent alternatives are wrapped in (concatenation) with
    // `word` instead of `extglob_pattern` for bare segments.
    if (!isFirstAlt && pats.length > 1) {
      const rewritten = pats.map(p =>
        p.type === 'extglob_pattern'
          ? mk(P, 'word', p.startIndex, p.endIndex, [])
          : p,
      )
      const first = rewritten[0]!
      const last = rewritten[rewritten.length - 1]!
      kids.push(
        mk(P, 'concatenation', first.startIndex, last.endIndex, rewritten),
      )
    } else {
      kids.push(...pats)
    }
    isFirstAlt = false
    skipBlanks(P.L)
    // \<newline> line continuation between alternatives
    if (peek(P.L) === '\\' && peek(P.L, 1) === '\n') {
      advance(P.L)
      advance(P.L)
      skipBlanks(P.L)
    }
    if (peek(P.L) === '|') {
      const s = P.L.b
      advance(P.L)
      kids.push(mk(P, '|', s, P.L.b, []))
      // \<newline> after | is also a line continuation
      if (peek(P.L) === '\\' && peek(P.L, 1) === '\n') {
        advance(P.L)
        advance(P.L)
      }
    } else {
      break
    }
  }
  if (peek(P.L) === ')') {
    const s = P.L.b
    advance(P.L)
    kids.push(mk(P, ')', s, P.L.b, []))
  }
  const body = parseStatements(P, null)
  kids.push(...body)
  const save = saveLex(P.L)
  const term = nextToken(P.L, 'cmd')
  if (
    term.type === 'OP' &&
    (term.value === ';;' || term.value === ';&' || term.value === ';;&')
  ) {
    kids.push(leaf(P, term.value, term))
  } else {
    restoreLex(P.L, save)
  }
  if (kids.length === 0) return null
  // tree-sitter quirk: case_item with EMPTY body and a single pattern matching
  // extglob-operator-char-prefix (no actual glob metachars) downgrades to word.
  // `-o) owner=$2 ;;` (has body) → extglob_pattern; `-g) ;;` (empty) → word.
  if (body.length === 0) {
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]!
      if (k.type !== 'extglob_pattern') continue
      const text = sliceBytes(P, k.startIndex, k.endIndex)
      if (/^[-+?*@!][a-zA-Z]/.test(text) && !/[*?(]/.test(text)) {
        kids[i] = mk(P, 'word', k.startIndex, k.endIndex, [])
      }
    }
  }
  const last = kids[kids.length - 1]!
  return mk(P, 'case_item', start, last.endIndex, kids)
}

export function parseCasePattern(P: ParseState): TsNode[] {
  skipBlanks(P.L)
  const save = saveLex(P.L)
  const start = P.L.b
  const startI = P.L.i
  let parenDepth = 0
  let hasDollar = false
  let hasBracketOutsideParen = false
  let hasQuote = false
  while (P.L.i < P.L.len) {
    const c = peek(P.L)
    if (c === '\\' && P.L.i + 1 < P.L.len) {
      // Escaped char — consume both (handles `bar\ baz` as single pattern)
      // \<newline> is a line continuation; eat it but stay in pattern.
      advance(P.L)
      advance(P.L)
      continue
    }
    if (c === '"' || c === "'") {
      hasQuote = true
      // Skip past the quoted segment so its content (spaces, |, etc.) doesn't
      // break the peek-ahead scan.
      advance(P.L)
      while (P.L.i < P.L.len && peek(P.L) !== c) {
        if (peek(P.L) === '\\' && P.L.i + 1 < P.L.len) advance(P.L)
        advance(P.L)
      }
      if (peek(P.L) === c) advance(P.L)
      continue
    }
    // Paren counting: any ( inside pattern opens a scope; don't break at ) or |
    // until balanced. Handles extglob *(a|b) and nested shapes *([0-9])([0-9]).
    if (c === '(') {
      parenDepth++
      advance(P.L)
      continue
    }
    if (parenDepth > 0) {
      if (c === ')') {
        parenDepth--
        advance(P.L)
        continue
      }
      if (c === '\n') break
      advance(P.L)
      continue
    }
    if (c === ')' || c === '|' || c === ' ' || c === '\t' || c === '\n') break
    if (c === '$') hasDollar = true
    if (c === '[') hasBracketOutsideParen = true
    advance(P.L)
  }
  if (P.L.b === start) return []
  const text = P.src.slice(startI, P.L.i)
  const hasExtglobParen = /[*?+@!]\(/.test(text)
  // Quoted segments in pattern: tree-sitter splits at quote boundaries into
  // multiple sibling nodes. `*"foo"*` → (extglob_pattern)(string)(extglob_pattern).
  // Re-scan with a segmenting pass.
  if (hasQuote && !hasExtglobParen) {
    restoreLex(P.L, save)
    return parseCasePatternSegmented(P)
  }
  // tree-sitter splits patterns with [ or $ into concatenation via word parsing
  // UNLESS pattern has extglob parens (those override and emit extglob_pattern).
  // `*.[1357]` → concat(word word number word); `${PN}.pot` → concat(expansion word);
  // but `*([0-9])` → extglob_pattern (has extglob paren).
  if (!hasExtglobParen && (hasDollar || hasBracketOutsideParen)) {
    restoreLex(P.L, save)
    const w = parseWord(P, 'arg')
    return w ? [w] : []
  }
  // Patterns starting with extglob operator chars (+ - ? * @ !) followed by
  // identifier chars are extglob_pattern per tree-sitter, even without parens
  // or glob metachars. `-o)` → extglob_pattern; plain `foo)` → word.
  const type =
    hasExtglobParen || /[*?]/.test(text) || /^[-+?*@!][a-zA-Z]/.test(text)
      ? 'extglob_pattern'
      : 'word'
  return [mk(P, type, start, P.L.b, [])]
}

// Segmented scan for case patterns containing quotes: `*"foo"*` →
// [extglob_pattern, string, extglob_pattern]. Bare segments → extglob_pattern
// if they have */?, else word. Stops at ) | space tab newline outside quotes.
export function parseCasePatternSegmented(P: ParseState): TsNode[] {
  const parts: TsNode[] = []
  let segStart = P.L.b
  let segStartI = P.L.i
  const flushSeg = (): void => {
    if (P.L.i > segStartI) {
      const t = P.src.slice(segStartI, P.L.i)
      const type = /[*?]/.test(t) ? 'extglob_pattern' : 'word'
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
    if (c === ')' || c === '|' || c === ' ' || c === '\t' || c === '\n') break
    advance(P.L)
  }
  flushSeg()
  return parts
}

export function parseFunction(P: ParseState, fnTok: Token): TsNode {
  const fnKw = leaf(P, 'function', fnTok)
  skipBlanks(P.L)
  const nameTok = nextToken(P.L, 'arg')
  const name = mk(P, 'word', nameTok.start, nameTok.end, [])
  const kids: TsNode[] = [fnKw, name]
  skipBlanks(P.L)
  if (peek(P.L) === '(' && peek(P.L, 1) === ')') {
    const o = nextToken(P.L, 'cmd')
    const c = nextToken(P.L, 'cmd')
    kids.push(leaf(P, '(', o))
    kids.push(leaf(P, ')', c))
  }
  skipBlanks(P.L)
  skipNewlines(P)
  const body = parseCommand(P)
  if (body) {
    // Hoist redirects from redirected_statement(compound_statement, ...) to
    // function_definition level per tree-sitter grammar
    if (
      body.type === 'redirected_statement' &&
      body.children.length >= 2 &&
      body.children[0]!.type === 'compound_statement'
    ) {
      kids.push(...body.children)
    } else {
      kids.push(body)
    }
  }
  const last = kids[kids.length - 1]!
  return mk(P, 'function_definition', fnKw.startIndex, last.endIndex, kids)
}

export function parseDeclaration(P: ParseState, kwTok: Token): TsNode {
  const kw = leaf(P, kwTok.value, kwTok)
  const kids: TsNode[] = [kw]
  while (true) {
    skipBlanks(P.L)
    const c = peek(P.L)
    if (
      c === '' ||
      c === '\n' ||
      c === ';' ||
      c === '&' ||
      c === '|' ||
      c === ')' ||
      c === '<' ||
      c === '>'
    ) {
      break
    }
    const a = tryParseAssignment(P)
    if (a) {
      kids.push(a)
      continue
    }
    // Quoted string or concatenation: `export "FOO=bar"`, `export 'X'`
    if (c === '"' || c === "'" || c === '$') {
      const w = parseWord(P, 'arg')
      if (w) {
        kids.push(w)
        continue
      }
      break
    }
    // Flag like -a or bare variable name
    const save = saveLex(P.L)
    const tok = nextToken(P.L, 'arg')
    if (tok.type === 'WORD' || tok.type === 'NUMBER') {
      if (tok.value.startsWith('-')) {
        kids.push(leaf(P, 'word', tok))
      } else if (isIdentStart(tok.value[0] ?? '')) {
        kids.push(mk(P, 'variable_name', tok.start, tok.end, []))
      } else {
        kids.push(leaf(P, 'word', tok))
      }
    } else {
      restoreLex(P.L, save)
      break
    }
  }
  const last = kids[kids.length - 1]!
  return mk(P, 'declaration_command', kw.startIndex, last.endIndex, kids)
}

export function parseUnset(P: ParseState, kwTok: Token): TsNode {
  const kw = leaf(P, 'unset', kwTok)
  const kids: TsNode[] = [kw]
  while (true) {
    skipBlanks(P.L)
    const c = peek(P.L)
    if (
      c === '' ||
      c === '\n' ||
      c === ';' ||
      c === '&' ||
      c === '|' ||
      c === ')' ||
      c === '<' ||
      c === '>'
    ) {
      break
    }
    // SECURITY: use parseWord (not raw nextToken) so quoted strings like
    // `unset 'a[$(id)]'` emit a raw_string child that ast.ts can reject.
    // Previously `break` silently dropped non-WORD args — hiding the
    // arithmetic-subscript code-exec vector from the security walker.
    const arg = parseWord(P, 'arg')
    if (!arg) break
    if (arg.type === 'word') {
      if (arg.text.startsWith('-')) {
        kids.push(arg)
      } else {
        kids.push(mk(P, 'variable_name', arg.startIndex, arg.endIndex, []))
      }
    } else {
      kids.push(arg)
    }
  }
  const last = kids[kids.length - 1]!
  return mk(P, 'unset_command', kw.startIndex, last.endIndex, kids)
}

export function consumeKeyword(P: ParseState, name: string, kids: TsNode[]): void {
  skipNewlines(P)
  const save = saveLex(P.L)
  const t = nextToken(P.L, 'cmd')
  if (t.type === 'WORD' && t.value === name) {
    kids.push(leaf(P, name, t))
  } else {
    restoreLex(P.L, save)
  }
}

