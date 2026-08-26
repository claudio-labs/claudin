// Masking core — replace string / comment content with spaces, preserving
// newlines and line lengths so depth/indentation math on the copy is reliable.
//
// Holds the generic machinery: the interpolation table, the literal walker and
// the parameterized C-like masker. Per-family maskers live in ./languages.ts;
// maskers used by exactly one scanner live with that scanner in ../langs/.

import type { OutlineLang } from 'src/tools/shared/codeOutline/types.js'


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

export const RE_IDENT_CHAR = /[A-Za-z0-9_$]/
// Python string-literal prefix letters that may accompany an `f` (rb'' etc.).
const RE_PY_PREFIX_CHAR = /[rRbBuU]/

// ---------------------------------------------------------------------------
// String interpolation — opt-in, for callers that resolve references
// ---------------------------------------------------------------------------

/**
 * How a language splices code into a string literal.
 *
 * The outline scanner never asks for this. For finding *declarations* a literal
 * is opaque, and that opacity is a feature: a `function` inside a string cannot
 * mint a phantom symbol. Callers that resolve *references* — the Rename tool —
 * need the opposite, because `"${cfg(x)}"` is a real call site, and masking it
 * skips the rename and leaves a half-edited file behind with no warning.
 *
 * A language with no entry here keeps every literal opaque, which is correct
 * for Go, Java, Lua and C: their string syntax has no interpolation at all.
 */
export type Interpolation = {
  /** Bracketed forms: `${`…`}` (JS/Kotlin), `#{`…`}` (Ruby), `\(`…`)` (Swift). */
  braced: ReadonlyArray<{ open: string; close: string }>
  /** Sigil directly followed by a bare identifier: `"$total"` in Kotlin/PHP/shell. */
  bareSigil?: string
  /** A doubled opener is literal text, not a field: `{{` in C# and Python. */
  doubledOpenerIsLiteral?: boolean
  /** The language has `//` + `/* *​/` comments, so an interpolation body can hold one. */
  slashComments?: boolean
  /**
   * The language has regex literals, so an interpolation body can hold one.
   * Without this a quote inside the pattern — `${v.replace(/'/g, x)}` — opens
   * a literal that runs to the next quote anywhere in the file and derails
   * every brace after it.
   */
  regexLiterals?: boolean
  /**
   * Which literals interpolate, given the index of the opening quote and the
   * terminator that will close it. Defaults to every literal in the language.
   */
  appliesTo?: (source: string, quoteIdx: number, terminator: string) => boolean
}

/** `f"…"` / `rf"…"` — an f prefix, possibly behind the r/b/u modifiers. */
function isPythonFString(source: string, quoteIdx: number): boolean {
  for (let k = quoteIdx - 1; k >= quoteIdx - 2 && k >= 0; k--) {
    const ch = source[k]!
    if (ch === 'f' || ch === 'F') return true
    if (!RE_PY_PREFIX_CHAR.test(ch)) return false
  }
  return false
}

/** `$"…"` / `$@"…"` / `@$"…"`. */
function isCSharpInterpolated(source: string, quoteIdx: number): boolean {
  const prev = source[quoteIdx - 1]
  if (prev === '$') return true
  return prev === '@' && source[quoteIdx - 2] === '$'
}

/** `s"…"` / `f"…"` — Scala's interpolator prefixes, as their own token. */
function isScalaInterpolated(source: string, quoteIdx: number): boolean {
  const prev = source[quoteIdx - 1]
  if (prev !== 's' && prev !== 'f') return false
  return !RE_IDENT_CHAR.test(source[quoteIdx - 2] ?? '')
}

/** `r'…'` / `r"""…"""` — Dart's raw string, where `$` is literal. */
function isDartRawString(source: string, quoteIdx: number): boolean {
  if (source[quoteIdx - 1] !== 'r') return false
  return !RE_IDENT_CHAR.test(source[quoteIdx - 2] ?? '')
}

/**
 * Rust captures `{name}` only inside a format-family macro, so an ordinary
 * `"{name}"` must stay opaque. Matched by the nearest `!(` earlier on the same
 * line whose macro name is a known formatter — `if !(x) { "{name}" }` is
 * ordinary negation and must NOT qualify, or the rename would edit the string.
 * A macro call split across lines fails closed (the literal stays masked).
 */
