// The C-like scanning engine — brace-depth counting over a masked copy,
// driven by a CLikeSpec. Language-specific behavior lives in ./detectors.ts
// and ./specs.ts; nothing here knows a language name.

import {
  nearestEnclosing,
  trimSignature,
} from 'src/tools/shared/codeOutline/internal.js'
import type { Interpolation } from 'src/tools/shared/codeOutline/mask/core.js'
import type {
  Candidate,
  CLikeSpec,
} from 'src/tools/shared/codeOutline/clike/types.js'
import type { SymbolEntry } from 'src/tools/shared/codeOutline/types.js'

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

/**
 * `interp` is not optional in spirit — pass the language's entry from
 * INTERPOLATION. Without it a template literal that nests another one inside
 * `${…}` terminates at the INNER backtick, and the tail of the outer literal
 * is counted as code: one leaked `}` pops the top-level frame and the whole
 * file fails open at the balance gate below. Measured on src/tools/GitTool/
 * run.ts, whose masked copy carried 67 `{` against 66 `}` without it and
 * 69/69 with it. The interpolation delimiters themselves are still blanked as
 * punctuation (see maskLiteral), so brace-depth math is otherwise unchanged.
 */
export function scanCLike(
  source: string,
  spec: CLikeSpec,
  interp?: Interpolation | null,
): SymbolEntry[] {
  const lines = source.split('\n')
  const masked = spec.mask(source, interp).split('\n')

  // Per-line brace depth: depth at line start, line end, and peak within line.
  const depthBefore: number[] = []
  const depthAfter: number[] = []
  const maxDepth: number[] = []
  // The innermost unclosed grouping character at each line's START. `(` or `[`
  // means the line continues an expression, where no declaration can begin;
  // `{` or none means a declaration is legal here. Tracked over the masked
  // copy, so a bracket inside a string never counts.
  const groupAtLineStart: Array<string | undefined> = []
  const groupStack: string[] = []
  // Whether the group stack can be trusted at all. A mask defect — a backtick
  // inside a regex character class starts a phantom template literal and
  // blanks the rest of the file (axios' AxiosHeaders.js, line 32) — leaves
  // brackets unmatched, and every later line then looks like it sits inside an
  // expression. Rather than drop 33 real declarations from that one file, the
  // paren filter switches itself off when the brackets do not balance. Same
  // fail-open contract as the brace-depth check below.
  let groupsBalanced = true
  let depth = 0
  for (const ml of masked) {
    depthBefore.push(depth)
    groupAtLineStart.push(groupStack[groupStack.length - 1])
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
      if (ch === '{' || ch === '(' || ch === '[') groupStack.push(ch)
      else if (ch === '}' || ch === ')' || ch === ']') {
        const want = ch === '}' ? '{' : ch === ')' ? '(' : '['
        if (groupStack.pop() !== want) groupsBalanced = false
      }
    }
    depthAfter.push(depth)
    maxDepth.push(peak)
  }
  if (depth !== 0) return [] // unbalanced — fail open
  if (groupStack.length > 0) groupsBalanced = false

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
    if (spec.rejectInsideParens && groupsBalanced) {
      const group = groupAtLineStart[L]
      if (group === '(' || group === '[') continue
    }
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
    // A landmark's body is its initializer, so it opens on the declaration's
    // own line. Checked on the masked copy, so a brace inside a string or a
    // trailing comment does not count.
    if (c.bodyOnOwnLine && !masked[c.line]!.includes('{')) continue
    // `declShape` only refines the question "does this really have a body?",
    // so it never applies to a detection that says a body is optional — a C#
    // expression-bodied member (`int X() => expr;`) is a real declaration that
    // opens no brace, and the shape scan would drop it at the `;`.
    if (c.declShape && c.requiresBody) {
      // Shape-verified path: find the body brace ourselves instead of
      // inheriting whatever brace happens to open next, and derive the end
      // from that brace. Deliberately does NOT consult `nextLine` — a
      // multi-line signature may legitimately contain a candidate-looking
      // line, and stopping there is what suppressed real declarations.
      const bodyLine = findDeclBodyOpen(c.line, masked)
      if (bodyLine < 0) continue
      const doc = findDocLineCLike(lines, c.line, spec.docPrefixes)
      resolved.push({
        name: c.name,
        kind: c.kind,
        signature: trimSignature(lines[c.line]!),
        startLine: c.line + 1,
        endLine: resolveBodyEnd(bodyLine, c.depth, lines.length, depthAfter) + 1,
        depth: c.depth,
        ...(doc !== undefined && { docLine: doc + 1 }),
      })
      continue
    }
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
  // kind for this language (TS: class/const; Java: class/interface/enum/record;
  // Rust: impl/trait; …). strictMethodDepth additionally pins the method to
  // exactly one brace level inside that container.
  const withMethods = resolved.filter(s => {
    if (s.kind !== 'method') return true
    const parent = nearestEnclosing(resolved, s)
    if (parent === null || !spec.methodContainers.has(parent.kind)) {
      return false
    }
    return !spec.strictMethodDepth || s.depth === parent.depth + 1
  })

  // Then the landmarks, over what SURVIVED the method filter — a landmark's
  // enclosing symbol has to be one the reader will actually see, and a
  // discarded method sitting between it and the real container would otherwise
  // be measured as its parent.
  //
  // A nested non-method survives only where the spec asks for landmarks. Every
  // other language reaches this with `nestedLandmarks` absent, so its inner
  // types (a Java static nested class, a Rust `mod`) are kept exactly as
  // before.
  const landmarks = spec.nestedLandmarks
  const kept = landmarks
    ? withMethods.filter(s => {
        if (s.kind === 'method' || s.depth === 0) return true
        if (s.endLine - s.startLine + 1 < landmarks.minBodyLines) return false
        const container = nearestEnclosing(withMethods, s)
        if (container === null) return false
        return (
          container.endLine - container.startLine + 1 >=
          landmarks.minParentLines
        )
      })
    : withMethods

  return kept.sort((a, b) => a.startLine - b.startLine)
}

