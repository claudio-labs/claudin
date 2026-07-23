// ---------------------------------------------------------------------------
// scanSymbols — dependency-free structural symbol scanner
// ---------------------------------------------------------------------------
//
// Produces a flat, ordered table of the top-level symbols in a source file
// (plus class methods) without an AST. It powers the Smart Code Navigation
// "outline" and "unfold" views: outline renders every signature, unfold
// slices one symbol's body — both off the SAME table, so their boundaries
// always agree.
//
// Three strategies, selected per language:
//   C-like:   brace-depth counting on a string/comment-masked copy. Each
//             language is a CLikeSpec (mask + detect + filter rules), so
//             adding one never touches another's path. TS/JS/Go keep their
//             original behavior bit-for-bit (legacy raw-line detection);
//             Java/Kotlin/C#/Rust detect on the masked line. C# `namespace`
//             and Rust `mod` are depth-transparent: members inside them
//             still gate as top-level.
//   Python:   indentation tracking on a masked copy.
//   Markdown: ATX headings with fenced-code-block tracking.
//
// Fail-open: any internal error, an unbalanced source, or zero symbols all
// yield []. Callers treat [] as "degrade to a normal Read".
// ---------------------------------------------------------------------------

/**
 * Reports a scan failure without making this module depend on the logger at
 * import time. `logError` transitively pulls in the provider/analytics chain;
 * the scan-failure path is rare, so a deferred fire-and-forget import keeps
 * scanSymbols a dependency-light leaf usable from scripts and benches.
 */
function logScanError(e: unknown): void {
  void import('src/utils/log.js')
    .then(m => m.logError(e))
    .catch(() => {})
}

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
  // end-block scanner.
  | 'ruby'
  | 'lua'
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

const EXT_TO_LANG: Record<string, OutlineLang> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  rs: 'rust',
  md: 'markdown',
  markdown: 'markdown',
  // C / C++ — a single 'c' language covers both dialects.
  c: 'c',
  h: 'c',
  cpp: 'c',
  hpp: 'c',
  cc: 'c',
  cxx: 'c',
  hh: 'c',
  php: 'php',
  swift: 'swift',
  scala: 'scala',
  rb: 'ruby',
  lua: 'lua',
  sh: 'bash',
  bash: 'bash',
  sql: 'sql',
  css: 'css',
  scss: 'css',
  html: 'html',
  htm: 'html',
 // Config / markup / build — extensions + extensionless filenames.
 yaml: 'yaml',
 yml: 'yaml',
 xml: 'xml',
 properties: 'properties',
 env: 'env',
 ini: 'properties',
 toml: 'toml',
 graphql: 'graphql',
 gql: 'graphql',
 mk: 'makefile',
 tf: 'terraform',
 hcl: 'terraform',
 // Extensionless filenames (detected via basename prefix).
 dockerfile: 'dockerfile',
 containerfile: 'dockerfile',
 makefile: 'makefile',
}
/** Basename prefixes for extensionless files (Dockerfile, Makefile, …).
 * Kept separate from EXT_TO_LANG so the path fallback in detectOutlineLangFromPath
 * only matches true extensionless basenames, not extension keys like `env` or
 * `properties` (which would mis-route `env.log` / `properties.txt` to config
 * scanners). */
const EXTENSIONLESS_BASENAME_TO_LANG: Record<string, OutlineLang> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
}

/** Maps a file extension (with or without leading dot) to an outline language. */
export function detectOutlineLang(ext: string): OutlineLang | null {
  return EXT_TO_LANG[ext.toLowerCase().replace(/^\./, '')] ?? null
}

/**
 * Path-aware variant: tries the extension first, then the basename prefix
 * (handles extensionless files like `Dockerfile`, `Makefile`, `Dockerfile.dev`).
 */
export function detectOutlineLangFromPath(filePath: string): OutlineLang | null {
  const lower = filePath.toLowerCase()
  // Try extension first.
  const dotIdx = lower.lastIndexOf('.')
 if (dotIdx >= 0) {
   const ext = lower.slice(dotIdx + 1)
   if (EXT_TO_LANG[ext]) return EXT_TO_LANG[ext]
 }
 // Try basename prefix for extensionless files.
 const slashIdx = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'))
 const base = lower.slice(slashIdx + 1)
 const firstDot = base.indexOf('.')
 const prefix = firstDot >= 0 ? base.slice(0, firstDot) : base
if (EXTENSIONLESS_BASENAME_TO_LANG[prefix]) return EXTENSIONLESS_BASENAME_TO_LANG[prefix]
 return null
}

const MAX_SIGNATURE_CHARS = 160

// Declaration regexes — module level (recompiling per call is banned, see
// .claudin/rules/typescript-patterns.md). Tested on the trimmed line.
const RE_CLASS =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/
const RE_FUNCTION =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/
const RE_INTERFACE = /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/
const RE_TYPE = /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/
const RE_ENUM =
  /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/