const RUST_FORMAT_MACROS = new Set([
  'assert',
  'assert_eq',
  'assert_ne',
  'debug_assert',
  'eprint',
  'eprintln',
  'format',
  'format_args',
  'panic',
  'print',
  'println',
  'todo',
  'unimplemented',
  'unreachable',
  'write',
  'writeln',
])

function isRustFormatLiteral(source: string, quoteIdx: number): boolean {
  const lineStart = source.lastIndexOf('\n', quoteIdx) + 1
  const bang = source.lastIndexOf('!(', quoteIdx)
  if (bang < lineStart) return false
  let j = bang - 1
  while (j >= lineStart && RE_WORD_CHAR.test(source[j]!)) j--
  return RUST_FORMAT_MACROS.has(source.slice(j + 1, bang))
}

const DOUBLE_QUOTED = (_s: string, _i: number, terminator: string) =>
  terminator === '"'

export const INTERPOLATION: Partial<Record<OutlineLang, Interpolation>> = {
  // Only the backtick template interpolates; `'…'` and `"…"` never do.
  typescript: {
    braced: [{ open: '${', close: '}' }],
    slashComments: true,
    regexLiterals: true,
    appliesTo: (_s, _i, terminator) => terminator === '`',
  },
  // Same shape as TypeScript. Needed as its own entry because EXT_TO_LANG keeps
  // .js/.jsx/.mjs/.cjs on 'javascript' — a lookup miss here silently drops
  // interpolation handling for every JS file.
  javascript: {
    braced: [{ open: '${', close: '}' }],
    slashComments: true,
    regexLiterals: true,
    appliesTo: (_s, _i, terminator) => terminator === '`',
  },
  python: {
    braced: [{ open: '{', close: '}' }],
    doubledOpenerIsLiteral: true,
    appliesTo: isPythonFString,
  },
  // `"$x"`, `"${x()}"` — including the `"""` raw form, which interpolates too.
  kotlin: {
    braced: [{ open: '${', close: '}' }],
    bareSigil: '$',
    slashComments: true,
  },
  scala: {
    braced: [{ open: '${', close: '}' }],
    bareSigil: '$',
    slashComments: true,
    appliesTo: isScalaInterpolated,
  },
  csharp: {
    braced: [{ open: '{', close: '}' }],
    doubledOpenerIsLiteral: true,
    slashComments: true,
    appliesTo: isCSharpInterpolated,
  },
  swift: {
    braced: [{ open: '\\(', close: ')' }],
    slashComments: true,
  },
  // Dart interpolates in BOTH quote styles; only an `r` prefix opts out.
  dart: {
    braced: [{ open: '${', close: '}' }],
    bareSigil: '$',
    slashComments: true,
    appliesTo: (source, quoteIdx) => !isDartRawString(source, quoteIdx),
  },
  // A Groovy GString is double-quoted; `'…'` and `'''…'''` are plain strings.
  groovy: {
    braced: [{ open: '${', close: '}' }],
    bareSigil: '$',
    slashComments: true,
    appliesTo: (_s, _i, terminator) => terminator.startsWith('"'),
  },
  elixir: {
    braced: [{ open: '#{', close: '}' }],
  },
  // `"$x"`, `"${x}"` and the subexpression form `"$($x.Name)"`.
  powershell: {
    braced: [
      { open: '$(', close: ')' },
      { open: '${', close: '}' },
    ],
    bareSigil: '$',
  },
  ruby: {
    braced: [{ open: '#{', close: '}' }],
    appliesTo: DOUBLE_QUOTED,
  },
  // `{$x}` first: it must win over the `${x}` form when both could match.
  php: {
    braced: [
      { open: '{$', close: '}' },
      { open: '${', close: '}' },
    ],
    bareSigil: '$',
    appliesTo: DOUBLE_QUOTED,
  },
  bash: {
    braced: [{ open: '${', close: '}' }],
    bareSigil: '$',
    appliesTo: DOUBLE_QUOTED,
  },
  rust: {
    braced: [{ open: '{', close: '}' }],
    doubledOpenerIsLiteral: true,
    appliesTo: isRustFormatLiteral,
  },
}
INTERPOLATION.javascript = INTERPOLATION.typescript

/** The character that re-opens a nesting level for each interpolation closer. */
const NEST_OPENER: Record<string, string> = { '}': '{', ')': '(', ']': '[' }

export type MaskCtx = {
  source: string
  n: number
  blank: (k: number) => void
}