// How far past the declaration to look for a body `{` before concluding the
// declaration has none. Multi-line signatures rarely exceed this.
const NOBODY_LOOKAHEAD = 100

/**
 * How many lines past the closing `)` of a parameter list the body `{` may
 * still appear on. 0 is same-line (`foo() {`), 1 covers Allman bracing and a
 * `throws A, B` / `where T : new()` tail on its own line. Past that, a brace
 * belongs to something else.
 */
const DECL_BODY_MAX_GAP = 2

/**
 * The line where a declaration's body `{` opens, or -1 when the line does not
 * have declaration shape at all.
 *
 * Walks the masked source forward from the candidate's own `(` — skipping its
 * name, which may itself carry brackets — and asks two questions in order:
 * does a parameter list close here, and does a body brace follow it closely?
 *
 *   `)` taking depth below 0   a group opened BEFORE this line closed here, so
 *                              the line was a continuation — the last condition
 *                              of a multi-line `if (`, which is the shape that
 *                              produced a phantom in GrepTool.ts:617
 *                              (defense in depth: a line that can underflow
 *                              began inside a paren, so `rejectInsideParens`
 *                              normally drops it first. This test is what
 *                              covers the file where that filter switched
 *                              itself off — see `groupsBalanced`.)
 *   `{` at paren depth 0       the body
 *   `;` at paren depth 0       a declaration with no body, or a statement
 *   more than DECL_BODY_MAX_GAP lines past the close, with no brace — whatever
 *   opens later is not this line's body
 *
 * The gap is measured from the LAST return to paren depth 0, not the first. A
 * A paren group opening AFTER the parameter list has closed is fine: a C#
 * constructor chains through one before its body —
 * `public BsonReader(Stream stream)\n  : this(stream, false, …)\n{`. An earlier
 * version refused that outright and threw away every such constructor in
 * Newtonsoft.Json. The gap is still measured from the FIRST return to depth 0,
 * though, because re-arming it on every later close lets a RUN of call
 * statements chain: `doThing(0)` closes, the next line closes again, and sixty
 * lines later a `for (…) {` supplies a body for all of them. Those phantoms are
 * filtered out for having a method parent, but they linger in the resolved set
 * long enough to be found as a landmark's enclosing symbol. Measured over the
 * whole bench corpus, first-close versus last-close moves exactly one symbol.
 *
 * Braces inside the parameter list (`foo(opts = {}) {`) sit at paren depth > 0
 * and are skipped, which is why the depth test comes before the brace test.
 *
 * A comma is deliberately NOT a terminator, and two corpus files are why. An
 * earlier version treated one at paren depth 0 as the end of a statement,
 * which cost six real `JObject` members in Newtonsoft.Json (the commas inside
 * a C# explicit interface implementation's own name,
 * `void ICollection<KeyValuePair<string, JToken?>>.Add(…)`) and every
 * `public <T> T fromJson(Reader json, Class<T> classOfT)\n throws A, B {` in
 * Gson. After the parameter list closes, a comma in the tail is ordinary; the
 * gap bound is what ends the search instead.
 *
 * The parameter list must open on the candidate's own line IN THE MASKED COPY.
 * TS/JS detect on the RAW line (`detectSource: 'raw'`, legacy behavior), so a
 * doc comment mentioning `forceRedraw()` matches the method regex — `RE_METHOD`
 * even tolerates the leading `*` of a comment line. The masked copy has no
 * parenthesis there, which is exactly how a comment is told from code. Without
 * this test the scan walked out of the comment and adopted the NEXT method's
 * body; that phantom then became the enclosing symbol and filtered the real
 * method out of the table (`ink.tsx`, `prepareFullRepaint`).
 */
function findDeclBodyOpen(start: number, masked: string[]): number {
  const limit = Math.min(masked.length, start + NOBODY_LOOKAHEAD)
  const firstParen = masked[start]!.indexOf('(')
  if (firstParen < 0) return -1
  let paren = 0
  let closedLine = -1
  for (let i = start; i < limit; i++) {
    if (closedLine >= 0 && i - closedLine > DECL_BODY_MAX_GAP) return -1
    const ml = masked[i]!
    for (let k = i === start ? firstParen : 0; k < ml.length; k++) {
      const ch = ml[k]
      if (ch === '(') {
        paren++
        continue
      }
      if (ch === ')') {
        paren--
        if (paren < 0) return -1
        if (paren === 0 && closedLine < 0) closedLine = i
        continue
      }
      if (paren > 0) continue
      if (ch === '{') return i
      if (ch === ';') return -1
    }
  }
  return -1
}

/** The line whose end returns brace depth to `d` — the body's closing `}`. */
function resolveBodyEnd(
  bodyLine: number,
  d: number,
  lineCount: number,
  depthAfter: number[],
): number {
  for (let i = bodyLine; i < lineCount; i++) {
    if (depthAfter[i]! <= d) return i
  }
  return lineCount - 1
}

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

export function findDocLineCLike(
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