const RE_CONST =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/
const RE_METHOD =
  /^(?:(?:public|private|protected|static|readonly|abstract|async|override|get|set)\s+)*\*?\s*(\#?[A-Za-z_$][\w$]*)\s*[(<]/
const RE_METHOD_ARROW =
  /^(?:(?:public|private|protected|static|readonly)\s+)*([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/

const RE_GO_FUNC =
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/
const RE_GO_TYPE = /^type\s+([A-Za-z_][\w]*)/

const RE_PY_DEF = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/
const RE_PY_CLASS = /^class\s+([A-Za-z_]\w*)/

// --- Java / Kotlin / C# / Rust declaration regexes -------------------------

/** Leading `@Annotation` / `@Annotation(args)` tokens (Java/Kotlin). */
const RE_LEADING_ANNOTATIONS = /^(?:@[\w.]+(?:\([^)]*\))?\s*)+/
/** Leading `[Attribute]` tokens (C#). */
const RE_LEADING_CS_ATTRS = /^(?:\[[^\]]*\]\s*)+/

const RE_JAVA_TYPE =
  /^(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp)\s+)*(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/
const JAVA_TYPE_KIND: Record<string, SymbolKind> = {
  class: 'class',
  interface: 'interface',
  enum: 'enum',
  record: 'record',
}

/** First identifier directly before a `(` — method-name heuristic. */
const RE_IDENT_BEFORE_PAREN = /([A-Za-z_$][\w$]*)\s*\(/
/** Last word of the text before the matched name (rejects `return foo(`). */
const RE_PREFIX_LAST_WORD = /([A-Za-z_$][\w$]*)\s*$/
/** A method declaration's prefix (modifiers + return type) never contains these. */
const RE_PREFIX_DISALLOWED = /[={};()]/

// Words that introduce a statement/expression, never a method declaration.
const JAVA_CS_CONTROL_KEYWORDS = new Set([
  'if',
  'for',
  'foreach',
  'while',
  'switch',
  'catch',
  'try',
  'synchronized',
  'lock',
  'using',
  'fixed',
  'return',
  'throw',
  'throws',
  'new',
  'super',
  'this',
  'base',
  'assert',
  'yield',
  'await',
  'case',
  'else',
  'do',
  'goto',
  'when',
  'typeof',
  'nameof',
  'sizeof',
  'checked',
  'unchecked',
  // As the prefix's last word this rejects C# conversion operators
  // (`implicit operator int(...)`), whose "method name" is the target type.
  'operator',
])

const KT_MODIFIERS =
  '(?:public|private|protected|internal|open|abstract|final|sealed|data|inner|annotation|enum|value|expect|actual|external|inline|noinline|crossinline|operator|infix|suspend|tailrec|override|const|lateinit|companion)'
const RE_KT_TYPE = new RegExp(
  `^(?:${KT_MODIFIERS}\\s+)*(class|interface|object)\\s+([A-Za-z_]\\w*)`,
)
const RE_KT_COMPANION = new RegExp(
  `^(?:${KT_MODIFIERS}\\s+)*companion\\s+object\\b(?:\\s+([A-Za-z_]\\w*))?`,
)
const RE_KT_FUN = new RegExp(
  `^(?:${KT_MODIFIERS}\\s+)*fun\\s*(?:<[^>]*>\\s*)?(?:[\\w.<>?,\\s]*?\\.)?([A-Za-z_]\\w*)\\s*\\(`,
)
const RE_KT_TYPEALIAS = new RegExp(
  `^(?:${KT_MODIFIERS}\\s+)*typealias\\s+([A-Za-z_]\\w*)`,
)
const RE_KT_VAL = new RegExp(
  `^(?:${KT_MODIFIERS}\\s+)*(?:val|var)\\s+([A-Za-z_]\\w*)`,
)
const KT_TYPE_KIND: Record<string, SymbolKind> = {
  class: 'class',
  interface: 'interface',
  object: 'object',
}

const CS_MODIFIERS =
  '(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|ref|new|unsafe|file|required|virtual|override|extern|async)'
const RE_CS_NAMESPACE = /^namespace\s+([\w.]+)/
const RE_CS_TYPE = new RegExp(
  `^(?:${CS_MODIFIERS}\\s+)*(class|interface|enum|struct|record)(?:\\s+(?:class|struct))?\\s+([A-Za-z_]\\w*)`,
)
const CS_TYPE_KIND: Record<string, SymbolKind> = {
  class: 'class',
  interface: 'interface',
  enum: 'enum',
  struct: 'struct',
  record: 'record',
}
/** Expression-bodied member (`int X() => ...;`) — legitimate without braces. */
const RE_CS_EXPR_BODY = /=>/

const RUST_VIS = '(?:pub(?:\\([^)]*\\))?\\s+)?'
const RE_RUST_FN = new RegExp(
  `^${RUST_VIS}(?:default\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+"[^"]*"\\s+)?fn\\s+([A-Za-z_]\\w*)`,
)
const RE_RUST_STRUCT = new RegExp(`^${RUST_VIS}struct\\s+([A-Za-z_]\\w*)`)
const RE_RUST_ENUM = new RegExp(`^${RUST_VIS}enum\\s+([A-Za-z_]\\w*)`)
const RE_RUST_TRAIT = new RegExp(
  `^${RUST_VIS}(?:unsafe\\s+)?(?:auto\\s+)?trait\\s+([A-Za-z_]\\w*)`,
)
const RE_RUST_TYPE = new RegExp(`^${RUST_VIS}type\\s+([A-Za-z_]\\w*)`)
const RE_RUST_CONST = new RegExp(
  `^${RUST_VIS}(?:const|static)\\s+(?:mut\\s+)?([A-Za-z_]\\w*)\\s*:`,
)
const RE_RUST_MOD = new RegExp(`^${RUST_VIS}mod\\s+([A-Za-z_]\\w*)`)
const RE_RUST_IMPL = /^(?:unsafe\s+)?impl(?:\s*<[^>]*>)?\s+([^{]+?)\s*(?:\{.*)?$/
const RE_RUST_MACRO = /^macro_rules!\s*([A-Za-z_]\w*)/
const RE_RUST_WHERE_TAIL = /\bwhere\b.*$/
const RE_GENERIC_TAIL = /<.*$/

// --- C / C++ ---------------------------------------------------------------
const RE_C_DEFINE = /^#\s*define\s+([A-Za-z_]\w*)/
const RE_C_TYPE =
  /^(?:typedef\s+)?(struct|union|enum|class)\b(?:\s+([A-Za-z_]\w*))?/
const C_TYPE_KIND: Record<string, SymbolKind> = {
  struct: 'struct',
  union: 'struct',
  enum: 'enum',
  class: 'class',
}
/** One-line `typedef ... Alias;` — the alias is the last identifier before `;`.
 * Greedy `.*` backtracks to the final `ident;` so `typedef struct { int x; } Foo;`
 * captures `Foo`, not the field `x`. */
const RE_C_TYPEDEF_ALIAS = /^typedef\b.*\b([A-Za-z_]\w*)\s*;/
const RE_C_TYPEDEF_PREFIX = /^typedef\b/

// --- PHP --------------------------------------------------------------------
const PHP_MODIFIERS =
  '(?:public|private|protected|static|final|abstract|readonly)'
const RE_PHP_FUNCTION = new RegExp(
  `^(?:${PHP_MODIFIERS}\\s+)*function\\s+&?\\s*([A-Za-z_]\\w*)\\s*\\(`,
)
const RE_PHP_TYPE = new RegExp(
  `^(?:${PHP_MODIFIERS}\\s+)*(class|interface|trait|enum)\\s+([A-Za-z_]\\w*)`,
)
const PHP_TYPE_KIND: Record<string, SymbolKind> = {
  class: 'class',
  interface: 'interface',
  trait: 'trait',
  enum: 'enum',
}

// --- Swift ------------------------------------------------------------------
const SWIFT_MODIFIERS =
  '(?:public|private|internal|fileprivate|open|final|static|class|override|mutating|nonmutating|convenience|required|dynamic|lazy|weak|unowned|indirect)'
const RE_SWIFT_FUNC = new RegExp(
  `^(?:${SWIFT_MODIFIERS}\\s+)*func\\s+([A-Za-z_]\\w*)`,
)
const RE_SWIFT_TYPE = new RegExp(
  `^(?:${SWIFT_MODIFIERS}\\s+)*(class|struct|enum|protocol|extension)\\s+([A-Za-z_]\\w*)`,
)
const SWIFT_TYPE_KIND: Record<string, SymbolKind> = {
  class: 'class',
  struct: 'struct',
  enum: 'enum',
  protocol: 'interface',
  // Swift extensions add methods to a type — treat like a Rust impl block.
  extension: 'impl',
}

// --- Scala ------------------------------------------------------------------
const SCALA_MODIFIERS =
  '(?:private|protected|final|sealed|abstract|implicit|override|lazy|case)'
const RE_SCALA_DEF = new RegExp(
  `^(?:${SCALA_MODIFIERS}\\s+)*def\\s+([A-Za-z_]\\w*)`,
)
const RE_SCALA_TYPE = new RegExp(
  `^(?:${SCALA_MODIFIERS}\\s+)*(class|trait|object)\\s+([A-Za-z_]\\w*)`,
)
const SCALA_TYPE_KIND: Record<string, SymbolKind> = {
  class: 'class',
  trait: 'trait',
  object: 'object',
}
const RE_SCALA_VAL = new RegExp(
  `^(?:${SCALA_MODIFIERS}\\s+)*(?:val|var)\\s+([A-Za-z_]\\w*)`,
)

// --- Bash -------------------------------------------------------------------
const RE_BASH_FUNC_KEYWORD = /^function\s+([A-Za-z_][\w-]*)\s*(?:\(\s*\))?/
const RE_BASH_FUNC_PAREN = /^([A-Za-z_][\w-]*)\s*\(\s*\)/

/** Scans a source file and returns its ordered symbol table. */
export function scanSymbols(source: string, lang: OutlineLang): SymbolEntry[] {
  try {
    if (!source) return []
    if (lang === 'python') return scanPython(source)
    if (lang === 'markdown') return scanMarkdown(source)
    if (lang === 'ruby') return scanRuby(source)
    if (lang === 'lua') return scanLua(source)
    if (lang === 'sql') return scanSql(source)
    if (lang === 'css') return scanCss(source)
    if (lang === 'html') return scanHtml(source)
    if (lang === 'yaml') return scanYaml(source)
    if (lang === 'xml') return scanXml(source)
    if (lang === 'properties' || lang === 'env') return scanConfig(source)
    if (lang === 'toml') return scanToml(source)
    if (lang === 'dockerfile') return scanDockerfile(source)
    if (lang === 'makefile') return scanMakefile(source)
    return scanCLike(source, CLIKE_SPECS[lang])
  } catch (e) {
    logScanError(e)
    return []
  }
}

// ---------------------------------------------------------------------------
// Masking — replace string / comment content with spaces, preserving newlines
// and line lengths so depth/indentation math on the copy is reliable.
// ---------------------------------------------------------------------------

// Single-char tokens after which a `/` opens a regex literal (operator
// position). Notably excludes:
//   `}` — treated as division (the safer common case).
//   `<` and `>` — these collide with JSX (`</Tag>`, `<Tag>/`); treating `</`
//     as a regex would wreck every .tsx file. The cost is that `a < /re/` and
//     `() => /re/` go unmasked — both rare, and fail-open covers the fallout.
const REGEX_PREV_PUNCT = new Set([
  '(',
  '[',
  '{',
  ',',
  ';',
  '=',
  ':',
  '!',
  '?',
  '&',
  '|',
  '^',
  '~',
  '+',
  '-',
  '*',
  '%',
])

// Keywords after which a `/` opens a regex literal.
const REGEX_PREV_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'yield',
  'await',
  'case',
  'do',
  'else',
])

const RE_IDENT_CHAR = /[A-Za-z0-9_$]/
/** Valid first character of a heredoc/nowdoc label (never a digit). */
const RE_IDENT_START = /[A-Za-z_]/
/** Uppercase-or-underscore start — Ruby heredoc-label convention. */
const RE_UPPER_START = /[A-Z_]/
/** Word character excluding `$` (SQL dollar-quote tag). */
const RE_WORD_CHAR = /[A-Za-z0-9_]/

/** Decides whether a `/` at `slashIdx` begins a regex literal vs division. */
function regexAllowedAfter(
  prev: string | null,
  src: string,
  slashIdx: number,
): boolean {
  if (prev === null) return true
  if (REGEX_PREV_PUNCT.has(prev)) return true
  if (/[A-Za-z_$]/.test(prev)) {
    let j = slashIdx - 1
    while (j >= 0 && /\s/.test(src[j]!)) j--
    let end = j
    while (j >= 0 && RE_IDENT_CHAR.test(src[j]!)) j--
    return REGEX_PREV_KEYWORDS.has(src.slice(j + 1, end + 1))
  }
  return false
}

type CLikeMaskOptions = {
  /** JS regex-literal heuristic. On for TS/JS (and Go, legacy behavior). */
  regexLiterals: boolean
  /**
   * `"""` blocks masked as raw text (Java text blocks, Kotlin raw strings,
   * C# raw strings). No escape processing: Kotlin treats `\` literally; a
   * Java text block containing an escaped `\"""` closes early here, which
   * fail-open covers.
   */
  tripleQuotes: boolean
  /** C# verbatim strings — `@"..."` / `$@"..."` with doubled-quote escapes. */
  verbatimStrings: boolean
}

const MASK_OPTS_LEGACY: CLikeMaskOptions = {
  regexLiterals: true,
  tripleQuotes: false,
  verbatimStrings: false,
}
const MASK_OPTS_JVM: CLikeMaskOptions = {
  regexLiterals: false,
  tripleQuotes: true,
  verbatimStrings: false,
}
const MASK_OPTS_CSHARP: CLikeMaskOptions = {
  regexLiterals: false,
  tripleQuotes: true,
  verbatimStrings: true,
}
// Plain brace languages with only `//` + `/* */` comments and simple
// single/double-quoted strings — C/C++, Scala, Swift (all use maskJvm's
// triple-quote handling where relevant; C uses the plain variant).
const MASK_OPTS_PLAIN: CLikeMaskOptions = {
  regexLiterals: false,
  tripleQuotes: false,
  verbatimStrings: false,
}

function maskCLike(source: string, opts: CLikeMaskOptions): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  // Last significant (non-whitespace, non-comment) code char seen — drives
  // the regex-vs-division decision.
  let prevCode: string | null = null
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  while (i < n) {
    const c = source[i]
    const c2 = source[i + 1]
    if (c === '/' && c2 === '/') {
      while (i < n && source[i] !== '\n') blank(i++)
      continue
    }
    if (c === '/' && c2 === '*') {
      blank(i++)
      blank(i++)
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) blank(i++)
      if (i < n) {
        blank(i++)
        blank(i++)
      }
      continue
    }
    if (
      opts.tripleQuotes &&
      c === '"' &&
      c2 === '"' &&
      source[i + 2] === '"'
    ) {
      blank(i++)
      blank(i++)
      blank(i++)
      while (
        i < n &&
        !(
          source[i] === '"' &&
          source[i + 1] === '"' &&
          source[i + 2] === '"'
        )
      ) {
        blank(i++)
      }
      if (i < n) {
        blank(i++)
        blank(i++)
        blank(i++)
      }
      prevCode = '"'
      continue
    }
    if (
      opts.verbatimStrings &&
      ((c === '@' && c2 === '"') ||
        (c === '@' && c2 === '$' && source[i + 2] === '"') ||
        (c === '$' && c2 === '@' && source[i + 2] === '"'))
    ) {
      while (i < n && source[i] !== '"') blank(i++)
      blank(i++) // opening quote
      while (i < n) {
        if (source[i] === '"') {
          if (source[i + 1] === '"') {
            blank(i++)
            blank(i++)
            continue
          }
          blank(i++)
          break
        }
        blank(i++)
      }
      prevCode = '"'
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      blank(i++)
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') {
          blank(i++)
          if (i < n) blank(i++)
          continue
        }
        blank(i++)
      }
      if (i < n) blank(i++)
      // A string/template is a value — a following `/` is division.
      prevCode = '"'
      continue
    }
    if (c === '/' && opts.regexLiterals && regexAllowedAfter(prevCode, source, i)) {
      // Regex literal: blank through the closing unescaped `/` (a `/` inside
      // a [...] char class does not close it), then its flags.
      blank(i++)
      let inClass = false
      let closed = false
      while (i < n) {
        const ch = source[i]
        if (ch === '\n') break // unterminated — bail
        if (ch === '\\') {
          blank(i++)
          if (i < n) blank(i++)
          continue
        }
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
        else if (ch === '/' && !inClass) {
          blank(i++)
          closed = true
          break
        }
        blank(i++)
      }
      if (closed) {
        while (i < n && /[a-z]/i.test(source[i]!)) blank(i++)
      }
      prevCode = '/'
      continue
    }
    if (!/\s/.test(c!)) prevCode = c!
    i++
  }
  return out.join('')
}

function maskPython(source: string): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  while (i < n) {
    const c = source[i]
    if (c === '#') {
      while (i < n && source[i] !== '\n') blank(i++)
      continue
    }
    if (c === '"' || c === "'") {
      const triple = source[i + 1] === c && source[i + 2] === c
      const quote = c
      if (triple) {
        blank(i++)
        blank(i++)
        blank(i++)
        while (
          i < n &&
          !(
            source[i] === quote &&
            source[i + 1] === quote &&
            source[i + 2] === quote
          )
        ) {
          if (source[i] === '\\') {
            blank(i++)
            if (i < n) blank(i++)
            continue
          }
          blank(i++)
        }
        if (i < n) {
          blank(i++)
          blank(i++)
          blank(i++)
        }
      } else {
        blank(i++)
        while (i < n && source[i] !== quote && source[i] !== '\n') {
          if (source[i] === '\\') {
            blank(i++)
            if (i < n) blank(i++)
            continue
          }
          blank(i++)
        }
        if (i < n && source[i] === quote) blank(i++)
      }
      continue
    }
    i++
  }
  return out.join('')
}

/**
 * Rust-aware masking. Differs from maskCLike in three ways: block comments
 * nest, raw strings (`r"..."`, `r#"..."#`, `br#"..."#`) close on the matching
 * hash count with no escapes, and a lone `'` is a lifetime (`'a`) — only a
 * real char literal (`'x'`, `'\n'`) is masked. Multi-code-unit char literals
 * (`'🦀'`) fall through the lifetime path; fail-open covers that edge.
 */
function maskRust(source: string): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  const identChar = (k: number) => k >= 0 && RE_IDENT_CHAR.test(source[k]!)
  while (i < n) {
    const c = source[i]
    const c2 = source[i + 1]
    if (c === '/' && c2 === '/') {
      while (i < n && source[i] !== '\n') blank(i++)
      continue
    }
    if (c === '/' && c2 === '*') {
      let depth = 1
      blank(i++)
      blank(i++)
      while (i < n && depth > 0) {
        if (source[i] === '/' && source[i + 1] === '*') {
          depth++
          blank(i++)
          blank(i++)
        } else if (source[i] === '*' && source[i + 1] === '/') {
          depth--
          blank(i++)
          blank(i++)
        } else {
          blank(i++)
        }
      }
      continue
    }
    // Raw (byte) strings — only when r/br starts a token, not ends an ident.
    const rawStart =
      !identChar(i - 1) &&
      ((c === 'r' && (c2 === '"' || c2 === '#')) ||
        (c === 'b' && c2 === 'r' && (source[i + 2] === '"' || source[i + 2] === '#')))
    if (rawStart) {
      let j = i + (c === 'b' ? 2 : 1)
      let hashes = 0
      while (j < n && source[j] === '#') {
        hashes++
        j++
      }
      if (source[j] === '"') {
        while (i <= j) blank(i++) // prefix, hashes, opening quote
        const closer = '"' + '#'.repeat(hashes)
        while (i < n && !source.startsWith(closer, i)) blank(i++)
        for (let k = 0; k < closer.length && i < n; k++) blank(i++)
        continue
      }
      // `r#ident` raw identifier — not a string; fall through.
    }
    if (c === '"') {
      blank(i++)
      while (i < n && source[i] !== '"') {
        if (source[i] === '\\') {
          blank(i++)
          if (i < n) blank(i++)
          continue
        }
        blank(i++)
      }
      if (i < n) blank(i++)
      continue
    }
    if (c === "'") {
      if (c2 === '\\') {
        // Escaped char literal — blank through the closing quote (bounded:
        // the longest form is '\u{10FFFF}').
        blank(i++)
        let steps = 0
        while (i < n && source[i] !== "'" && steps < 12) {
          blank(i++)
          steps++
        }
        if (i < n && source[i] === "'") blank(i++)
        continue
      }
      if (c2 !== undefined && source[i + 2] === "'") {
        blank(i++)
        blank(i++)
        blank(i++)
        continue
      }
      // Lifetime or loop label — real code, leave it visible.
      i++
      continue
    }
    i++
  }
  return out.join('')
}