type LiteralOpts = {
  /** Closing token — also the opening token when longer than one char. */
  terminator: string
  /**
   * The character that escapes the next one — `\` almost everywhere, a
   * backtick in PowerShell, `null` in a raw literal that has no escapes.
   */
  escape: string | null
  /** An unterminated literal ends at the newline (Python's single-quoted form). */
  stopAtNewline?: boolean
  /** A doubled terminator is an escaped quote, not the close (C# verbatim). */
  doubledTerminatorIsEscape?: boolean
  interp?: Interpolation | null
}

/**
 * Blanks one string literal — opening token at `start` through its terminator —
 * and returns the index just past it. This is the single literal scanner every
 * language masker delegates to; before it existed each one carried its own
 * near-identical copy.
 *
 * With `interp`, the code inside each interpolation is left visible while the
 * delimiters themselves are blanked as punctuation, so brace-depth math over
 * the masked copy is unchanged.
 */
export function maskLiteral(ctx: MaskCtx, start: number, opts: LiteralOpts): number {
  const { source, n, blank } = ctx
  const { terminator, escape, interp } = opts
  const active =
    interp && (interp.appliesTo?.(source, start, terminator) ?? true)
      ? interp
      : null
  let k = start
  for (let t = 0; t < terminator.length && k < n; t++) blank(k++)
  while (k < n) {
    const ch = source[k]!
    if (opts.stopAtNewline && ch === '\n') return k
    if (source.startsWith(terminator, k)) {
      const doubled =
        opts.doubledTerminatorIsEscape &&
        source.startsWith(terminator, k + terminator.length)
      const width = doubled ? terminator.length * 2 : terminator.length
      for (let t = 0; t < width && k < n; t++) blank(k++)
      if (doubled) continue
      return k
    }
    // Interpolation is tried before the escape rule because Swift's opener IS
    // an escape (`\(`). The other direction still works: JS `\${` fails the
    // `${` match here and falls through to the escape branch, which is what
    // makes an escaped dollar stay literal text.
    if (active) {
      const next = maskInterpolationAt(ctx, k, active)
      if (next > k) {
        k = next
        continue
      }
    }
    if (escape && ch === escape) {
      blank(k++)
      if (k < n) blank(k++)
      continue
    }
    blank(k++)
  }
  return k // unterminated — fail open
}

/**
 * Blanks the delimiters of an interpolation opening at `k` and leaves its body
 * as code, returning the index past it. Returns `k` when nothing opens here.
 */
export function maskInterpolationAt(
  ctx: MaskCtx,
  k: number,
  interp: Interpolation,
): number {
  const { source, n, blank } = ctx
  for (const form of interp.braced) {
    if (!source.startsWith(form.open, k)) continue
    let j = k
    if (
      interp.doubledOpenerIsLiteral &&
      source.startsWith(form.open, k + form.open.length)
    ) {
      // `{{` — an escaped literal brace, not a replacement field.
      for (let t = 0; t < form.open.length * 2; t++) blank(j++)
      return j
    }
    for (let t = 0; t < form.open.length; t++) blank(j++)
    return maskInterpolationBody(ctx, j, form, interp)
  }
  const sigil = interp.bareSigil
  if (
    sigil &&
    source.startsWith(sigil, k) &&
    RE_IDENT_START.test(source[k + sigil.length] ?? '')
  ) {
    // `$name` — blank the sigil, leave the identifier itself as code.
    let j = k
    for (let t = 0; t < sigil.length; t++) blank(j++)
    // Stops at the NEXT sigil: `"$foo$bar"` is two references, and letting
    // `$` continue the name here would swallow the second sigil unblanked —
    // which then reads as an identifier character and loses BOTH sites.
    while (j < n && RE_WORD_CHAR.test(source[j]!)) j++
    return j
  }
  return k
}

/**
 * Walks an interpolation body to its matching closer, masking the literals and
 * comments nested inside it and leaving the rest as code. A closer hidden in a
 * regex literal is tracked when the language sets `regexLiterals` — without
 * that, a `'` or `}` inside the pattern ends the body early and the tail reads
 * as code, which is how `${v.replace(/'/g, …)}` used to blank every brace in
 * the rest of the file.
 */
