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

// Indices at or after `startIndex` whose line CONTAINS `needle` (both trimmed).
// Used only to rescue an `@@` anchor a model truncated to a fragment of the real
// line — that anchor is a search cursor, so a looser match costs little, but the
// caller must require a UNIQUE hit before trusting it.
export function findContaining(
  lines: string[],
  needle: string,
  startIndex: number,
): number[] {
  const found: number[] = []
  const trimmed = needle.trim()
  if (trimmed === '') return found
  for (let i = Math.max(0, startIndex); i < lines.length; i++) {
    if (lines[i].trim().includes(trimmed)) found.push(i)
  }
  return found
}

export interface PartialMatch {
  /** Start index in `lines` of the longest matching prefix. */
  index: number
  /** How many leading `pattern` lines matched there (always >= 1). */
  matched: number
}

// Where the longest PREFIX of `pattern` matches, under the loosest comparator in
// the ladder. Diagnostic only: it turns "your block was not found" into "your
// line N is where it stopped matching, and here is what the file has there".
// Returns null when not even the first line matches anywhere.
export function bestPartialMatch(
  lines: string[],
  pattern: string[],
  startIndex: number,
): PartialMatch | null {
  if (pattern.length === 0) return null
  let best: PartialMatch | null = null
  for (let i = Math.max(0, startIndex); i < lines.length; i++) {
    let matched = 0
    while (
      matched < pattern.length &&
      i + matched < lines.length &&
      normalizeUnicodeMatch(lines[i + matched], pattern[matched])
    ) {
      matched++
    }
    if (matched > 0 && (best === null || matched > best.matched)) {
      best = { index: i, matched }
    }
  }
  return best
}