/**
 * PHP masking. Handles `//` and `#` line comments (but keeps `#[` attribute
 * markers visible), `/* *​/` block comments, single/double strings, and
 * heredoc/nowdoc (`<<<EOT … EOT;`, `<<<'EOT'`, `<<<"EOT"`). Best-effort:
 * a malformed heredoc degrades to fail-open at the scanner level.
 */
function maskPhp(source: string): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  while (i < n) {
    const c = source[i]
    const c2 = source[i + 1]
    if (c === '/' && c2 === '/') {
      while (i < n && source[i] !== '\n') blank(i++)
      continue
    }
    // `#` line comment — but `#[` opens a PHP 8 attribute, which we keep.
    if (c === '#' && c2 !== '[') {
      while (i < n && source[i] !== '\n') blank(i++)
      continue
    }
    if (c === '/' && c2 === '*') {
      blank(i++)
      blank(i++)
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) blank(i++)
      if (i < n) {
        blank(i++)
        blank(i++)
      }
      continue
    }
    if (c === '<' && c2 === '<' && source[i + 2] === '<') {
      let j = i + 3
      while (j < n && source[j] === ' ') j++
      let quote = ''
      if (source[j] === '"' || source[j] === "'") {
        quote = source[j]!
        j++
      }
      let id = ''
      if (j < n && RE_IDENT_START.test(source[j]!)) {
        while (j < n && RE_IDENT_CHAR.test(source[j]!)) {
          id += source[j]
          j++
        }
      }
      if (id) {
        if (quote && source[j] === quote) j++
        while (i < j) blank(i++)
        while (i < n && source[i] !== '\n') blank(i++)
        if (i < n) i++ // keep the newline
        while (i < n) {
          const lineStart = i
          let k = i
          while (k < n && source[k] !== '\n') k++
          let p = lineStart
          while (p < k && (source[p] === ' ' || source[p] === '\t')) p++
          const closes =
            source.startsWith(id, p) &&
            !RE_IDENT_CHAR.test(source[p + id.length] ?? '')
          for (let q = lineStart; q < k; q++) blank(q)
          i = k
          if (closes) break
          if (i < n) i++
        }
        continue
      }
    }
    if (c === '"' || c === "'") {
      const quote = c
      blank(i++)
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') {
          blank(i++)
          if (i < n) blank(i++)
          continue
        }
        blank(i++)
      }
      if (i < n) blank(i++)
      continue
    }
    i++
  }
  return out.join('')
}

/**
 * Bash masking. Handles `#` comments (only when `#` starts a word, so
 * `${#arr}` / `$#` survive), single/double strings, and heredocs
 * (`<<WORD`, `<<-WORD`, `<<'WORD'`). Only `{`/`}` matter to the scanner;
 * `${…}` stays balanced and `if/fi`, `case/esac` contribute no braces.
 */
function maskBash(source: string): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  const commentBoundary = (prev: string) =>
    prev === '\n' ||
    prev === ' ' ||
    prev === '\t' ||
    prev === ';' ||
    prev === '&' ||
    prev === '|' ||
    prev === '('
  while (i < n) {
    const c = source[i]
    const c2 = source[i + 1]
    if (c === '#' && commentBoundary(i > 0 ? source[i - 1]! : '\n')) {
      while (i < n && source[i] !== '\n') blank(i++)
      continue
    }
    // Heredoc — `<<WORD` / `<<-WORD` / `<<"WORD"` / `<<'WORD'`. Excludes the
    // `<<<` here-string and the `<< N` bit-shift (label must start alpha/_).
    if (c === '<' && c2 === '<' && source[i + 2] !== '<') {
      let j = i + 2
      if (source[j] === '-') j++
      while (j < n && source[j] === ' ') j++
      let quote = ''
      if (source[j] === '"' || source[j] === "'") {
        quote = source[j]!
        j++
      }
      let id = ''
      if (j < n && RE_IDENT_START.test(source[j]!)) {
        while (j < n && RE_IDENT_CHAR.test(source[j]!)) {
          id += source[j]
          j++
        }
      }
      if (id) {
        if (quote && source[j] === quote) j++
        // Blank from `<<` to end of the opening line.
        while (i < n && source[i] !== '\n') blank(i++)
        if (i < n) i++
        while (i < n) {
          const lineStart = i
          let k = i
          while (k < n && source[k] !== '\n') k++
          let p = lineStart
          while (p < k && (source[p] === ' ' || source[p] === '\t')) p++
          const closes =
            source.startsWith(id, p) &&
            !RE_IDENT_CHAR.test(source[p + id.length] ?? '')
          for (let q = lineStart; q < k; q++) blank(q)
          i = k
          if (closes) break
          if (i < n) i++
        }
        continue
      }
    }
    if (c === "'") {
      blank(i++)
      while (i < n && source[i] !== "'") blank(i++)
      if (i < n) blank(i++)
      continue
    }
    if (c === '"') {
      blank(i++)
      while (i < n && source[i] !== '"') {
        if (source[i] === '\\') {
          blank(i++)
          if (i < n) blank(i++)
          continue
        }
        blank(i++)
      }
      if (i < n) blank(i++)
      continue
    }
    i++
  }
  return out.join('')
}

// ---------------------------------------------------------------------------
// C-like scanner — generic brace-depth engine, parameterized per language
// ---------------------------------------------------------------------------

type CLikeDetection = {
  name: string
  /** Method-ness is derived from kind === 'method' — no separate flag. */
  kind: SymbolKind
  /**
   * Drop the candidate when no brace body opens. True for heuristic method
   * detection (filters TS property / Java field false matches); false for
   * keyword-led detections (Kotlin `fun`, Rust `fn`) where bodyless
   * declarations — expression bodies, trait methods — are legitimate.
   */
  requiresBody: boolean
}

type CLikeSpec = {
  mask: (source: string) => string
  /**
   * 'raw' preserves the legacy TS/JS/Go behavior of matching on the raw
   * source line; 'masked' (new languages) means commented-out code never
   * becomes a symbol.
   */
  detectSource: 'raw' | 'masked'
  detect: (trimmed: string, depth: number) => CLikeDetection | null
  /** Symbol kinds whose members are kept as methods. */
  methodContainers: ReadonlySet<SymbolKind>
  /** Kinds transparent for depth gating (C# namespace, Rust mod). */
  namespaceKinds: ReadonlySet<SymbolKind>
  /** Extra line prefixes (besides comments) that count as doc lines. */
  docPrefixes: readonly string[]
  /**
   * Require a kept method to sit exactly one brace level inside its
   * container — filters anonymous-class members (Java/C#) and object
   * expressions (Kotlin). Off for TS/JS to preserve legacy output.
   */
  strictMethodDepth: boolean
}

type Candidate = {
  line: number // 0-indexed
  depth: number
  name: string
  kind: SymbolKind
  requiresBody: boolean
}

function trimSignature(raw: string): string {
  let s = raw.trim()
  const brace = s.indexOf('{')
  if (brace >= 0) s = s.slice(0, brace).trim()
  if (s.length > MAX_SIGNATURE_CHARS) {
    s = s.slice(0, MAX_SIGNATURE_CHARS).trimEnd() + '…'
  }
  return s
}

function detectTsJs(trimmed: string, depth: number): CLikeDetection | null {
  // Only top-level declarations belong in an outline. A function, class,
  // type, etc. nested inside another body is noise; class methods are
  // handled separately below via the depth >= 1 branch.
  let m: RegExpExecArray | null
  if (depth === 0) {
    m = RE_CLASS.exec(trimmed)
    if (m) return { name: m[1]!, kind: 'class', requiresBody: false }
    m = RE_FUNCTION.exec(trimmed)
    if (m) return { name: m[1]!, kind: 'function', requiresBody: false }
    m = RE_INTERFACE.exec(trimmed)
    if (m) return { name: m[1]!, kind: 'interface', requiresBody: false }
    m = RE_ENUM.exec(trimmed)
    if (m) return { name: m[1]!, kind: 'enum', requiresBody: false }
    m = RE_TYPE.exec(trimmed)
    if (m) return { name: m[1]!, kind: 'type', requiresBody: false }
    m = RE_CONST.exec(trimmed)
    if (m) return { name: m[1]!, kind: 'const', requiresBody: false }
  }

  // Methods are only meaningful one level inside a container.
  if (depth >= 1) {
    m = RE_METHOD.exec(trimmed)
    if (m && !isControlKeyword(m[1]!)) {
      return { name: m[1]!, kind: 'method', requiresBody: true }
    }
    m = RE_METHOD_ARROW.exec(trimmed)
    if (m) return { name: m[1]!, kind: 'method', requiresBody: true }
  }
  return null
}

function detectGo(trimmed: string): CLikeDetection | null {
  let m = RE_GO_FUNC.exec(trimmed)
  if (m) return { name: m[1]!, kind: 'function', requiresBody: false }
  m = RE_GO_TYPE.exec(trimmed)
  if (m) {
    const kind: SymbolKind = /\bstruct\b/.test(trimmed) ? 'struct' : 'type'
    return { name: m[1]!, kind, requiresBody: false }
  }
  return null
}

/**
 * Shared Java/C# method-name heuristic: the first identifier directly before
 * a `(`, provided everything before it looks like modifiers + a return type.
 */
function detectJavaCsMethod(t: string): CLikeDetection | null {
  const m = RE_IDENT_BEFORE_PAREN.exec(t)
  if (!m || JAVA_CS_CONTROL_KEYWORDS.has(m[1]!)) return null
  const prefix = t.slice(0, m.index)
  if (RE_PREFIX_DISALLOWED.test(prefix)) return null
  const lastWord = RE_PREFIX_LAST_WORD.exec(prefix)?.[1]
  if (lastWord !== undefined && JAVA_CS_CONTROL_KEYWORDS.has(lastWord)) {
    return null
  }
  return { name: m[1]!, kind: 'method', requiresBody: true }
}

function detectJava(trimmed: string, depth: number): CLikeDetection | null {
  const t = trimmed.replace(RE_LEADING_ANNOTATIONS, '')
  // depth <= 1 admits nested types (static inner classes, Builder pattern).
  if (depth <= 1) {
    const m = RE_JAVA_TYPE.exec(t)
    if (m) {
      return { name: m[2]!, kind: JAVA_TYPE_KIND[m[1]!]!, requiresBody: false }
    }
  }
  if (depth >= 1) return detectJavaCsMethod(t)
  return null
}

function detectKotlin(trimmed: string, depth: number): CLikeDetection | null {
  const t = trimmed.replace(RE_LEADING_ANNOTATIONS, '')
  let m: RegExpExecArray | null
  if (depth <= 1) {
    m = RE_KT_TYPE.exec(t)
    if (m) {
      return { name: m[2]!, kind: KT_TYPE_KIND[m[1]!]!, requiresBody: false }
    }
    m = RE_KT_COMPANION.exec(t)
    if (m) {
      return { name: m[1] ?? 'companion', kind: 'object', requiresBody: false }
    }
  }
  m = RE_KT_FUN.exec(t)
  if (m) {
    // Expression-bodied functions (`fun f() = x`) have no braces — keep them.
    return depth === 0
      ? { name: m[1]!, kind: 'function', requiresBody: false }
      : { name: m[1]!, kind: 'method', requiresBody: false }
  }
  if (depth === 0) {
    m = RE_KT_TYPEALIAS.exec(t)
    if (m) return { name: m[1]!, kind: 'type', requiresBody: false }
    m = RE_KT_VAL.exec(t)
    if (m) return { name: m[1]!, kind: 'const', requiresBody: false }
  }
  return null
}

function detectCSharp(trimmed: string, depth: number): CLikeDetection | null {
  const t = trimmed.replace(RE_LEADING_CS_ATTRS, '')
  let m: RegExpExecArray | null
  if (depth === 0) {
    m = RE_CS_NAMESPACE.exec(t)
    if (m) return { name: m[1]!, kind: 'module', requiresBody: false }
  }
  if (depth <= 1) {
    m = RE_CS_TYPE.exec(t)
    if (m) {
      return { name: m[2]!, kind: CS_TYPE_KIND[m[1]!]!, requiresBody: false }
    }
  }
  if (depth >= 1) {
    const hit = detectJavaCsMethod(t)
    if (hit) {
      // `int X() => expr;` is a real method without a brace body.
      return RE_CS_EXPR_BODY.test(t) ? { ...hit, requiresBody: false } : hit
    }
  }
  return null
}

