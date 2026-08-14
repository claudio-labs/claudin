// Per-language declaration regexes and the `detect` half of each CLikeSpec.
//
// A detector reads one trimmed (and, for the non-legacy languages, masked)
// line plus the current brace depth and answers "is this a declaration, and of
// what kind". The spec table that binds them to a mask and a filter lives in
// ./specs.ts; the engine that drives them is ./scan.ts.

import type { CLikeDetection } from 'src/tools/shared/codeOutline/clike/types.js'
import type { SymbolKind } from 'src/tools/shared/codeOutline/types.js'

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
// An object-literal member written as `key: () => {…}` or `key: function () {…}`.
// Requires an arrow or the `function` keyword so a data property (`name: 'x'`)
// and a type annotation never match; the `requiresBody` gate in scanCLike then
// drops any survivor without a block, which is what keeps `key: () => expr` out.
const RE_METHOD_COLON =
  /^([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::\s*[^=]+?)?=>|[A-Za-z_$][\w$]*\s*=>)/

const RE_GO_FUNC =
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/
const RE_GO_TYPE = /^type\s+([A-Za-z_][\w]*)/

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

export function detectTsJs(trimmed: string, depth: number): CLikeDetection | null {
  // Only top-level declarations belong in an outline. A function, class,
  // type, etc. nested inside another body is noise; members of a class or an
  // object literal are handled separately below via the depth >= 1 branch.
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

  // Methods are only meaningful inside a container (see TS_METHOD_CONTAINERS).
  if (depth >= 1) {
    m = RE_METHOD_COLON.exec(trimmed)
    if (m) return { name: m[1]!, kind: 'method', requiresBody: true }
    m = RE_METHOD.exec(trimmed)
    if (m && !isControlKeyword(m[1]!)) {
      return { name: m[1]!, kind: 'method', requiresBody: true }
    }
    m = RE_METHOD_ARROW.exec(trimmed)
    if (m) return { name: m[1]!, kind: 'method', requiresBody: true }
  }
  return null
}

export function detectGo(trimmed: string): CLikeDetection | null {
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

export function detectJava(trimmed: string, depth: number): CLikeDetection | null {
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

export function detectKotlin(trimmed: string, depth: number): CLikeDetection | null {
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

export function detectCSharp(trimmed: string, depth: number): CLikeDetection | null {
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

export function detectRust(trimmed: string, depth: number): CLikeDetection | null {
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
export function detectC(trimmed: string, depth: number): CLikeDetection | null {
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

export function detectPhp(trimmed: string, depth: number): CLikeDetection | null {
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

export function detectSwift(trimmed: string, depth: number): CLikeDetection | null {
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

export function detectScala(trimmed: string, depth: number): CLikeDetection | null {
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

export function detectBash(trimmed: string): CLikeDetection | null {
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
