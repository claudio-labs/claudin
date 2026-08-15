/**
 * Token types + shell keyword sets used by the bash lexer/parser.
 *
 * Pure data: no functions, no state. Imported by `lexer.ts` and the parser
 * façade. Kept separate so the parser can reason about keyword identity
 * (`if`, `function`, …) without pulling in lexer mechanics.
 */

export type TokenType =
  | 'WORD'
  | 'NUMBER'
  | 'OP'
  | 'NEWLINE'
  | 'COMMENT'
  | 'DQUOTE'
  | 'SQUOTE'
  | 'ANSI_C'
  | 'DOLLAR'
  | 'DOLLAR_PAREN'
  | 'DOLLAR_BRACE'
  | 'DOLLAR_DPAREN'
  | 'BACKTICK'
  | 'LT_PAREN'
  | 'GT_PAREN'
  | 'EOF'

export type Token = {
  type: TokenType
  value: string
  /** UTF-8 byte offset of first char */
  start: number
  /** UTF-8 byte offset one past last char */
  end: number
}

export const SPECIAL_VARS = new Set(['?', '$', '@', '*', '#', '-', '!', '_'])

export const DECL_KEYWORDS = new Set([
  'export',
  'declare',
  'typeset',
  'readonly',
  'local',
])

export const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'while',
  'until',
  'for',
  'in',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'select',
])