function detectRust(trimmed: string, depth: number): CLikeDetection | null {
  let m = RE_RUST_FN.exec(trimmed)
  if (m) {
    // Trait method signatures (`fn f(&self);`) have no body — keep them.
    return depth === 0
      ? { name: m[1]!, kind: 'function', requiresBody: false }
      : { name: m[1]!, kind: 'method', requiresBody: false }
  }
  if (depth !== 0) return null
  m = RE_RUST_MOD.exec(trimmed)
  if (m) return { name: m[1]!, kind: 'module', requiresBody: false }
  m = RE_RUST_STRUCT.exec(trimmed)
  if (m) return { name: m[1]!, kind: 'struct', requiresBody: false }
  m = RE_RUST_ENUM.exec(trimmed)
  if (m) return { name: m[1]!, kind: 'enum', requiresBody: false }
  m = RE_RUST_TRAIT.exec(trimmed)
  if (m) return { name: m[1]!, kind: 'trait', requiresBody: false }
  m = RE_RUST_TYPE.exec(trimmed)
  if (m) return { name: m[1]!, kind: 'type', requiresBody: false }
  m = RE_RUST_CONST.exec(trimmed)
  if (m) return { name: m[1]!, kind: 'const', requiresBody: false }
  m = RE_RUST_MACRO.exec(trimmed)
  if (m) return { name: m[1]!, kind: 'function', requiresBody: false }
  m = RE_RUST_IMPL.exec(trimmed)
  if (m) {
    // `impl Display for Foo` → "Foo"; `impl<T> Vec<T>` → "Vec".
    let target = m[1]!.replace(RE_RUST_WHERE_TAIL, '').trim()
    const forIdx = target.indexOf(' for ')
    if (forIdx >= 0) target = target.slice(forIdx + 5)
    target = target.replace(RE_GENERIC_TAIL, '').trim()
    return { name: target || 'impl', kind: 'impl', requiresBody: false }
  }
  return null
}

/**
 * C / C++. Free functions live at depth 0 (no leading keyword), so the
 * ident-before-paren method heuristic runs at every depth — depth 0 emits
 * a `function`, deeper matches (struct/class members) emit a `method`.
 */
function detectC(trimmed: string, depth: number): CLikeDetection | null {
  let m = RE_C_DEFINE.exec(trimmed)
  if (m) return { name: m[1]!, kind: 'const', requiresBody: false }
  if (depth <= 1) {
    // A one-line `typedef … Alias;` names the alias, not the underlying tag
    // (`typedef struct Point Vec;` → Vec). Checked before RE_C_TYPE so the
    // multi-line `typedef struct Foo { …` still resolves to the tag.
    if (RE_C_TYPEDEF_PREFIX.test(trimmed)) {
      m = RE_C_TYPEDEF_ALIAS.exec(trimmed)
      if (m) return { name: m[1]!, kind: 'type', requiresBody: false }
    }
    // Named struct/union/enum/class.
    m = RE_C_TYPE.exec(trimmed)
    if (m && m[2]) {
      return { name: m[2], kind: C_TYPE_KIND[m[1]!]!, requiresBody: false }
    }
  }
  const method = detectJavaCsMethod(trimmed)
  if (method) {
    return depth === 0 ? { ...method, kind: 'function' } : method
  }
  return null
}

function detectPhp(trimmed: string, depth: number): CLikeDetection | null {
  let m = RE_PHP_TYPE.exec(trimmed)
  if (m && depth <= 1) {
    return { name: m[2]!, kind: PHP_TYPE_KIND[m[1]!]!, requiresBody: false }
  }
  m = RE_PHP_FUNCTION.exec(trimmed)
  if (m) {
    // Interface / abstract methods have no body (`function f();`) — the
    // brace-body filter drops them, which is fine for an outline.
    return depth === 0
      ? { name: m[1]!, kind: 'function', requiresBody: false }
      : { name: m[1]!, kind: 'method', requiresBody: true }
  }
  return null
}

function detectSwift(trimmed: string, depth: number): CLikeDetection | null {
  let m = RE_SWIFT_TYPE.exec(trimmed)
  if (m) {
    return { name: m[2]!, kind: SWIFT_TYPE_KIND[m[1]!]!, requiresBody: false }
  }
  m = RE_SWIFT_FUNC.exec(trimmed)
  if (m) {
    return depth === 0
      ? { name: m[1]!, kind: 'function', requiresBody: false }
      : { name: m[1]!, kind: 'method', requiresBody: false }
  }
  return null
}

function detectScala(trimmed: string, depth: number): CLikeDetection | null {
  let m = RE_SCALA_TYPE.exec(trimmed)
  if (m) {
    return { name: m[2]!, kind: SCALA_TYPE_KIND[m[1]!]!, requiresBody: false }
  }
  m = RE_SCALA_DEF.exec(trimmed)
  if (m) {
    // Scala method bodies are frequently expression bodies (`def f = ...`),
    // so a brace body is not required.
    return depth === 0
      ? { name: m[1]!, kind: 'function', requiresBody: false }
      : { name: m[1]!, kind: 'method', requiresBody: false }
  }
  if (depth === 0) {
    m = RE_SCALA_VAL.exec(trimmed)
    if (m) return { name: m[1]!, kind: 'const', requiresBody: false }
  }
  return null
}

function detectBash(trimmed: string): CLikeDetection | null {
  let m = RE_BASH_FUNC_KEYWORD.exec(trimmed)
  if (m) return { name: m[1]!, kind: 'function', requiresBody: false }
  m = RE_BASH_FUNC_PAREN.exec(trimmed)
  if (m && !isControlKeyword(m[1]!)) {
    return { name: m[1]!, kind: 'function', requiresBody: false }
  }
  return null
}

// Words that look like a method call/keyword but never declare a symbol.
const CONTROL_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'await',
  'do',
  'else',
])

function isControlKeyword(name: string): boolean {
  return CONTROL_KEYWORDS.has(name)
}

const NO_KINDS: ReadonlySet<SymbolKind> = new Set()
const TS_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set(['class'])
const JAVA_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'interface',
  'enum',
  'record',
])
const KT_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'interface',
  'object',
])
const CS_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'interface',
  'struct',
  'record',
])
const RUST_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  'impl',
  'trait',
])
const MODULE_KINDS: ReadonlySet<SymbolKind> = new Set(['module'])
const C_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'struct',
])
const PHP_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'interface',
  'trait',
  'enum',
])
const SWIFT_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'struct',
  'enum',
  'interface',
  'impl',
])
const SCALA_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'trait',
  'object',
])
const GRAPHQL_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'interface',
  'record',
])
const TERRAFORM_METHOD_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'record',
  'module',
  'interface',
])

const maskLegacy = (s: string) => maskCLike(s, MASK_OPTS_LEGACY)
const maskJvm = (s: string) => maskCLike(s, MASK_OPTS_JVM)
const maskCSharp = (s: string) => maskCLike(s, MASK_OPTS_CSHARP)
const maskPlain = (s: string) => maskCLike(s, MASK_OPTS_PLAIN)

const TS_SPEC: CLikeSpec = {
  mask: maskLegacy,
  detectSource: 'raw',
  detect: detectTsJs,
  methodContainers: TS_METHOD_CONTAINERS,
  namespaceKinds: NO_KINDS,
  docPrefixes: [],
  strictMethodDepth: false,
}

const CLIKE_SPECS: Record<
  Exclude<
    OutlineLang,
    'python' | 'markdown' | 'ruby' | 'lua' | 'sql' | 'css' | 'html' |
    'yaml' | 'xml' | 'properties' | 'env' | 'toml' | 'dockerfile' | 'makefile'
  >,
  CLikeSpec
> = {
  typescript: TS_SPEC,
  javascript: TS_SPEC,
  go: {
    mask: maskLegacy,
    detectSource: 'raw',
    detect: detectGo,
    methodContainers: NO_KINDS,
    namespaceKinds: NO_KINDS,
    docPrefixes: [],
    strictMethodDepth: false,
  },
  java: {
    mask: maskJvm,
    detectSource: 'masked',
    detect: detectJava,
    methodContainers: JAVA_METHOD_CONTAINERS,
    namespaceKinds: NO_KINDS,
    docPrefixes: ['@'],
    strictMethodDepth: true,
  },
  kotlin: {
    mask: maskJvm,
    detectSource: 'masked',
    detect: detectKotlin,
    methodContainers: KT_METHOD_CONTAINERS,
    namespaceKinds: NO_KINDS,
    docPrefixes: ['@'],
    strictMethodDepth: true,
  },
  csharp: {
    mask: maskCSharp,
    detectSource: 'masked',
    detect: detectCSharp,
    methodContainers: CS_METHOD_CONTAINERS,
    namespaceKinds: MODULE_KINDS,
    docPrefixes: ['['],
    strictMethodDepth: true,
  },
  rust: {
    mask: maskRust,
    detectSource: 'masked',
    detect: detectRust,
    methodContainers: RUST_METHOD_CONTAINERS,
    namespaceKinds: MODULE_KINDS,
    docPrefixes: ['#'],
    strictMethodDepth: true,
  },
  c: {
    mask: maskPlain,
    detectSource: 'masked',
    detect: detectC,
    methodContainers: C_METHOD_CONTAINERS,
    namespaceKinds: NO_KINDS,
    docPrefixes: [],
    strictMethodDepth: true,
  },
  php: {
    mask: maskPhp,
    detectSource: 'masked',
    detect: detectPhp,
    methodContainers: PHP_METHOD_CONTAINERS,
    namespaceKinds: NO_KINDS,
    docPrefixes: ['#['],
    strictMethodDepth: true,
  },
  swift: {
    mask: maskJvm,
    detectSource: 'masked',
    detect: detectSwift,
    methodContainers: SWIFT_METHOD_CONTAINERS,
    namespaceKinds: NO_KINDS,
    docPrefixes: ['@'],
    strictMethodDepth: true,
  },
  scala: {
    mask: maskJvm,
    detectSource: 'masked',
    detect: detectScala,
    methodContainers: SCALA_METHOD_CONTAINERS,
    namespaceKinds: NO_KINDS,
    docPrefixes: ['@'],
    strictMethodDepth: true,
  },
  bash: {
    mask: maskBash,
    detectSource: 'masked',
    detect: trimmed => detectBash(trimmed),
    methodContainers: NO_KINDS,
    namespaceKinds: NO_KINDS,
    docPrefixes: ['#'],
    strictMethodDepth: false,
  },
  graphql: {
    mask: maskGraphql,
    detectSource: 'masked',
    detect: detectGraphql,
    methodContainers: GRAPHQL_METHOD_CONTAINERS,
    namespaceKinds: NO_KINDS,
    docPrefixes: [],
    strictMethodDepth: true,
  },
  terraform: {
    mask: maskTerraform,
    detectSource: 'masked',
    detect: detectTerraform,
    methodContainers: TERRAFORM_METHOD_CONTAINERS,
    namespaceKinds: NO_KINDS,
    docPrefixes: [],
    strictMethodDepth: true,
  },
}

/**
 * Finds the line where a namespace-kind declaration opens its `{` block, or
 * -1 when it has none (file-scoped `namespace X;`, `mod foo;`). Scans the
 * masked copy, so braces in strings/comments don't count.
 */
function findBlockOpenLine(startLine: number, masked: string[]): number {
  const limit = Math.min(masked.length, startLine + NOBODY_LOOKAHEAD)
  for (let i = startLine; i < limit; i++) {
    const ml = masked[i]!
    for (let k = 0; k < ml.length; k++) {
      if (ml[k] === '{') return i
      if (ml[k] === ';') return -1
    }
  }
  return -1
}

