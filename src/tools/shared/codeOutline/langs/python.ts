// Python scanner — indentation based.

import {
  leadingIndent,
  MAX_SIGNATURE_CHARS,
} from 'src/tools/shared/codeOutline/internal.js'
import { maskPython } from 'src/tools/shared/codeOutline/mask/languages.js'
import type {
  SymbolEntry,
  SymbolKind,
} from 'src/tools/shared/codeOutline/types.js'

const RE_PY_DEF = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/
const RE_PY_CLASS = /^class\s+([A-Za-z_]\w*)/


export function scanPython(source: string): SymbolEntry[] {
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
