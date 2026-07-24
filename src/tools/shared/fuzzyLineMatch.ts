// Shared line-based fuzzy matcher. Extracted from the Codex `apply_patch`
// applier (src/tools/ApplyPatchTool/patchFormat.ts) so FileEditTool can reuse
// the SAME whitespace/Unicode-tolerant ladder instead of a second copy.
//
// A `Comparator` decides whether two lines are "the same" at a given strictness.
// `SEEK_PASSES` runs them in order of DECREASING strictness so the tightest
// match that exists always wins the anchor.

export type Comparator = (a: string, b: string) => boolean

// Normalize Unicode punctuation to ASCII equivalents (matches the Rust/opencode
// normalize_unicode used in the fuzzy pass). Module-level per repo regex rule.
const SINGLE_QUOTE_RE = /[\u2018\u2019\u201A\u201B]/g
const DOUBLE_QUOTE_RE = /[\u201C\u201D\u201E\u201F]/g
const DASH_RE = /[\u2010\u2011\u2012\u2013\u2014\u2015]/g
const ELLIPSIS_RE = /\u2026/g
const NBSP_RE = /\u00A0/g

function normalizeUnicode(str: string): string {
  return str
    .replace(SINGLE_QUOTE_RE, "'")
    .replace(DOUBLE_QUOTE_RE, '"')
    .replace(DASH_RE, '-')
    .replace(ELLIPSIS_RE, '...')
    .replace(NBSP_RE, ' ')
}

// Comparators in order of decreasing strictness. `ignoreTrailingWs` and
// `ignoreSurroundingWs` are exported so the Edit resolver can select a subset
// (it stops at `ignoreSurroundingWs` and never applies Unicode normalization —
// quotes are handled separately there). `SEEK_PASSES` (used only by
// `seekSequence` for ApplyPatch) keeps the full 4-pass ladder.
const exactMatch: Comparator = (a, b) => a === b
export const ignoreTrailingWs: Comparator = (a, b) => a.trimEnd() === b.trimEnd()
export const ignoreSurroundingWs: Comparator = (a, b) => a.trim() === b.trim()
const normalizeUnicodeMatch: Comparator = (a, b) =>
  normalizeUnicode(a.trim()) === normalizeUnicode(b.trim())

const SEEK_PASSES: Comparator[] = [
  exactMatch,
  ignoreTrailingWs,
  ignoreSurroundingWs,
  normalizeUnicodeMatch,
]

function matchesAt(
  lines: string[],
  pattern: string[],
  at: number,
  compare: Comparator,
): boolean {
  for (let j = 0; j < pattern.length; j++) {
    if (!compare(lines[at + j], pattern[j])) return false
  }
  return true
}

function tryMatch(
  lines: string[],
  pattern: string[],
  startIndex: number,
  compare: Comparator,
): number {
  for (let i = startIndex; i <= lines.length - pattern.length; i++) {
    if (matchesAt(lines, pattern, i, compare)) return i
  }
  return -1
}

// All start indices where `pattern` matches under `compare`. Used by callers
// that need to detect ambiguity (more than one candidate region).
export function findAllMatches(
  lines: string[],
  pattern: string[],
  compare: Comparator,
): number[] {
  const found: number[] = []
  if (pattern.length === 0) return found
  for (let i = 0; i <= lines.length - pattern.length; i++) {
    if (matchesAt(lines, pattern, i, compare)) found.push(i)
  }
  return found
}

export function seekSequence(
  lines: string[],
  pattern: string[],
  startIndex: number,
  eof = false,
): number {
  if (pattern.length === 0) return -1

  // EOF anchor: the pattern is pinned to the tail of the file. Probe the tail
  // position with EVERY fuzzy pass before any forward scan, so a trailing line
  // that only matches after whitespace/Unicode normalization still wins the
  // anchor over an earlier line that happens to match exactly. (Previously each
  // pass ran its own tail-check-then-scan in sequence, so Pass 1's exact forward
  // match stole the anchor from a fuzzy tail and the EOF marker was silently
  // ignored whenever the last line carried trailing whitespace.)
  if (eof) {
    const fromEnd = lines.length - pattern.length
    if (fromEnd >= startIndex) {
      for (const compare of SEEK_PASSES) {
        if (matchesAt(lines, pattern, fromEnd, compare)) return fromEnd
      }
    }
  }

  // Forward scan, passes in order of decreasing strictness.
  for (const compare of SEEK_PASSES) {
    const idx = tryMatch(lines, pattern, startIndex, compare)
    if (idx !== -1) return idx
  }

  return -1
}
