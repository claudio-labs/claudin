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
}

/** Maps a file extension (with or without leading dot) to an outline language. */
export function detectOutlineLang(ext: string): OutlineLang | null {
  return EXT_TO_LANG[ext.toLowerCase().replace(/^\./, '')] ?? null
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

/** Scans a source file and returns its ordered symbol table. */
export function scanSymbols(source: string, lang: OutlineLang): SymbolEntry[] {
  try {
    if (!source) return []
    if (lang === 'python') return scanPython(source)
    if (lang === 'markdown') return scanMarkdown(source)
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

const maskLegacy = (s: string) => maskCLike(s, MASK_OPTS_LEGACY)
const maskJvm = (s: string) => maskCLike(s, MASK_OPTS_JVM)
const maskCSharp = (s: string) => maskCLike(s, MASK_OPTS_CSHARP)

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
  Exclude<OutlineLang, 'python' | 'markdown'>,
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