function scanCLike(source: string, spec: CLikeSpec): SymbolEntry[] {
  const lines = source.split('\n')
  const masked = spec.mask(source).split('\n')

  // Per-line brace depth: depth at line start, line end, and peak within line.
  const depthBefore: number[] = []
  const depthAfter: number[] = []
  const maxDepth: number[] = []
  let depth = 0
  for (const ml of masked) {
    depthBefore.push(depth)
    let peak = depth
    for (let k = 0; k < ml.length; k++) {
      const ch = ml[k]
      if (ch === '{') {
        depth++
        if (depth > peak) peak = depth
      } else if (ch === '}') {
        depth--
        if (depth < 0) return [] // unbalanced — fail open
      }
    }
    depthAfter.push(depth)
    maxDepth.push(peak)
  }
  if (depth !== 0) return [] // unbalanced — fail open

  // Pass 1 — collect declaration candidates. Namespace-kind blocks
  // (C# namespace, Rust mod) are transparent: the depth handed to detect()
  // is reduced by the number of namespace blocks open at that line, so
  // their members gate as top-level.
  const candidates: Candidate[] = []
  const hasNamespaces = spec.namespaceKinds.size > 0
  const nsStack: Array<{ depth: number; fromLine: number }> = []
  for (let L = 0; L < lines.length; L++) {
    const d = depthBefore[L]!
    if (hasNamespaces) {
      while (nsStack.length > 0) {
        const top = nsStack[nsStack.length - 1]!
        if (L > top.fromLine && d <= top.depth) nsStack.pop()
        else break
      }
    }
    const detectLine = spec.detectSource === 'raw' ? lines[L]! : masked[L]!
    const trimmed = detectLine.trim()
    if (!trimmed) continue
    let openNamespaces = 0
    if (hasNamespaces) {
      for (const e of nsStack) {
        if (L > e.fromLine) openNamespaces++
      }
    }
    const hit = spec.detect(trimmed, d - openNamespaces)
    if (!hit) continue
    candidates.push({ line: L, depth: d, ...hit })
    if (hasNamespaces && spec.namespaceKinds.has(hit.kind)) {
      const open = findBlockOpenLine(L, masked)
      if (open >= 0) nsStack.push({ depth: d, fromLine: open })
    }
  }

  // Pass 2 — resolve bounds and keep only valid symbols.
  const resolved: SymbolEntry[] = []
  for (let j = 0; j < candidates.length; j++) {
    const c = candidates[j]!
    const nextLine = candidates[j + 1]?.line ?? lines.length
    const { endLine, opened } = resolveCLikeBounds(
      c.line,
      c.depth,
      lines.length,
      nextLine,
      maxDepth,
      depthAfter,
      masked,
    )
    // A body-requiring candidate without one is a property/false match.
    if (c.requiresBody && !opened) continue
    const doc = findDocLineCLike(lines, c.line, spec.docPrefixes)
    resolved.push({
      name: c.name,
      kind: c.kind,
      signature: trimSignature(lines[c.line]!),
      startLine: c.line + 1,
      endLine: endLine + 1,
      depth: c.depth,
      ...(doc !== undefined && { docLine: doc + 1 }),
    })
  }

  // A method is only kept when its nearest enclosing symbol is a container
  // kind for this language (TS: class; Java: class/interface/enum/record;
  // Rust: impl/trait; …). strictMethodDepth additionally pins the method to
  // exactly one brace level inside that container.
  const kept = resolved.filter(s => {
    if (s.kind !== 'method') return true
    const parent = nearestEnclosing(resolved, s)
    if (parent === null || !spec.methodContainers.has(parent.kind)) {
      return false
    }
    return !spec.strictMethodDepth || s.depth === parent.depth + 1
  })

  return kept.sort((a, b) => a.startLine - b.startLine)
}

// How far past the declaration to look for a body `{` before concluding the
// declaration has none. Multi-line signatures rarely exceed this.
const NOBODY_LOOKAHEAD = 100

function resolveCLikeBounds(
  start: number,
  d: number,
  lineCount: number,
  nextCandidate: number,
  maxDepth: number[],
  depthAfter: number[],
  masked: string[],
): { endLine: number; opened: boolean } {
  let opened = false
  let end = start
  for (let i = start; i < lineCount; i++) {
    if (!opened && i >= nextCandidate) {
      // Reached the next declaration without a body of our own — a brace on
      // the next candidate's line belongs to IT, not to this no-body decl
      // (a bare `#define`, a no-body `type X;`). Must be checked before the
      // maxDepth test, or that later brace gets mis-attributed here.
      return { endLine: Math.max(start, i - 1), opened: false }
    }
    if (maxDepth[i]! > d) opened = true
    if (opened) {
      end = i
      // Body closed: brace depth is back to (or below) the declaration's.
      if (depthAfter[i]! <= d) return { endLine: i, opened: true }
      continue
    }
    // Body not open yet — either a multi-line signature or a no-body decl.
    if (masked[i]!.includes(';')) {
      // `;` at this depth terminates a no-body declaration
      // (`type X = ...;`, `const x = 1;`).
      return { endLine: i, opened: false }
    }
    if (depthAfter[i]! < d) {
      // The enclosing block closed — a no-body declaration (Kotlin
      // expression-body fun) cannot run past its container's `}`.
      //
      // Intentional divergence from the pre-spec scanner, which kept
      // scanning here: legacy nested no-body decls (TS statement false
      // matches, Go `type x int` inside a func) either leaked an endLine
      // past the container or resurrected as phantom symbols when an
      // unrelated later block opened braces. Clamping is strictly better;
      // verified against the old scanner on the full repo (3 TS files
      // changed, all phantom-symbol removals).
      return { endLine: Math.max(start, i - 1), opened: false }
    }
    if (i >= nextCandidate) {
      // Ran into the next declaration without finding a body.
      return { endLine: Math.max(start, i - 1), opened: false }
    }
    if (i - start >= NOBODY_LOOKAHEAD) {
      return { endLine: start, opened: false }
    }
    end = i
  }
  return { endLine: end, opened }
}

const RE_DOC_LINE = /^(\/\/|\/\*|\*|\*\/)/

function findDocLineCLike(
  lines: string[],
  start: number,
  docPrefixes: readonly string[],
): number | undefined {
  let i = start - 1
  let doc: number | undefined
  while (i >= 0) {
    const t = lines[i]!.trim()
    if (t === '') break
    if (RE_DOC_LINE.test(t) || docPrefixes.some(p => t.startsWith(p))) {
      doc = i
      i--
      continue
    }
    break
  }
  return doc
}

function nearestEnclosing<T extends { startLine: number; endLine: number }>(
  all: T[],
  target: T,
): T | null {
  let best: T | null = null
  for (const s of all) {
    if (s === target) continue
    if (s.startLine < target.startLine && s.endLine >= target.endLine) {
      if (
        best === null ||
        s.startLine > best.startLine // tighter (closer) container
      ) {
        best = s
      }
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Python scanner — indentation based
// ---------------------------------------------------------------------------

function leadingIndent(line: string): number {
  let n = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === ' ') n += 1
    else if (ch === '\t') n += 8 - (n % 8)
    else break
  }
  return n
}

function scanPython(source: string): SymbolEntry[] {
  const lines = source.split('\n')
  const masked = maskPython(source).split('\n')

  // A "code line" has real (non-string, non-comment) content.
  const isCode: boolean[] = masked.map(m => m.trim().length > 0)

  type PyCandidate = {
    line: number
    indent: number
    name: string
    kind: SymbolKind
  }
  const candidates: PyCandidate[] = []
  for (let L = 0; L < lines.length; L++) {
    if (!isCode[L]) continue
    const trimmed = masked[L]!.trim()
    let m = RE_PY_DEF.exec(trimmed)
    if (m) {
      candidates.push({
        line: L,
        indent: leadingIndent(lines[L]!),
        name: m[1]!,
        kind: 'function',
      })
      continue
    }
    m = RE_PY_CLASS.exec(trimmed)
    if (m) {
      candidates.push({
        line: L,
        indent: leadingIndent(lines[L]!),
        name: m[1]!,
        kind: 'class',
      })
    }
  }

  const out: SymbolEntry[] = []
  for (const c of candidates) {
    // The body runs until the next code line at indent <= c.indent.
    let end = c.line
    for (let i = c.line + 1; i < lines.length; i++) {
      if (!isCode[i]) continue
      if (leadingIndent(lines[i]!) <= c.indent) break
      end = i
    }
    // depth = number of ancestor candidates strictly containing this one.
    let depthCount = 0
    for (const other of candidates) {
      if (
        other !== c &&
        other.indent < c.indent &&
        other.line < c.line &&
        end <= bodyEndOf(other, lines, isCode)
      ) {
        depthCount++
      }
    }
    const docLine = findDocLinePython(masked, c.line)
    out.push({
      name: c.name,
      kind: c.kind === 'class' ? 'class' : depthCount > 0 ? 'method' : 'function',
      signature: trimPySignature(lines[c.line]!),
      startLine: c.line + 1,
      endLine: end + 1,
      depth: depthCount,
      ...(docLine !== undefined && { docLine: docLine + 1 }),
    })
  }
  return out.sort((a, b) => a.startLine - b.startLine)
}

function bodyEndOf(
  c: { line: number; indent: number },
  lines: string[],
  isCode: boolean[],
): number {
  let end = c.line
  for (let i = c.line + 1; i < lines.length; i++) {
    if (!isCode[i]) continue
    if (leadingIndent(lines[i]!) <= c.indent) break
    end = i
  }
  return end
}

function trimPySignature(raw: string): string {
  let s = raw.trim()
  const colon = s.indexOf(':')
  if (colon >= 0) s = s.slice(0, colon).trim()
  if (s.length > MAX_SIGNATURE_CHARS) {
    s = s.slice(0, MAX_SIGNATURE_CHARS).trimEnd() + '…'
  }
  return s
}

function findDocLinePython(
  masked: string[],
  start: number,
): number | undefined {
  // Decorators directly above the def/class.
  let i = start - 1
  let doc: number | undefined
  while (i >= 0) {
    const t = masked[i]!.trim()
    if (t === '') break
    if (t.startsWith('@')) {
      doc = i
      i--
      continue
    }
    break
  }
  return doc
}

// ---------------------------------------------------------------------------
// Markdown scanner — ATX headings, fenced code blocks excluded
// ---------------------------------------------------------------------------

const RE_MD_HEADING = /^(#{1,6})\s+(.+?)\s*$/
const RE_MD_FENCE = /^ {0,3}(`{3,}|~{3,})/
const RE_MD_CLOSING_HASHES = /\s+#+$/

function scanMarkdown(source: string): SymbolEntry[] {
  const lines = source.split('\n')
  // Phantom empty element from a trailing newline — mirror the caller's
  // cat -n line accounting so the last heading's endLine stays real.
  let lineCount = lines.length
  if (lineCount > 1 && lines[lineCount - 1] === '') lineCount--

  type Heading = { line: number; level: number; name: string }
  const headings: Heading[] = []
  // Marker that opened the current fence (null = not inside one). A fence
  // closes on a marker of the same char at least as long as the opener.
  let fence: string | null = null
  for (let L = 0; L < lineCount; L++) {
    const line = lines[L]!
    const fm = RE_MD_FENCE.exec(line)
    if (fm) {
      const marker = fm[1]!
      if (fence === null) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null
      }
      continue
    }
    if (fence !== null) continue
    const m = RE_MD_HEADING.exec(line)
    if (!m) continue
    const name = m[2]!.replace(RE_MD_CLOSING_HASHES, '').trim()
    if (!name) continue
    headings.push({ line: L, level: m[1]!.length, name })
  }

  // Depth is relative to the shallowest heading in the document, so an
  // h2-only doc renders flush instead of uniformly indented one level.
  const minLevel = headings.reduce((m, h) => Math.min(m, h.level), 6)

  return headings.map((h, idx) => {
    // The section runs until the next heading of the same or a higher level.
    let end = lineCount - 1
    for (let j = idx + 1; j < headings.length; j++) {
      if (headings[j]!.level <= h.level) {
        end = headings[j]!.line - 1
        break
      }
    }
    let signature = lines[h.line]!.trim()
    if (signature.length > MAX_SIGNATURE_CHARS) {
      signature = signature.slice(0, MAX_SIGNATURE_CHARS).trimEnd() + '…'
    }
    return {
      name: h.name,
      kind: 'heading' as const,
      signature,
      startLine: h.line + 1,
      endLine: end + 1,
      depth: h.level - minLevel,
    }
  })
}

/** Trims a raw declaration line to a signature: single-space-collapsed and
 *  length-capped. Optionally cut at the first occurrence of `cut`. */
function capSignature(raw: string, cut?: string): string {
  let s = raw.replace(RE_WS_RUN, ' ').trim()
  if (cut !== undefined) {
    const idx = s.indexOf(cut)
    if (idx >= 0) s = s.slice(0, idx).trim()
  }
  if (s.length > MAX_SIGNATURE_CHARS) {
    s = s.slice(0, MAX_SIGNATURE_CHARS).trimEnd() + '…'
  }
  return s
}

const RE_WS_RUN = /\s+/g
const RE_FIRST_WORD = /^([A-Za-z_]\w*)/

// ---------------------------------------------------------------------------
// Ruby scanner — keyword/`end` block tracking
// ---------------------------------------------------------------------------

const RE_RUBY_DEF = /^def\s+(?:self\.|[A-Za-z_]\w*\.)?([A-Za-z_]\w*[?!=]?)/
const RE_RUBY_CLASS_NAME = /^class\s+([A-Za-z_][\w:]*)/
const RE_RUBY_MODULE_NAME = /^module\s+([A-Za-z_][\w:]*)/
const RUBY_BLOCK_OPENERS = new Set([
  'if',
  'unless',
  'while',
  'until',
  'case',
  'begin',
  'for',
  'class',
  'module',
])
/** Trailing `do` / `do |x|` — opens a block closed by `end`. */
const RE_RUBY_TRAILING_DO = /(?:^|\s)do\b(\s*\|[^|]*\|)?\s*$/
/** A value-position opener (`x = if …`, `foo(case …`) needing an `end`. */
const RE_RUBY_VALUE_OPENER = /(?:(?<![=!<>])=|\()\s*(?:if|unless|case|begin)\b/
/** `end` as a keyword — not `.end`, `:end` (symbol literal), `weekend`, or `send`. */
const RE_RUBY_END = /(?:^|[^.:\w])end(?![\w])/g

/**
 * Ruby masking — `#` comments, single/double strings, and heredocs. Ruby
 * blocks close on the `end` keyword (never on braces — `{ … }` blocks don't
 * nest defs), so only tokens that could contain a stray `def`/`end` need
 * masking. Heredoc labels are required to start uppercase to disambiguate
 * from the `<<` append/shift operators (`arr << item`).
 */
function maskRuby(source: string): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  while (i < n) {
    const c = source[i]
    const c2 = source[i + 1]
    if (c === '#') {
      while (i < n && source[i] !== '\n') blank(i++)
      continue
    }
    if (c === '<' && c2 === '<') {
      let j = i + 2
      if (source[j] === '~' || source[j] === '-') j++
      let quote = ''
      if (source[j] === '"' || source[j] === "'") {
        quote = source[j]!
        j++
      }
      let id = ''
      // Uppercase-or-quoted label only, to avoid masking `arr << item`.
      if (
        j < n &&
        (quote ? RE_IDENT_START.test(source[j]!) : RE_UPPER_START.test(source[j]!))
      ) {
        while (j < n && RE_IDENT_CHAR.test(source[j]!)) {
          id += source[j]
          j++
        }
      }
      if (id) {
        if (quote && source[j] === quote) j++
        while (i < n && source[i] !== '\n') blank(i++)
        if (i < n) i++
        while (i < n) {
          const lineStart = i
          let k = i
          while (k < n && source[k] !== '\n') k++
          let p = lineStart
          while (p < k && (source[p] === ' ' || source[p] === '\t')) p++
          const closes =
            source.startsWith(id, p) &&
            !RE_IDENT_CHAR.test(source[p + id.length] ?? '')
          for (let q = lineStart; q < k; q++) blank(q)
          i = k
          if (closes) break
          if (i < n) i++
        }
        continue
      }
    }
    if (c === '"' || c === "'") {
      const quote = c
      blank(i++)
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') {
          blank(i++)
          if (i < n) blank(i++)
          continue
        }
        blank(i++)
      }
      if (i < n) blank(i++)
      continue
    }
    i++
  }
  return out.join('')
}

type BlockFrame = { entryIndex: number | null }

function scanRuby(source: string): SymbolEntry[] {
  const lines = source.split('\n')
  const masked = maskRuby(source).split('\n')
  const results: SymbolEntry[] = []
  const stack: BlockFrame[] = []
  const symbolDepth = () =>
    stack.reduce((d, f) => d + (f.entryIndex !== null ? 1 : 0), 0)

  for (let L = 0; L < lines.length; L++) {
    const t = masked[L]!.trim()
    if (!t) continue

    let opened = false
    let entryIndex: number | null = null
    const first = RE_FIRST_WORD.exec(t)?.[1]

    let m = RE_RUBY_DEF.exec(t)
    if (m) {
      const d = symbolDepth()
      const doc = findDocLineCLike(lines, L, ['#'])
      results.push({
        name: m[1]!,
        kind: d > 0 ? 'method' : 'function',
        signature: capSignature(lines[L]!, ';'),
        startLine: L + 1,
        endLine: L + 1,
        depth: d,
        ...(doc !== undefined && { docLine: doc + 1 }),
      })
      entryIndex = results.length - 1
      opened = true
    } else if (first === 'class' || first === 'module') {
      const nameM =
        first === 'class'
          ? RE_RUBY_CLASS_NAME.exec(t)
          : RE_RUBY_MODULE_NAME.exec(t)
      const d = symbolDepth()
      if (nameM) {
        const doc = findDocLineCLike(lines, L, ['#'])
        results.push({
          name: nameM[1]!,
          kind: first === 'class' ? 'class' : 'module',
          signature: capSignature(lines[L]!, ';'),
          startLine: L + 1,
          endLine: L + 1,
          depth: d,
          ...(doc !== undefined && { docLine: doc + 1 }),
        })
        entryIndex = results.length - 1
      }
      // `class << self` has no captured name → a block frame with no symbol.
      opened = true
    } else if (first !== undefined && RUBY_BLOCK_OPENERS.has(first)) {
      opened = true
    }

    if (!opened && RE_RUBY_VALUE_OPENER.test(t)) opened = true
    if (!opened && RE_RUBY_TRAILING_DO.test(t)) opened = true

    if (opened) stack.push({ entryIndex })

    const ends = (t.match(RE_RUBY_END) ?? []).length
    for (let e = 0; e < ends; e++) {
      const frame = stack.pop()
      if (!frame) return [] // unbalanced → fail open
      if (frame.entryIndex !== null) results[frame.entryIndex]!.endLine = L + 1
    }
  }

  if (stack.length !== 0) return [] // unbalanced → fail open
  return results.sort((a, b) => a.startLine - b.startLine)
}

// ---------------------------------------------------------------------------
// Lua scanner — keyword/`end` block tracking
// ---------------------------------------------------------------------------

const RE_LUA_FUNCTION = /^(?:local\s+)?function\s+([A-Za-z_][\w.:]*)/
const RE_LUA_ASSIGN_FUNCTION =
  /^(?:local\s+)?([A-Za-z_][\w.:]*)\s*=\s*function\b/
const RE_LUA_FUNCTION_KW = /\bfunction\b/g
const RE_LUA_END = /\bend\b/g
const RE_LUA_UNTIL = /\buntil\b/g
const LUA_BLOCK_OPENERS = new Set(['if', 'for', 'while', 'do', 'repeat'])

/** Long-bracket level at `[` (`[[`→0, `[==[`→2), or -1 when not one. */
function luaLongBracketLevel(source: string, start: number): number {
  if (source[start] !== '[') return -1
  let j = start + 1
  let eq = 0
  while (source[j] === '=') {
    eq++
    j++
  }
  return source[j] === '[' ? eq : -1
}

function maskLua(source: string): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  const blankLong = (level: number) => {
    const closer = ']' + '='.repeat(level) + ']'
    while (i < n && !source.startsWith(closer, i)) blank(i++)
    for (let k = 0; k < closer.length && i < n; k++) blank(i++)
  }
  while (i < n) {
    const c = source[i]
    const c2 = source[i + 1]
    if (c === '-' && c2 === '-') {
      const level = source[i + 2] === '[' ? luaLongBracketLevel(source, i + 2) : -1
      if (level >= 0) {
        blank(i++)
        blank(i++)
        blankLong(level)
      } else {
        while (i < n && source[i] !== '\n') blank(i++)
      }
      continue
    }
    if (c === '[') {
      const level = luaLongBracketLevel(source, i)
      if (level >= 0) {
        blankLong(level)
        continue
      }
    }
    if (c === '"' || c === "'") {
      const quote = c
      blank(i++)
      while (i < n && source[i] !== quote && source[i] !== '\n') {
        if (source[i] === '\\') {
          blank(i++)
          if (i < n) blank(i++)
          continue
        }
        blank(i++)
      }
      if (i < n && source[i] === quote) blank(i++)
      continue
    }
    i++
  }
  return out.join('')
}

