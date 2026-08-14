/**
 * Pure-TypeScript bash parser producing tree-sitter-bash-compatible ASTs.
 *
 * Downstream code in parser.ts, ast.ts, prefix.ts, ParsedCommand.ts walks this
 * by field name. startIndex/endIndex are UTF-8 BYTE offsets (not JS string
 * indices).
 *
 * Grammar reference: tree-sitter-bash. Validated against a 3449-input golden
 * corpus generated from the WASM parser.
 *
 * This file is the public façade. Real work lives in `bashParser/`:
 *   - tokens.ts          — TokenType, Token, keyword sets
 *   - lexer.ts           — Lexer state, nextToken, char-class predicates
 *   - parserContext.ts   — TsNode, ParseState, mk/leaf/sliceBytes/checkBudget
 *   - expressions.ts     — [[...]] tests + ((...)) arithmetic
 *   - words.ts           — bare words, quoting, dollar expansions, backticks
 *   - commands.ts        — statements, pipelines, compound commands, redirects
 */

import {
  makeLexer,
  nextToken,
  restoreLex,
  saveLex,
  skipBlanks,
} from './bashParser/lexer.js'
import {
  byteLengthUtf8,
  leaf,
  mk,
  PARSE_TIMEOUT_MS,
  type ParseState,
  type TsNode,
} from './bashParser/parserContext.js'
import { parseStatements } from './bashParser/commands.js'

export type { TsNode }
export { SHELL_KEYWORDS } from './bashParser/tokens.js'

type ParserModule = {
  parse: (source: string, timeoutMs?: number) => TsNode | null
}

const MODULE: ParserModule = { parse: parseSource }

const READY = Promise.resolve()

/** No-op: pure-TS parser needs no async init. Kept for API compatibility. */
export function ensureParserInitialized(): Promise<void> {
  return READY
}

/** Always succeeds — pure-TS needs no init. */
export function getParserModule(): ParserModule | null {
  return MODULE
}

function parseSource(source: string, timeoutMs?: number): TsNode | null {
  const L = makeLexer(source)
  const srcBytes = byteLengthUtf8(source)
  const P: ParseState = {
    L,
    src: source,
    srcBytes,
    isAscii: srcBytes === source.length,
    nodeCount: 0,
    deadline: performance.now() + (timeoutMs ?? PARSE_TIMEOUT_MS),
    aborted: false,
    inBacktick: 0,
    stopToken: null,
  }
  try {
    const program = parseProgram(P)
    if (P.aborted) return null
    return program
  } catch {
    return null
  }
}

function parseProgram(P: ParseState): TsNode {
  const children: TsNode[] = []
  // Skip leading whitespace & newlines — program start is first content byte
  skipBlanks(P.L)
  while (true) {
    const save = saveLex(P.L)
    const t = nextToken(P.L, 'cmd')
    if (t.type === 'NEWLINE') {
      skipBlanks(P.L)
      continue
    }
    restoreLex(P.L, save)
    break
  }
  const progStart = P.L.b
  while (P.L.i < P.L.len) {
    const save = saveLex(P.L)
    const t = nextToken(P.L, 'cmd')
    if (t.type === 'EOF') break
    if (t.type === 'NEWLINE') continue
    if (t.type === 'COMMENT') {
      children.push(leaf(P, 'comment', t))
      continue
    }
    restoreLex(P.L, save)
    const stmts = parseStatements(P, null)
    for (const s of stmts) children.push(s)
    if (stmts.length === 0) {
      // Couldn't parse — emit ERROR and skip one token
      const errTok = nextToken(P.L, 'cmd')
      if (errTok.type === 'EOF') break
      // Stray `;;` at program level (e.g., `var=;;` outside case) — tree-sitter
      // silently elides. Keep leading `;` as ERROR (security: paste artifact).
      if (
        errTok.type === 'OP' &&
        errTok.value === ';;' &&
        children.length > 0
      ) {
        continue
      }
      children.push(mk(P, 'ERROR', errTok.start, errTok.end, []))
    }
  }
  // tree-sitter includes trailing whitespace in program extent
  const progEnd = children.length > 0 ? P.srcBytes : progStart
  return mk(P, 'program', progStart, progEnd, children)
}
