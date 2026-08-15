// The symbol table shape produced by the outline scanners.
//
// Kept dependency-free on purpose: `src/shared/fs/detectCodeLang.ts` imports
// `OutlineLang` from here as a type, and a leaf module keeps that free.

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'method'
  | 'const'
  | 'struct'
  | 'record'
  | 'object'
  | 'trait'
  | 'impl'
  | 'module'
  | 'heading'
  // SQL object kinds.
  | 'table'
  | 'view'
  | 'trigger'
  // CSS/SCSS selectors + at-rules.
  | 'selector'
  // HTML headings / landmark / id'd elements.
  | 'element'
  // Config/markup keys (YAML, .properties, .env, TOML, Dockerfile).
  | 'key'

export type OutlineLang =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'java'
  | 'kotlin'
  | 'csharp'
  | 'rust'
  | 'markdown'
  // C-like batch (reuse CLIKE_SPECS): C/C++, PHP, Swift, Scala, Bash.
  | 'c'
  | 'php'
  | 'swift'
  | 'scala'
  | 'bash'
  | 'dart'
  | 'groovy'
  // end-block scanner.
  | 'ruby'
  | 'lua'
  // mask-only: string/comment analysis with no symbol scanner, so sites are
  // exact but carry no enclosing symbol.
  | 'elixir'
  | 'powershell'
  // dedicated scanners.
  | 'sql'
  | 'css'
  | 'html'
  // config / markup / build dedicated scanners.
  | 'yaml'
  | 'xml'
  | 'properties'
  | 'env'
  | 'toml'
  | 'dockerfile'
  | 'makefile'
  // C-like batch (adds GraphQL and Terraform/HCL to CLIKE_SPECS).
  | 'graphql'
  | 'terraform'

export type SymbolEntry = {
  name: string
  kind: SymbolKind
  /** Declaration line, trimmed, body stripped. */
  signature: string
  /** 1-indexed, inclusive. */
  startLine: number
  /** 1-indexed, inclusive. */
  endLine: number
  /** 0 = top-level. */
  depth: number
  /** 1-indexed first line of the doc comment / decorator block, if any. */
  docLine?: number
}