/** Last dotted/colon segment of a Lua function path (`T:m` → `m`). */
function luaLastSegment(path: string): string {
  const dot = path.lastIndexOf('.')
  const colon = path.lastIndexOf(':')
  const cut = Math.max(dot, colon)
  return cut >= 0 ? path.slice(cut + 1) : path
}

function scanLua(source: string): SymbolEntry[] {
  const lines = source.split('\n')
  const masked = maskLua(source).split('\n')
  const results: SymbolEntry[] = []
  const stack: BlockFrame[] = []
  const symbolDepth = () =>
    stack.reduce((d, f) => d + (f.entryIndex !== null ? 1 : 0), 0)

  for (let L = 0; L < lines.length; L++) {
    const t = masked[L]!.trim()
    if (!t) continue

    let symbolName: string | null = null
    let m = RE_LUA_FUNCTION.exec(t)
    if (m) symbolName = luaLastSegment(m[1]!)
    else {
      m = RE_LUA_ASSIGN_FUNCTION.exec(t)
      if (m) symbolName = luaLastSegment(m[1]!)
    }

    const functionOpens = (t.match(RE_LUA_FUNCTION_KW) ?? []).length
    const first = RE_FIRST_WORD.exec(t)?.[1]
    const leadingOpen = first !== undefined && LUA_BLOCK_OPENERS.has(first) ? 1 : 0
    const totalOpens = functionOpens + leadingOpen

    if (symbolName) {
      const d = symbolDepth()
      const doc = findDocLineCLike(lines, L, ['-'])
      results.push({
        name: symbolName,
        kind: 'function',
        signature: capSignature(lines[L]!),
        startLine: L + 1,
        endLine: L + 1,
        depth: d,
        ...(doc !== undefined && { docLine: doc + 1 }),
      })
    }
    const symbolEntryIndex = symbolName ? results.length - 1 : null

    for (let k = 0; k < totalOpens; k++) {
      stack.push({ entryIndex: k === 0 ? symbolEntryIndex : null })
    }

    const closes =
      (t.match(RE_LUA_END) ?? []).length + (t.match(RE_LUA_UNTIL) ?? []).length
    for (let e = 0; e < closes; e++) {
      const frame = stack.pop()
      if (!frame) return []
      if (frame.entryIndex !== null) results[frame.entryIndex]!.endLine = L + 1
    }
  }

  if (stack.length !== 0) return []
  return results.sort((a, b) => a.startLine - b.startLine)
}

// ---------------------------------------------------------------------------
// SQL scanner — top-level CREATE statements
// ---------------------------------------------------------------------------

const RE_SQL_CREATE =
  /^create\s+(?:or\s+replace\s+)?(?:global\s+|local\s+)?(?:temp(?:orary)?\s+|unique\s+|clustered\s+|nonclustered\s+)?(materialized\s+view|table|view|function|procedure|proc|trigger|index|type|sequence)\s+(?:if\s+not\s+exists\s+)?([`"[\]\w.$]+)/i
const RE_SQL_NAME_STRIP = /[`"[\]]/g
const SQL_KIND: Record<string, SymbolKind> = {
  table: 'table',
  view: 'view',
  'materialized view': 'view',
  trigger: 'trigger',
  function: 'function',
  procedure: 'function',
  proc: 'function',
  index: 'const',
  type: 'type',
  sequence: 'const',
}

function maskSql(source: string): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  while (i < n) {
    const c = source[i]
    const c2 = source[i + 1]
    if (c === '-' && c2 === '-') {
      while (i < n && source[i] !== '\n') blank(i++)
      continue
    }
    if (c === '/' && c2 === '*') {
      blank(i++)
      blank(i++)
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) blank(i++)
      if (i < n) {
        blank(i++)
        blank(i++)
      }
      continue
    }
    // Dollar-quoted string (`$$ … $$`, `$body$ … $body$`). The tag is
    // word-chars only — RE_IDENT_CHAR would wrongly swallow the closing `$`.
    if (c === '$') {
      let j = i + 1
      while (j < n && RE_WORD_CHAR.test(source[j]!)) j++
      if (source[j] === '$') {
        const tag = source.slice(i, j + 1) // `$tag$`
        let k = j + 1
        while (k < n && !source.startsWith(tag, k)) k++
        const end = k < n ? k + tag.length : n
        while (i < end) blank(i++)
        continue
      }
    }
    // `'…'` string / `` `…` `` MySQL identifier — masked so their `;`/`(`
    // don't confuse bounds. Double-quoted `"…"` is a delimited IDENTIFIER in
    // standard SQL (it can name the CREATE target), so it is left visible.
    if (c === "'" || c === '`') {
      const quote = c
      blank(i++)
      while (i < n) {
        if (source[i] === quote) {
          if (source[i + 1] === quote) {
            // Doubled quote — an escaped quote, not a terminator.
            blank(i++)
            blank(i++)
            continue
          }
          blank(i++)
          break
        }
        blank(i++)
      }
      continue
    }
    i++
  }
  return out.join('')
}

function scanSql(source: string): SymbolEntry[] {
  const lines = source.split('\n')
  const masked = maskSql(source).split('\n')
  const results: SymbolEntry[] = []

  for (let L = 0; L < lines.length; L++) {
    const t = masked[L]!.trim()
    if (!t) continue
    const m = RE_SQL_CREATE.exec(t)
    if (!m) continue
    const keyword = m[1]!.toLowerCase().replace(RE_WS_RUN, ' ')
    const kind = SQL_KIND[keyword] ?? 'const'
    const name = m[2]!.replace(RE_SQL_NAME_STRIP, '')

    // The statement ends at the first `;` outside parentheses. Function /
    // procedure bodies with inner `;` end early — a best-effort bound.
    let end = L
    let paren = 0
    outer: for (let i = L; i < lines.length; i++) {
      const ml = masked[i]!
      for (let k = 0; k < ml.length; k++) {
        const ch = ml[k]
        if (ch === '(') paren++
        else if (ch === ')') paren--
        else if (ch === ';' && paren <= 0) {
          end = i
          break outer
        }
      }
      end = i
    }

    results.push({
      name,
      kind,
      signature: capSignature(lines[L]!, ';'),
      startLine: L + 1,
      endLine: end + 1,
      depth: 0,
    })
  }

  return results
}

