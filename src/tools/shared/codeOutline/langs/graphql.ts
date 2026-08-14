// GraphQL — mask + detect, plugged into CLIKE_SPECS.

import type { CLikeDetection } from 'src/tools/shared/codeOutline/clike/types.js'
import type { SymbolKind } from 'src/tools/shared/codeOutline/types.js'


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

export function maskGraphql(source: string): string {
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

export function detectGraphql(trimmed: string, depth: number): CLikeDetection | null {
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
