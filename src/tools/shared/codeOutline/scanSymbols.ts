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
// Two strategies:
//   C-like (TS/JS/Go): brace-depth counting on a string/comment-masked copy.
//   Python:            indentation tracking on a masked copy.
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

export type OutlineLang = 'typescript' | 'javascript' | 'python' | 'go'

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

/** Scans a source file and returns its ordered symbol table. */
export function scanSymbols(source: string, lang: OutlineLang): SymbolEntry[] {
  try {
    if (!source) return []
    return lang === 'python'
      ? scanPython(source)
      : scanCLike(source, lang)
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

function maskCLike(source: string): string {
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
    if (c === '/' && regexAllowedAfter(prevCode, source, i)) {
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

// ---------------------------------------------------------------------------
// C-like scanner (TS / JS / Go)
// ---------------------------------------------------------------------------

type Candidate = {
  line: number // 0-indexed
  depth: number
  name: string
  kind: SymbolKind
  isMethod: boolean
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

function detectCLike(
  trimmed: string,
  lang: OutlineLang,
  depth: number,
): Omit<Candidate, 'line' | 'depth'> | null {
  if (lang === 'go') {
    let m = RE_GO_FUNC.exec(trimmed)
    if (m) return { name: m[1]!, kind: 'function', isMethod: false }
    m = RE_GO_TYPE.exec(trimmed)
    if (m) {
      const kind: SymbolKind = /\bstruct\b/.test(trimmed) ? 'struct' : 'type'
      return { name: m[1]!, kind, isMethod: false }
    }
    return null
  }

  // TS / JS — only top-level declarations belong in an outline. A function,
  // class, type, etc. nested inside another body is noise; class methods are
  // handled separately below via the depth >= 1 branch.
  let m: RegExpExecArray | null
  if (depth === 0) {
    m = RE_CLASS.exec(trimmed)
    if (m) return { name: m[1]!, kind: 'class', isMethod: false }
    m = RE_FUNCTION.exec(trimmed)
    if (m) return { name: m[1]!, kind: 'function', isMethod: false }
    m = RE_INTERFACE.exec(trimmed)
    if (m) return { name: m[1]!, kind: 'interface', isMethod: false }
    m = RE_ENUM.exec(trimmed)
    if (m) return { name: m[1]!, kind: 'enum', isMethod: false }
    m = RE_TYPE.exec(trimmed)
    if (m) return { name: m[1]!, kind: 'type', isMethod: false }
    m = RE_CONST.exec(trimmed)
    if (m) return { name: m[1]!, kind: 'const', isMethod: false }
  }

  // Methods are only meaningful one level inside a container.
  if (depth >= 1) {
    m = RE_METHOD.exec(trimmed)
    if (m && !isControlKeyword(m[1]!)) {
      return { name: m[1]!, kind: 'method', isMethod: true }
    }
    m = RE_METHOD_ARROW.exec(trimmed)
    if (m) return { name: m[1]!, kind: 'method', isMethod: true }
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

function scanCLike(source: string, lang: OutlineLang): SymbolEntry[] {
  const lines = source.split('\n')
  const masked = maskCLike(source).split('\n')

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

  // Pass 1 — collect declaration candidates.
  const candidates: Candidate[] = []
  for (let L = 0; L < lines.length; L++) {
    const trimmed = lines[L]!.trim()
    if (!trimmed) continue
    const d = depthBefore[L]!
    const hit = detectCLike(trimmed, lang, d)
    if (hit) {
      candidates.push({ line: L, depth: d, ...hit })
    }
  }

  // Pass 2 — resolve bounds and keep only valid symbols.
  const resolved: Array<SymbolEntry & { _isMethod: boolean }> = []
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
    // A method candidate without a real body is a property/false match.
    if (c.isMethod && !opened) continue
    const doc = findDocLineCLike(lines, c.line)
    resolved.push({
      name: c.name,
      kind: c.kind,
      signature: trimSignature(lines[c.line]!),
      startLine: c.line + 1,
      endLine: endLine + 1,
      depth: c.depth,
      _isMethod: c.isMethod,
      ...(doc !== undefined && { docLine: doc + 1 }),
    })
  }

  // A method is only kept when its nearest enclosing symbol is a class.
  const kept = resolved.filter(s => {
    if (!s._isMethod) return true
    const parent = nearestEnclosing(resolved, s)
    return parent !== null && parent.kind === 'class'
  })

  return kept
    .map(({ _isMethod, ...rest }) => rest)
    .sort((a, b) => a.startLine - b.startLine)
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

function findDocLineCLike(lines: string[], start: number): number | undefined {
  let i = start - 1
  let doc: number | undefined
  while (i >= 0) {
    const t = lines[i]!.trim()
    if (t === '') break
    if (RE_DOC_LINE.test(t)) {
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