// ---------------------------------------------------------------------------
// CSS / SCSS scanner — top-level selectors + at-rules
// ---------------------------------------------------------------------------

const RE_CSS_MIXIN = /^@(?:mixin|function)\s+([A-Za-z_][\w-]*)/
const RE_CSS_KEYFRAMES = /^@keyframes\s+([A-Za-z_-][\w-]*)/

function maskCss(source: string): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  while (i < n) {
    const c = source[i]
    const c2 = source[i + 1]
    if (c === '/' && c2 === '*') {
      blank(i++)
      blank(i++)
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) blank(i++)
      if (i < n) {
        blank(i++)
        blank(i++)
      }
      continue
    }
    // SCSS `//` line comment — but not a `:` scheme separator (`http://`).
    if (c === '/' && c2 === '/' && source[i - 1] !== ':') {
      while (i < n && source[i] !== '\n') blank(i++)
      continue
    }
    if (c === '"' || c === "'") {
      const quote = c
      blank(i++)
      while (i < n && source[i] !== quote && source[i] !== '\n') {
        if (source[i] === '\\') {
          blank(i++)
          if (i < n) blank(i++)
          continue
        }
        blank(i++)
      }
      if (i < n && source[i] === quote) blank(i++)
      continue
    }
    i++
  }
  return out.join('')
}

function scanCss(source: string): SymbolEntry[] {
  const masked = maskCss(source)
  const n = masked.length
  const results: SymbolEntry[] = []

  let line = 1
  let depth = 0
  let bufStartIdx = -1
  let bufStartLine = -1
  let pendingStartLine = -1
  let pendingSel = ''

  for (let i = 0; i < n; i++) {
    const c = masked[i]
    if (c === '\n') {
      line++
      continue
    }
    if (depth === 0) {
      if (c !== ' ' && c !== '\t' && bufStartIdx < 0) {
        bufStartIdx = i
        bufStartLine = line
      }
      if (c === '{') {
        pendingSel = capSignature(masked.slice(bufStartIdx, i))
        pendingStartLine = bufStartLine
        depth = 1
        bufStartIdx = -1
      } else if (c === ';' || c === '}') {
        // `@import …;`, an SCSS `$var: …;`, or a stray brace — not a block.
        bufStartIdx = -1
      }
    } else {
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          if (pendingSel) {
            let name = pendingSel
            let kind: SymbolKind = 'selector'
            let mm = RE_CSS_MIXIN.exec(pendingSel)
            if (mm) {
              name = mm[1]!
              kind = 'function'
            } else if ((mm = RE_CSS_KEYFRAMES.exec(pendingSel))) {
              name = mm[1]!
            }
            results.push({
              name,
              kind,
              signature: pendingSel,
              startLine: pendingStartLine,
              endLine: line,
              depth: 0,
            })
          }
          pendingSel = ''
          bufStartIdx = -1
        }
      }
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// HTML scanner — headings, landmarks, and id'd elements (not the full tree)
// ---------------------------------------------------------------------------

const RE_HTML_TAG = /<\/?([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g
const RE_HTML_ID = /\bid\s*=\s*["']?([\w-]+)/i
const RE_HTML_TAGS_STRIP = /<[^>]*>/g
const RE_HTML_HEADING = /^h[1-6]$/
const HTML_VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])
const HTML_LANDMARKS = new Set([
  'section',
  'nav',
  'main',
  'header',
  'footer',
  'article',
  'aside',
])

/** Blanks `<!-- -->` comments and `<script>`/`<style>` bodies so their `<`
 *  characters don't parse as tags. Preserves line structure. */
function maskHtml(source: string): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  const lower = source.toLowerCase()
  while (i < n) {
    if (source.startsWith('<!--', i)) {
      const close = source.indexOf('-->', i)
      const end = close < 0 ? n : close + 3
      while (i < end) blank(i++)
      continue
    }
    if (lower.startsWith('<script', i) || lower.startsWith('<style', i)) {
      const tag = lower.startsWith('<script', i) ? '</script' : '</style'
      const close = lower.indexOf(tag, i)
      // Blank only the element body, leaving the tags themselves parseable.
      const bodyStart = source.indexOf('>', i)
      if (bodyStart >= 0 && close > bodyStart) {
        i = bodyStart + 1
        while (i < close) blank(i++)
      } else {
        i += 1
      }
      continue
    }
    i++
  }
  return out.join('')
}

function scanHtml(source: string): SymbolEntry[] {
  const masked = maskHtml(source)
  const results: SymbolEntry[] = []
  type HtmlFrame = {
    tag: string
    entryIndex: number | null
    openEndIdx: number
  }
  const stack: HtmlFrame[] = []
  const trackedDepth = () =>
    stack.reduce((d, f) => d + (f.entryIndex !== null ? 1 : 0), 0)

  // Line number for a char index, computed by advancing a cursor forward as
  // matches arrive in order (avoids an O(n) count per tag).
  let cursor = 0
  let cursorLine = 1
  const lineAt = (idx: number): number => {
    while (cursor < idx) {
      if (masked[cursor] === '\n') cursorLine++
      cursor++
    }
    return cursorLine
  }

  RE_HTML_TAG.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = RE_HTML_TAG.exec(masked)) !== null) {
    const whole = m[0]
    const tag = m[1]!.toLowerCase()
    const attrs = m[2] ?? ''
    const selfClose = m[3] === '/'
    const isClosing = whole.startsWith('</')
    const tagLine = lineAt(m.index)

    if (isClosing) {
      // Pop up to and including the nearest matching open tag.
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s]!.tag === tag) {
          const closed = stack.splice(s)
          const frame = closed[0]!
          if (frame.entryIndex !== null) {
            const entry = results[frame.entryIndex]!
            entry.endLine = tagLine
            if (RE_HTML_HEADING.test(tag)) {
              const text = masked
                .slice(frame.openEndIdx, m.index)
                .replace(RE_HTML_TAGS_STRIP, '')
                .replace(RE_WS_RUN, ' ')
                .trim()
              if (text) {
                entry.name = text
                // Surface the text in the outline body (the signature column),
                // mirroring how a Markdown heading shows its own line.
                entry.signature = capSignature(`<${tag}> ${text}`)
              }
            }
          }
          break
        }
      }
      continue
    }

    const isHeading = RE_HTML_HEADING.test(tag)
    const idMatch = RE_HTML_ID.exec(attrs)
    const isLandmark = HTML_LANDMARKS.has(tag)
    const tracked = isHeading || isLandmark || idMatch !== null

    let entryIndex: number | null = null
    if (tracked) {
      const depth = trackedDepth()
      const name = isHeading
        ? tag // replaced with text content on close
        : idMatch
          ? `${tag}#${idMatch[1]}`
          : tag
      const kind: SymbolKind = isHeading ? 'heading' : 'element'
      results.push({
        name,
        kind,
        signature: capSignature(whole),
        startLine: tagLine,
        endLine: tagLine,
        depth,
      })
      entryIndex = results.length - 1
    }

    if (!selfClose && !HTML_VOID.has(tag)) {
      stack.push({ tag, entryIndex, openEndIdx: m.index + whole.length })
    }
  }

  return results.sort((a, b) => a.startLine - b.startLine)
}

// ---------------------------------------------------------------------------
// YAML — indentation-based key extractor (modeled on scanPython)
// ---------------------------------------------------------------------------

const RE_YAML_KEY = /^(\s*)([A-Za-z_][\w.-]*):(?:\s|$)/
const RE_YAML_LIST_KEY = /^(\s*)-(\s+)([A-Za-z_][\w.-]*):(?:\s|$)/
const RE_YAML_DOC_SEP = /^---+\s*$/
const RE_YAML_BLOCK_INDICATOR = /^[|>][+-]?\d?$/

function scanYaml(source: string): SymbolEntry[] {
  const lines = source.split('\n')
  let lineCount = lines.length
  if (lineCount > 1 && lines[lineCount - 1] === '') lineCount--

  type YamlKey = { line: number; indent: number; name: string }
  const keys: YamlKey[] = []
  let blockScalarIndent = -1

  for (let L = 0; L < lineCount; L++) {
    const line = lines[L]!
    if (RE_YAML_DOC_SEP.test(line.trim())) {
      blockScalarIndent = -1
      continue
    }
    if (blockScalarIndent >= 0) {
      const indent = leadingIndent(line)
      if (indent > blockScalarIndent || line.trim() === '') continue
      blockScalarIndent = -1
    }
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    let m = RE_YAML_KEY.exec(line)
    let isList = false
    if (!m) {
      m = RE_YAML_LIST_KEY.exec(line)
      isList = true
    }
    if (!m) continue

    const indent = isList ? m[1]!.length + 1 + m[2]!.length : m[1]!.length
    const name = isList ? m[3]! : m[2]!
    keys.push({ line: L, indent, name })

    const colonIdx = trimmed.indexOf(':')
    const valuePart = trimmed.slice(colonIdx + 1).trim()
    if (valuePart && !valuePart.startsWith('#') && RE_YAML_BLOCK_INDICATOR.test(valuePart)) {
      blockScalarIndent = indent
    }
  }

  if (keys.length === 0) return []

  const indents = [...new Set(keys.map(k => k.indent))].sort((a, b) => a - b)
  const indentToDepth = new Map<number, number>()
  indents.forEach((ind, i) => indentToDepth.set(ind, i))

  const results: SymbolEntry[] = []
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!
    const depth = indentToDepth.get(k.indent)!
    let end = lineCount - 1
    for (let j = i + 1; j < keys.length; j++) {
      if (keys[j]!.indent <= k.indent) {
        end = keys[j]!.line - 1
        break
      }
    }
    results.push({
      name: k.name,
      kind: 'key',
      signature: trimSignature(lines[k.line]!),
      startLine: k.line + 1,
      endLine: end + 1,
      depth,
    })
  }
  return results
}

// ---------------------------------------------------------------------------
// XML — tag-stack element tracker (modeled on scanHtml)
// ---------------------------------------------------------------------------

const RE_XML_TAG = /<\/?([a-zA-Z][\w:.-]*)([^>]*?)(\/?)>/g
const RE_XML_ID = /\bid\s*=\s*["']?([\w:.-]+)/i
const RE_XML_NAME = /\bname\s*=\s*["']?([\w:.-]+)/i

function maskXml(source: string): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  while (i < n) {
    if (source.startsWith('<!--', i)) {
      const close = source.indexOf('-->', i)
      const end = close < 0 ? n : close + 3
      while (i < end) blank(i++)
      continue
    }
    if (source.startsWith('<![CDATA[', i)) {
      const close = source.indexOf(']]>', i)
      const end = close < 0 ? n : close + 3
      while (i < end) blank(i++)
      continue
    }
    if (source.startsWith('<?', i)) {
      const close = source.indexOf('?>', i)
      const end = close < 0 ? n : close + 2
      while (i < end) blank(i++)
      continue
    }
    i++
  }
  return out.join('')
}

function scanXml(source: string): SymbolEntry[] {
  const masked = maskXml(source)
  const results: SymbolEntry[] = []
  type XmlFrame = { tag: string; entryIndex: number | null; openEndIdx: number }
  const stack: XmlFrame[] = []
  const trackedDepth = () =>
    stack.reduce((d, f) => d + (f.entryIndex !== null ? 1 : 0), 0)

  let cursor = 0
  let cursorLine = 1
  const lineAt = (idx: number): number => {
    while (cursor < idx) {
      if (masked[cursor] === '\n') cursorLine++
      cursor++
    }
    return cursorLine
  }

  RE_XML_TAG.lastIndex = 0
  let m: RegExpExecArray | null
  let rootTracked = false
  while ((m = RE_XML_TAG.exec(masked)) !== null) {
    const whole = m[0]
    const tag = m[1]!
    const attrs = m[2] ?? ''
    const selfClose = m[3] === '/'
    const isClosing = whole.startsWith('</')
    const tagLine = lineAt(m.index)

    if (isClosing) {
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s]!.tag === tag) {
          const closed = stack.splice(s)
          const frame = closed[0]!
          if (frame.entryIndex !== null) {
            results[frame.entryIndex]!.endLine = tagLine
          }
          break
        }
      }
      continue
    }

    let entryIndex: number | null = null
    const idMatch = RE_XML_ID.exec(attrs)
    const nameMatch = RE_XML_NAME.exec(attrs)
    const label = idMatch?.[1] ?? nameMatch?.[1] ?? null
    const isRoot = !rootTracked && stack.length === 0

    if (label || isRoot) {
      rootTracked = true
      const name = label ?? tag
      const depth = trackedDepth()
      results.push({
        name,
        kind: 'element',
        signature: trimSignature(whole),
        startLine: tagLine,
        endLine: tagLine,
        depth,
      })
      entryIndex = results.length - 1
    }

    if (!selfClose) {
      stack.push({ tag, entryIndex, openEndIdx: m.index + whole.length })
    }
  }

  return results.sort((a, b) => a.startLine - b.startLine)
}

