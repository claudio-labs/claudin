// Ruby scanner — keyword/`end` block tracking, plus its own masker.

import {
  capSignature,
  type BlockFrame,
} from 'src/tools/shared/codeOutline/internal.js'
import { findDocLineCLike } from 'src/tools/shared/codeOutline/clike/scan.js'
import {
  maskLiteral,
  RE_IDENT_CHAR,
  RE_IDENT_START,
  RE_UPPER_START,
  type Interpolation,
  type MaskCtx,
} from 'src/tools/shared/codeOutline/mask/core.js'
import type { SymbolEntry } from 'src/tools/shared/codeOutline/types.js'

const RE_FIRST_WORD = /^([A-Za-z_]\w*)/

// ---------------------------------------------------------------------------
// Ruby scanner — keyword/`end` block tracking
// ---------------------------------------------------------------------------

const RE_RUBY_DEF = /^def\s+(?:self\.|[A-Za-z_]\w*\.)?([A-Za-z_]\w*[?!=]?)/
/** Ruby 3 endless method — `def name(args) = expr` / `def name = expr`. The
 * `(?=\s)` alternative keeps setter defs (`def value=(v)`), where `=` is part
 * of the method name, on the normal `end`-terminated path. */
const RE_RUBY_ENDLESS_DEF =
  /^def\s+(?:self\.|[A-Za-z_]\w*\.)?[A-Za-z_]\w*[?!]?(?:\s*\([^)]*\)|(?=\s))\s*=(?![=~>])/
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
export function maskRuby(source: string, interp?: Interpolation | null): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  const ctx: MaskCtx = { source, n, blank }
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
      i = maskLiteral(ctx, i, { terminator: c, escape: '\\', interp })
      continue
    }
    i++
  }
  return out.join('')
}

export function scanRuby(source: string): SymbolEntry[] {
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
      // Endless methods have no `end` — opening a frame would imbalance the
      // stack and discard the whole outline at EOF.
      opened = !RE_RUBY_ENDLESS_DEF.test(t)
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