function maskInterpolationBody(
  ctx: MaskCtx,
  start: number,
  form: { open: string; close: string },
  interp: Interpolation,
): number {
  const { source, n, blank } = ctx
  const opener = NEST_OPENER[form.close] ?? ''
  let k = start
  let depth = 1
  // Same regex-vs-division question as maskCLike, over the body only: a `/`
  // opening the body (`${/re/.test(x)}`) has no predecessor and is a regex.
  let prevCode: string | null = null
  while (k < n) {
    const ch = source[k]!
    if (ch === '"' || ch === "'" || ch === '`') {
      k = maskLiteral(ctx, k, { terminator: ch, escape: '\\', interp })
      prevCode = '"'
      continue
    }
    if (interp.slashComments && ch === '/' && source[k + 1] === '/') {
      while (k < n && source[k] !== '\n') blank(k++)
      continue
    }
    if (interp.slashComments && ch === '/' && source[k + 1] === '*') {
      blank(k++)
      blank(k++)
      while (k < n && !(source[k] === '*' && source[k + 1] === '/')) blank(k++)
      if (k < n) {
        blank(k++)
        blank(k++)
      }
      continue
    }
    if (
      interp.regexLiterals &&
      ch === '/' &&
      regexAllowedAfter(prevCode, source, k)
    ) {
      k = maskRegexLiteral(ctx, k)
      prevCode = '/'
      continue
    }
    if (source.startsWith(form.close, k)) {
      depth--
      if (depth === 0) {
        for (let t = 0; t < form.close.length; t++) blank(k++)
        return k
      }
      k += form.close.length
      prevCode = form.close
      continue
    }
    if (opener && source.startsWith(opener, k)) {
      depth++
      k += opener.length
      prevCode = opener
      continue
    }
    if (!/\s/.test(ch)) prevCode = ch
    k++
  }
  return k
}
/** Valid first character of a heredoc/nowdoc label (never a digit). */
export const RE_IDENT_START = /[A-Za-z_]/
/** Uppercase-or-underscore start — Ruby heredoc-label convention. */
export const RE_UPPER_START = /[A-Z_]/
/** Word character excluding `$` (SQL dollar-quote tag). */
export const RE_WORD_CHAR = /[A-Za-z0-9_]/

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

/**
 * Blanks one regex literal — the `/` at `start` through its closing unescaped
 * `/` and any flags — and returns the index past it. A `/` inside a `[…]`
 * character class does not close it. An unterminated pattern stops at the
 * newline, leaving the rest of the line as code.
 *
 * Shared by maskCLike and maskInterpolationBody so a regex reads the same way
 * at top level and inside `${…}`.
 */
function maskRegexLiteral(ctx: MaskCtx, start: number): number {
  const { source, n, blank } = ctx
  let i = start
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
  return i
}

/**
 * True when the `'` at `quoteIdx` closes a word instead of opening a string.
 *
 * JSX prose is scanned as code, so `<Text>Yes, and don't ask again</Text>`
 * otherwise opens a literal that runs to the next apostrophe anywhere in the
 * file, blanking every brace in between — enough to unbalance the file and
 * make the scan fail open with no symbols at all.
 *
 * Deliberately NOT `regexAllowedAfter`: that one skips whitespace and treats
 * `>` as "not a literal position", which would turn `a > 'b'` into code. Here
 * the identifier char must be IMMEDIATELY before the quote — `return 'x'`,
 * `f('a')` and `a > 'b'` all keep their separator and stay strings — and must
 * not spell a keyword, which covers the legal-but-never-written `case'a':`
 * and `typeof'x'`.
 */
function isContractionApostrophe(source: string, quoteIdx: number): boolean {
  const prev = source[quoteIdx - 1]
  if (prev === undefined || !RE_IDENT_CHAR.test(prev)) return false
  let j = quoteIdx - 1
  while (j >= 0 && RE_IDENT_CHAR.test(source[j]!)) j--
  return !REGEX_PREV_KEYWORDS.has(source.slice(j + 1, quoteIdx))
}

type CLikeMaskOptions = {
  /** JS regex-literal heuristic. On for TS/JS (and Go, legacy behavior). */
  regexLiterals: boolean
  /**
   * Treat `word'` as a contraction rather than a string opener. On for TS/JS,
   * the only languages here that carry JSX; Go shares the legacy mask and gets
   * no JSX prose, so it stays off there.
   */
  contractionApostrophes: boolean
  /**
   * Triple-quoted forms. `escapes: false` is a raw block (Java text block,
   * Kotlin and C# raw strings) where `\` is literal — a text block holding an
   * escaped `\"""` closes early here, which fail-open covers. Dart and Groovy
   * take both quote characters and do process escapes.
   */
  tripleQuotes: ReadonlyArray<{ quote: string; escapes: boolean }>
  /** C# verbatim strings — `@"..."` / `$@"..."` with doubled-quote escapes. */
  verbatimStrings: boolean
}