// ---------------------------------------------------------------------------
// Config — .properties / .env
// ---------------------------------------------------------------------------

const RE_CONFIG_KEY = /^(?:export\s+)?([A-Za-z_][\w.]*)\s*[=:]/

function scanConfig(source: string): SymbolEntry[] {
  const lines = source.split('\n')
  let lineCount = lines.length
  if (lineCount > 1 && lines[lineCount - 1] === '') lineCount--

  // .properties line continuation: trailing `\` (odd count) extends to next
  // line. `\\` is an escaped literal backslash — even count, no continuation.
  const endsWithContinuation = (s: string): boolean => {
    let count = 0
    for (let i = s.length - 1; i >= 0 && s[i] === '\\'; i--) count++
    return count % 2 === 1
  }

  type ConfigEntry = { line: number; name: string }
  const entries: ConfigEntry[] = []
  let continuation = false

  for (let L = 0; L < lineCount; L++) {
    const line = lines[L]!
    if (continuation) {
      if (endsWithContinuation(line.trimEnd())) continue
      continuation = false
      continue
    }
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue
    const m = RE_CONFIG_KEY.exec(trimmed)
    if (!m) continue
    entries.push({ line: L, name: m[1]! })
    if (endsWithContinuation(line.trimEnd())) continuation = true
  }

  if (entries.length === 0) return []

  const results: SymbolEntry[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    const end = i < entries.length - 1 ? entries[i + 1]!.line - 1 : lineCount - 1
    results.push({
      name: e.name,
      kind: 'key',
      signature: trimSignature(lines[e.line]!),
      startLine: e.line + 1,
      endLine: end + 1,
      depth: 0,
    })
  }
  return results
}

// ---------------------------------------------------------------------------
// TOML — table/section extractor
// ---------------------------------------------------------------------------

const RE_TOML_TABLE = /^\[\[?([^\]]+)\]\]?/

function scanToml(source: string): SymbolEntry[] {
  const lines = source.split('\n')
  let lineCount = lines.length
  if (lineCount > 1 && lines[lineCount - 1] === '') lineCount--

  type TomlTable = { line: number; name: string; depth: number }
  const tables: TomlTable[] = []

  for (let L = 0; L < lineCount; L++) {
    const trimmed = lines[L]!.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = RE_TOML_TABLE.exec(trimmed)
    if (!m) continue
    const name = m[1]!.trim()
    const depth = name.split('.').length - 1
    tables.push({ line: L, name, depth })
  }

  if (tables.length === 0) return []

  const results: SymbolEntry[] = []
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i]!
    const end = i < tables.length - 1 ? tables[i + 1]!.line - 1 : lineCount - 1
    results.push({
      name: t.name,
      kind: 'key',
      signature: trimSignature(lines[t.line]!),
      startLine: t.line + 1,
      endLine: end + 1,
      depth: t.depth,
    })
  }
  return results
}

// ---------------------------------------------------------------------------
// Dockerfile — instruction list
// ---------------------------------------------------------------------------

const RE_DOCKER_INSTR = /^(FROM|RUN|COPY|ADD|WORKDIR|ENV|ARG|EXPOSE|LABEL|USER|VOLUME|CMD|ENTRYPOINT|HEALTHCHECK|ONBUILD|STOPSIGNAL|SHELL)\b/i
const RE_DOCKER_AS = /\bAS\s+(\S+)/i

function scanDockerfile(source: string): SymbolEntry[] {
  const lines = source.split('\n')
  let lineCount = lines.length
  if (lineCount > 1 && lines[lineCount - 1] === '') lineCount--

  type DockerEntry = { line: number; name: string; depth: number }
  const entries: DockerEntry[] = []
  let stageDepth = 0
  let hasFrom = false
  let fromCount = 0
  let continuation = false

  for (let L = 0; L < lineCount; L++) {
    const trimmed = lines[L]!.trim()
    if (continuation) {
      continuation = trimmed.endsWith('\\')
      continue
    }
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = RE_DOCKER_INSTR.exec(trimmed)
    if (!m) continue
    const instr = m[1]!.toUpperCase()
    if (instr === 'FROM') {
      hasFrom = true
      const asMatch = RE_DOCKER_AS.exec(trimmed)
      const name = asMatch ? asMatch[1]! : `FROM_${fromCount + 1}`
      fromCount++
      entries.push({ line: L, name, depth: 0 })
      stageDepth = 1
    } else {
      if (!hasFrom) {
        entries.push({ line: L, name: instr, depth: 0 })
      } else {
        entries.push({ line: L, name: instr, depth: stageDepth })
      }
    }
    continuation = trimmed.endsWith('\\')
  }

  if (entries.length === 0) return []

  const results: SymbolEntry[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    const end = i < entries.length - 1 ? entries[i + 1]!.line - 1 : e.line
    results.push({
      name: e.name,
      kind: 'key',
      signature: trimSignature(lines[e.line]!),
      startLine: e.line + 1,
      endLine: end + 1,
      depth: e.depth,
    })
  }
  return results
}

// ---------------------------------------------------------------------------
// Makefile — target + variable extractor
// ---------------------------------------------------------------------------

const RE_MAKE_TARGET = /^([A-Za-z_.%][\w.%-]*):/
const RE_MAKE_VAR = /^([A-Za-z_][\w]*)\s*[?:!+]?=/

function scanMakefile(source: string): SymbolEntry[] {
  const lines = source.split('\n')
  let lineCount = lines.length
  if (lineCount > 1 && lines[lineCount - 1] === '') lineCount--

  type MakeEntry = { line: number; name: string; kind: SymbolKind }
  const entries: MakeEntry[] = []

  for (let L = 0; L < lineCount; L++) {
    const line = lines[L]!
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('\t')) continue
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^(include|-include|sinclude)\b/.test(trimmed)) continue

    const vm = RE_MAKE_VAR.exec(trimmed)
    if (vm) {
      entries.push({ line: L, name: vm[1]!, kind: 'const' })
      continue
    }
    const tm = RE_MAKE_TARGET.exec(trimmed)
    if (tm) {
      entries.push({ line: L, name: tm[1]!, kind: 'function' })
    }
  }

  if (entries.length === 0) return []

  const results: SymbolEntry[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    let end = e.line
    if (e.kind === 'function') {
      for (let j = e.line + 1; j < lineCount; j++) {
        const next = lines[j]!
        if (next.startsWith('\t') || next.trim() === '' || next.trim().startsWith('#')) {
          end = j
        } else {
          break
        }
      }
    }
    results.push({
      name: e.name,
      kind: e.kind,
      signature: trimSignature(lines[e.line]!),
      startLine: e.line + 1,
      endLine: end + 1,
      depth: 0,
    })
  }
  return results
}

// ---------------------------------------------------------------------------
// GraphQL — mask + detect for CLIKE_SPECS
// ---------------------------------------------------------------------------

const RE_GRAPHQL_TYPE = /^(?:extend\s+)?(type|input|interface|enum|scalar|union)\s+([A-Za-z_]\w*)/
const RE_GRAPHQL_SCHEMA = /^schema\b/
const RE_GRAPHQL_FIELD = /^([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:/

const GRAPHQL_KIND: Record<string, SymbolKind> = {
  type: 'class',
  input: 'record',
  interface: 'interface',
  enum: 'enum',
  scalar: 'type',
  union: 'type',
}

const GRAPHQL_KEYWORDS = new Set([
  'extend', 'schema', 'type', 'input', 'interface', 'enum', 'scalar',
  'union', 'fragment', 'directive', 'implements', 'query', 'mutation',
  'subscription', 'on',
])

function maskGraphql(source: string): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  while (i < n) {
    const c = source[i]
    if (c === '#') {
      const prev = i > 0 ? source[i - 1]! : '\n'
      if (prev === '\n' || prev === ' ' || prev === '\t') {
        while (i < n && source[i] !== '\n') blank(i++)
        continue
      }
    }
    if (source.startsWith('"""', i)) {
      const close = source.indexOf('"""', i + 3)
      const end = close < 0 ? n : close + 3
      while (i < end) blank(i++)
      continue
    }
    i++
  }
  return out.join('')
}

function detectGraphql(trimmed: string, depth: number): CLikeDetection | null {
  if (depth === 0) {
    const m = RE_GRAPHQL_TYPE.exec(trimmed)
    if (m) {
      const kw = m[1]!
      const name = m[2]!
      const kind = GRAPHQL_KIND[kw]!
      const noBody = kw === 'scalar' || kw === 'union'
      return { name, kind, requiresBody: !noBody }
    }
    if (RE_GRAPHQL_SCHEMA.test(trimmed)) {
      return { name: 'schema', kind: 'module', requiresBody: true }
    }
  }
  if (depth >= 1) {
    const m = RE_GRAPHQL_FIELD.exec(trimmed)
    if (m && !GRAPHQL_KEYWORDS.has(m[1]!)) {
      return { name: m[1]!, kind: 'method', requiresBody: false }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Terraform/HCL — mask + detect for CLIKE_SPECS
// ---------------------------------------------------------------------------

const RE_TF_BLOCK = /^(resource|data|module|variable|output|provider|locals|terraform)\b(.*)/i
const RE_TF_NESTED = /^(dynamic|provisioner|lifecycle|provider)\b(.*)/i

const TF_KIND: Record<string, SymbolKind> = {
  resource: 'class',
  data: 'record',
  module: 'module',
  variable: 'const',
  output: 'const',
  provider: 'interface',
  locals: 'module',
  terraform: 'module',
}

const RE_QUOTED_LABEL = /"([^"]+)"/g

function extractQuotedLabels(s: string): string[] {
  return [...s.matchAll(RE_QUOTED_LABEL)].map(m => m[1]!)
}

function maskTerraform(source: string): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  while (i < n) {
    const c = source[i]
    const c2 = source[i + 1]
    if (c === '#') {
      while (i < n && source[i] !== '\n') blank(i++)
      continue
    }
    if (c === '/' && c2 === '/') {
      while (i < n && source[i] !== '\n') blank(i++)
      continue
    }
    if (c === '/' && c2 === '*') {
      const close = source.indexOf('*/', i + 2)
      const end = close < 0 ? n : close + 2
      while (i < end) blank(i++)
      continue
    }
    if (c === '<' && c2 === '<' && source[i + 2] !== '<') {
      let j = i + 2
      if (source[j] === '-') j++
      const labelStart = j
      while (j < n && RE_WORD_CHAR.test(source[j]!)) j++
      if (j > labelStart) {
        const id = source.slice(labelStart, j)
        const indented = source[i + 2] === '-'
        // Find the close label line-by-line (without blanking first, so an
        // unfound close doesn't eat the rest of the file — matches the old
        // regex-search behavior where no match meant "don't mask heredoc").
        let closeEnd = -1
        let p = j
        while (p < n && source[p] !== '\n') p++
        if (p < n) p++
        while (p < n) {
          const ls = p
          let k = p
          while (k < n && source[k] !== '\n') k++
          let q = ls
          if (indented) {
            while (q < k && (source[q] === ' ' || source[q] === '\t')) q++
          }
          if (
            source.startsWith(id, q) &&
            !RE_WORD_CHAR.test(source[q + id.length] ?? '')
          ) {
            closeEnd = k
            break
          }
          p = k
          if (p < n) p++
        }
        if (closeEnd >= 0) {
          while (i < closeEnd) blank(i++)
          i = closeEnd
          continue
        }
        // Close label not found — don't mask, let main loop handle `<<` normally.
      }
    }
    i++
  }
  return out.join('')
}

function detectTerraform(trimmed: string, depth: number): CLikeDetection | null {
  if (depth === 0) {
    const m = RE_TF_BLOCK.exec(trimmed)
    if (m) {
      const kw = m[1]!.toLowerCase()
      const kind = TF_KIND[kw]
      if (!kind) return null
      const rest = m[2] ?? ''
      const labels = extractQuotedLabels(rest)
      const name = labels.length > 0 ? labels.join('.') : kw
      return { name, kind, requiresBody: false }
    }
  }
  if (depth >= 1) {
    const m = RE_TF_NESTED.exec(trimmed)
    if (m) {
      const rest = m[2] ?? ''
      const labels = extractQuotedLabels(rest)
      const name = labels[0] ?? m[1]!.toLowerCase()
      return { name, kind: 'method', requiresBody: false }
    }
  }
  return null
}
