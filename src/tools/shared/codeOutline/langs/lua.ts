// Lua scanner — keyword/`end` block tracking, plus its own masker.

import {
  capSignature,
  type BlockFrame,
} from 'src/tools/shared/codeOutline/internal.js'
import { findDocLineCLike } from 'src/tools/shared/codeOutline/clike/scan.js'
import type { SymbolEntry } from 'src/tools/shared/codeOutline/types.js'

const RE_LUA_FUNCTION = /^(?:local\s+)?function\s+([A-Za-z_][\w.:]*)/
const RE_LUA_ASSIGN_FUNCTION =
  /^(?:local\s+)?([A-Za-z_][\w.:]*)\s*=\s*function\b/
const RE_LUA_FUNCTION_KW = /\bfunction\b/g
const RE_LUA_END = /\bend\b/g
const RE_LUA_UNTIL = /\buntil\b/g
/** Block openers counted anywhere on the line: `while`/`for` are announced by
 * their `do`, `if` by itself (`elseif` has no word boundary before `if`, so it
 * doesn't re-open), `repeat` closes on `until`. Counting these plus `function`
 * stays balanced with the anywhere-counted `end`/`until` closers even for
 * mid-line openers (`x = 1; if y then`). */
const RE_LUA_BLOCK_KW = /\b(?:if|do|repeat)\b/g

/** Long-bracket level at `[` (`[[`→0, `[==[`→2), or -1 when not one. */
function luaLongBracketLevel(source: string, start: number): number {
  if (source[start] !== '[') return -1
  let j = start + 1
  let eq = 0
  while (source[j] === '=') {
    eq++
    j++
  }
  return source[j] === '[' ? eq : -1
}

export function maskLua(source: string): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  const blankLong = (level: number) => {
    const closer = ']' + '='.repeat(level) + ']'
    while (i < n && !source.startsWith(closer, i)) blank(i++)
    for (let k = 0; k < closer.length && i < n; k++) blank(i++)
  }
  while (i < n) {
    const c = source[i]
    const c2 = source[i + 1]
    if (c === '-' && c2 === '-') {
      const level = source[i + 2] === '[' ? luaLongBracketLevel(source, i + 2) : -1
      if (level >= 0) {
        blank(i++)
        blank(i++)
        blankLong(level)
      } else {
        while (i < n && source[i] !== '\n') blank(i++)
      }
      continue
    }
    if (c === '[') {
      const level = luaLongBracketLevel(source, i)
      if (level >= 0) {
        blankLong(level)
        continue
      }
    }
    if (c === '"' || c === "'") {
      const quote = c
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
      continue
    }
    i++
  }
  return out.join('')
}

/** Last dotted/colon segment of a Lua function path (`T:m` → `m`). */
function luaLastSegment(path: string): string {
  const dot = path.lastIndexOf('.')
  const colon = path.lastIndexOf(':')
  const cut = Math.max(dot, colon)
  return cut >= 0 ? path.slice(cut + 1) : path
}

export function scanLua(source: string): SymbolEntry[] {
  const lines = source.split('\n')
  const masked = maskLua(source).split('\n')
  const results: SymbolEntry[] = []
  const stack: BlockFrame[] = []
  const symbolDepth = () =>
    stack.reduce((d, f) => d + (f.entryIndex !== null ? 1 : 0), 0)

  for (let L = 0; L < lines.length; L++) {
    const t = masked[L]!.trim()
    if (!t) continue

    let symbolName: string | null = null
    let m = RE_LUA_FUNCTION.exec(t)
    if (m) symbolName = luaLastSegment(m[1]!)
    else {
      m = RE_LUA_ASSIGN_FUNCTION.exec(t)
      if (m) symbolName = luaLastSegment(m[1]!)
    }

    const totalOpens =
      (t.match(RE_LUA_FUNCTION_KW) ?? []).length +
      (t.match(RE_LUA_BLOCK_KW) ?? []).length

    if (symbolName) {
      const d = symbolDepth()
      const doc = findDocLineCLike(lines, L, ['-'])
      results.push({
        name: symbolName,
        kind: 'function',
        signature: capSignature(lines[L]!),
        startLine: L + 1,
        endLine: L + 1,
        depth: d,
        ...(doc !== undefined && { docLine: doc + 1 }),
      })
    }
    const symbolEntryIndex = symbolName ? results.length - 1 : null

    for (let k = 0; k < totalOpens; k++) {
      stack.push({ entryIndex: k === 0 ? symbolEntryIndex : null })
    }

    const closes =
      (t.match(RE_LUA_END) ?? []).length + (t.match(RE_LUA_UNTIL) ?? []).length
    for (let e = 0; e < closes; e++) {
      const frame = stack.pop()
      if (!frame) return []
      if (frame.entryIndex !== null) results[frame.entryIndex]!.endLine = L + 1
    }
  }

  if (stack.length !== 0) return []
  return results.sort((a, b) => a.startLine - b.startLine)
}