const NO_TRIPLE_QUOTES: CLikeMaskOptions['tripleQuotes'] = []
const RAW_TRIPLE_DOUBLE: CLikeMaskOptions['tripleQuotes'] = [
  { quote: '"', escapes: false },
]
const ESCAPED_TRIPLE_BOTH: CLikeMaskOptions['tripleQuotes'] = [
  { quote: '"', escapes: true },
  { quote: "'", escapes: true },
]

export const MASK_OPTS_LEGACY: CLikeMaskOptions = {
  regexLiterals: true,
  contractionApostrophes: false,
  tripleQuotes: NO_TRIPLE_QUOTES,
  verbatimStrings: false,
}
// TS/JS: the legacy mask plus the JSX contraction guard. Go shares LEGACY and
// keeps the guard off — not because a rune literal would break under it (the
// guard needs an identifier char glued to the quote, and `ident'` is not valid
// Go, so it can never fire there) but because the option should name the
// languages that actually carry JSX. A regression test for Go was written and
// then deleted: it passed with the flag forced ON, so it guarded nothing.
export const MASK_OPTS_TSJS: CLikeMaskOptions = {
  regexLiterals: true,
  contractionApostrophes: true,
  tripleQuotes: NO_TRIPLE_QUOTES,
  verbatimStrings: false,
}
export const MASK_OPTS_JVM: CLikeMaskOptions = {
  regexLiterals: false,
  contractionApostrophes: false,
  tripleQuotes: RAW_TRIPLE_DOUBLE,
  verbatimStrings: false,
}
export const MASK_OPTS_CSHARP: CLikeMaskOptions = {
  regexLiterals: false,
  contractionApostrophes: false,
  tripleQuotes: RAW_TRIPLE_DOUBLE,
  verbatimStrings: true,
}
// Plain brace languages with only `//` + `/* */` comments and simple
// single/double-quoted strings — C/C++, Scala, Swift (all use maskJvm's
// triple-quote handling where relevant; C uses the plain variant).
export const MASK_OPTS_PLAIN: CLikeMaskOptions = {
  regexLiterals: false,
  contractionApostrophes: false,
  tripleQuotes: NO_TRIPLE_QUOTES,
  verbatimStrings: false,
}
export const MASK_OPTS_DART: CLikeMaskOptions = {
  regexLiterals: false,
  contractionApostrophes: false,
  tripleQuotes: ESCAPED_TRIPLE_BOTH,
  verbatimStrings: false,
}
// A Groovy slashy string `/…/` occupies the same syntactic slot as a regex
// literal, so the same heuristic masks it.
export const MASK_OPTS_GROOVY: CLikeMaskOptions = {
  regexLiterals: true,
  contractionApostrophes: false,
  tripleQuotes: ESCAPED_TRIPLE_BOTH,
  verbatimStrings: false,
}

export function maskCLike(
  source: string,
  opts: CLikeMaskOptions,
  interp?: Interpolation | null,
): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  // Last significant (non-whitespace, non-comment) code char seen — drives
  // the regex-vs-division decision.
  let prevCode: string | null = null
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  const ctx: MaskCtx = { source, n, blank }

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
    const triple =
      c === c2 && source[i + 2] === c
        ? opts.tripleQuotes.find(t => t.quote === c)
        : undefined
    if (triple) {
      i = maskLiteral(ctx, i, {
        terminator: triple.quote.repeat(3),
        escape: triple.escapes ? '\\' : null,
        interp,
      })
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
      i = maskLiteral(ctx, i, {
        terminator: '"',
        escape: null,
        doubledTerminatorIsEscape: true,
        interp,
      })
      prevCode = '"'
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      if (
        c === "'" &&
        opts.contractionApostrophes &&
        isContractionApostrophe(source, i)
      ) {
        // Not a delimiter — leave it as code and keep walking.
        prevCode = c
        i++
        continue
      }
      i = maskLiteral(ctx, i, { terminator: c, escape: '\\', interp })
      // A string/template is a value — a following `/` is division.
      prevCode = '"'
      continue
    }
    if (c === '/' && opts.regexLiterals && regexAllowedAfter(prevCode, source, i)) {
      i = maskRegexLiteral(ctx, i)
      prevCode = '/'
      continue
    }
    if (!/\s/.test(c!)) prevCode = c!
    i++
  }
  return out.join('')
}
