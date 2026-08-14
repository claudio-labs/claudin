// SQL scanner — top-level CREATE statements, plus its own masker.

import {
  capSignature,
  RE_WS_RUN,
} from 'src/tools/shared/codeOutline/internal.js'
import {
  RE_IDENT_CHAR,
  RE_WORD_CHAR,
} from 'src/tools/shared/codeOutline/mask/core.js'
import type {
  SymbolEntry,
  SymbolKind,
} from 'src/tools/shared/codeOutline/types.js'

const RE_SQL_CREATE =
  /^create\s+(?:or\s+replace\s+)?(?:global\s+|local\s+)?(?:temp(?:orary)?\s+|unique\s+|clustered\s+|nonclustered\s+)?(materialized\s+view|table|view|function|procedure|proc|trigger|index|type|sequence)\s+(?:if\s+not\s+exists\s+)?([`"[\]\w.$]+)/i
const RE_SQL_NAME_STRIP = /[`"[\]]/g
const SQL_KIND: Record<string, SymbolKind> = {
  table: 'table',
  view: 'view',
  'materialized view': 'view',
  trigger: 'trigger',
  function: 'function',
  procedure: 'function',
  proc: 'function',
  index: 'const',
  type: 'type',
  sequence: 'const',
}

export function maskSql(source: string): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  while (i < n) {
    const c = source[i]
    const c2 = source[i + 1]
    if (c === '-' && c2 === '-') {
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
    // Dollar-quoted string (`$$ … $$`, `$body$ … $body$`). The tag is
    // word-chars only — RE_IDENT_CHAR would wrongly swallow the closing `$`.
    if (c === '$') {
      let j = i + 1
      while (j < n && RE_WORD_CHAR.test(source[j]!)) j++
      if (source[j] === '$') {
        const tag = source.slice(i, j + 1) // `$tag$`
        let k = j + 1
        while (k < n && !source.startsWith(tag, k)) k++
        const end = k < n ? k + tag.length : n
        while (i < end) blank(i++)
        continue
      }
    }
    // `'…'` string / `` `…` `` MySQL identifier — masked so their `;`/`(`
    // don't confuse bounds. Double-quoted `"…"` is a delimited IDENTIFIER in
    // standard SQL (it can name the CREATE target), so it is left visible.
    if (c === "'" || c === '`') {
      const quote = c
      blank(i++)
      while (i < n) {
        if (source[i] === quote) {
          if (source[i + 1] === quote) {
            // Doubled quote — an escaped quote, not a terminator.
            blank(i++)
            blank(i++)
            continue
          }
          blank(i++)
          break
        }
        blank(i++)
      }
      continue
    }
    i++
  }
  return out.join('')
}

export function scanSql(source: string): SymbolEntry[] {
  const lines = source.split('\n')
  const masked = maskSql(source).split('\n')
  const results: SymbolEntry[] = []

  for (let L = 0; L < lines.length; L++) {
    const t = masked[L]!.trim()
    if (!t) continue
    const m = RE_SQL_CREATE.exec(t)
    if (!m) continue
    const keyword = m[1]!.toLowerCase().replace(RE_WS_RUN, ' ')
    const kind = SQL_KIND[keyword] ?? 'const'
    const name = m[2]!.replace(RE_SQL_NAME_STRIP, '')

    // The statement ends at the first `;` outside parentheses. Function /
    // procedure bodies with inner `;` end early — a best-effort bound.
    let end = L
    let paren = 0
    outer: for (let i = L; i < lines.length; i++) {
      const ml = masked[i]!
      for (let k = 0; k < ml.length; k++) {
        const ch = ml[k]
        if (ch === '(') paren++
        else if (ch === ')') paren--
        else if (ch === ';' && paren <= 0) {
          end = i
          break outer
        }
      }
      end = i
    }

    results.push({
      name,
      kind,
      signature: capSignature(lines[L]!, ';'),
      startLine: L + 1,
      endLine: end + 1,
      depth: 0,
    })
  }

  return results
}
