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
  // kind for this language (TS: class/const; Java: class/interface/enum/record;
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
