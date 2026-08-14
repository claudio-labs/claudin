// Terraform/HCL — mask + detect, plugged into CLIKE_SPECS.

import { RE_WORD_CHAR } from 'src/tools/shared/codeOutline/mask/core.js'
import type { CLikeDetection } from 'src/tools/shared/codeOutline/clike/types.js'
import type { SymbolKind } from 'src/tools/shared/codeOutline/types.js'


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

export function maskTerraform(source: string): string {
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

export function detectTerraform(trimmed: string, depth: number): CLikeDetection | null {
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
