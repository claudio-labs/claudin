// ---------------------------------------------------------------------------
// renderOutline — turns a symbol table into the model-facing "outline" text
// ---------------------------------------------------------------------------
//
// The output is pre-formatted (no `cat -n` line-number prefixes): a leading
// <system-reminder> that tells the model how to drill in, followed by one
// indented line per symbol: `<start>-<end>  <signature>`.
//
// Auto-cap: a pathological file (generated code, thousands of symbols) could
// itself blow the read cap. If the rendered body would exceed
// OUTLINE_MAX_TOKENS, it is truncated at the last symbol that fits and a
// trailer line reports how many were dropped. The outline is never worse
// than the over-cap error it replaces.
// ---------------------------------------------------------------------------

import type { SymbolEntry } from 'src/tools/shared/codeOutline/scanSymbols.js'

/** Token ceiling for the rendered outline body. */
export const OUTLINE_MAX_TOKENS = 10_000

/**
 * Below this many lines the coverage line is not worth its ~20 tokens: a
 * 60-line file's outline is small enough to take in whole, and on the bench
 * corpus the note alone was +20% of a short JavaScript outline's bytes. It
 * still prints for a short file whose single symbol dominates it, which is the
 * shape the note exists to flag.
 */
const COVERAGE_NOTE_MIN_LINES = 200
const COVERAGE_NOTE_DOMINANT_PCT = 50

// Bytes per token. The auto-cap is an internal safety guard, not user-facing
// precision — a coarse 4 bytes/token heuristic keeps this module free of the
// provider/tokenizer dependency chain.
const BYTES_PER_TOKEN = 4

function estimateTokens(text: string): number {
  return Math.ceil(text.length / BYTES_PER_TOKEN)
}

/**
 * Why an outline is being served — selects the header lead.
 *
 * `overcap` is the ONLY value allowed to claim a cap was hit: it is reached
 * exclusively from the `catch` around readFileInRange/validateContentTokens,
 * so a real FileTooLargeError or MaxFileReadTokenExceededError has already
 * been thrown. Nothing enforces that but convention, so keep it that way.
 *
 * `pivot` withholds the body by policy (the file merely crossed the
 * auto-outline threshold). `explicit` is the neutral lead — the caller asked
 * for `view: 'outline'`, or, at the clip-pin sticky-outline site, no lead
 * about size or caps would be true either.
 *
 * Neither of those exceeded anything, and saying they did told the model the
 * body was out of reach when `view: 'full'`, `offset/limit` or `symbol`
 * returns it. (A *plain* re-read pivots again — the trigger is deterministic
 * — so the cap wording was wrong about the reason, not about the repeat.)
 */
export type OutlineReason = 'explicit' | 'overcap' | 'pivot'

export type RenderOutlineOptions = {
  /** Why the outline is being served. Defaults to `explicit`. */
  reason?: OutlineReason
  /**
   * true when the symbol scan only saw the head of the file (it exceeds the
   * 10 MB scan cap). The header states this so the outline never silently
   * pretends to be complete.
   */
  truncated?: boolean
}

/**
 * The `start-end` line-range label an outline row carries. Exported so other
 * views of the same symbol table (the Rename preview) address a symbol exactly
 * the way the outline does.
 */
export function rangeLabel(entry: SymbolEntry): string {
  return `${entry.startLine}-${entry.endLine}`
}

/**
 * How much of the file the symbol table actually accounts for: the share of
 * lines inside at least one symbol range (a UNION — nested ranges must not
 * count twice), and the share taken by the single largest symbol.
 *
 * Both numbers ride in the header because a symbol COUNT does not say whether
 * an outline is a usable index. `PromptInput.tsx` was served as five
 * signatures for 2,591 lines, one of them spanning 91% of the file: it clears
 * any count-based gate and tells the reader nothing about where anything is.
 * With the numbers stated, `offset/limit` is an informed choice instead of a
 * guess.
 */
export function outlineCoverage(
  entries: SymbolEntry[],
  totalLines: number,
): { coveredPct: number; largestPct: number } {
  if (entries.length === 0 || totalLines <= 0) {
    return { coveredPct: 0, largestPct: 0 }
  }
  const ranges = entries
    .map(e => [e.startLine, e.endLine] as const)
    .sort((a, b) => a[0] - b[0])
  let covered = 0
  let largest = 0
  let curStart = ranges[0]![0]
  let curEnd = ranges[0]![1]
  for (const [s, e] of ranges) {
    if (e - s + 1 > largest) largest = e - s + 1
    if (s <= curEnd + 1) {
      if (e > curEnd) curEnd = e
      continue
    }
    covered += curEnd - curStart + 1
    curStart = s
    curEnd = e
  }
  covered += curEnd - curStart + 1
  return {
    coveredPct: Math.round((covered / totalLines) * 100),
    largestPct: Math.round((largest / totalLines) * 100),
  }
}

function renderBody(entries: SymbolEntry[]): {
  body: string
  shown: number
} {
  // Over budget, drop the DEEPEST rows first — nested landmarks before the
  // top-level skeleton, and among equals the smallest body first. Truncating in
  // document order instead would cut the END of the file off, which is the one
  // part of a large file the reader cannot guess. Ties broken by line so the
  // choice is deterministic.
  const budgeted = fitToBudget(entries)
  // Align the range column to the widest range string for readability.
  const widest = budgeted.reduce(
    (w, e) => Math.max(w, rangeLabel(e).length),
    0,
  )
  const lines: string[] = []
  let shown = 0
  for (const entry of budgeted) {
    const indent = '  '.repeat(entry.depth + 1)
    const range = rangeLabel(entry).padEnd(widest)
    const line = `${indent}${range}  ${entry.signature}`
    lines.push(line)
    shown++
  }
  return { body: lines.join('\n'), shown }
}

/**
 * The subset of `entries`, in document order, that fits under
 * {@link OUTLINE_MAX_TOKENS}. Returns the input untouched when it already fits,
 * which is the overwhelmingly common case.
 */
function fitToBudget(entries: SymbolEntry[]): SymbolEntry[] {
  const rowTokens = (e: SymbolEntry): number =>
    estimateTokens(`${'  '.repeat(e.depth + 1)}${rangeLabel(e)}  ${e.signature}\n`)
  let total = 0
  for (const e of entries) total += rowTokens(e)
  if (total <= OUTLINE_MAX_TOKENS) return entries

  const dropOrder = [...entries].sort(
    (a, b) =>
      b.depth - a.depth ||
      a.endLine - a.startLine - (b.endLine - b.startLine) ||
      a.startLine - b.startLine,
  )
  const dropped = new Set<SymbolEntry>()
  for (const e of dropOrder) {
    if (total <= OUTLINE_MAX_TOKENS) break
    // Always leave at least one row, so a single oversized signature still
    // renders something rather than an empty body.
    if (dropped.size >= entries.length - 1) break
    dropped.add(e)
    total -= rowTokens(e)
  }
  return entries.filter(e => !dropped.has(e))
}

/**
 * Renders just the symbol-table body (no file header) for callers that supply
 * their own envelope — e.g. the tool-result summarizer's `code-outline`
 * strategy, where there is no source file path to drill into (retrieval is via
 * the marker's `source=` backing, not `Read(file_path, symbol=)`). Shares the
 * `OUTLINE_MAX_TOKENS` cap and range-column alignment with {@link renderOutline}.
 *
 * @param entries  Symbol table from {@link scanSymbols} (must be non-empty).
 */
export function renderOutlineBody(entries: SymbolEntry[]): string {
  const { body, shown } = renderBody(entries)
  const dropped = entries.length - shown
  const trailer =
    dropped > 0
      ? `\n  … (+${dropped} more symbols — use offset/limit to read specific ranges)`
      : ''
  return `${body}${trailer}`
}

/**
 * Renders a symbol table as the outline view shown to the model.
 *
 * @param entries     Symbol table from {@link scanSymbols} (must be non-empty).
 * @param filePath    Path shown in the header.
 * @param totalLines  Total line count of the file.
 */
export function renderOutline(
  entries: SymbolEntry[],
  filePath: string,
  totalLines: number,
  options: RenderOutlineOptions = {},
): string {
  const { body, shown } = renderBody(entries)
  const dropped = entries.length - shown

  // Markdown headings can contain a single quote, which would visually break
  // the `symbol='...'` example below — prefer a quote-free name for the hint.
  // Code identifiers never contain quotes, so this is a no-op for code files.
  const firstSymbol =
    entries.find(e => !e.name.includes("'"))?.name ?? 'name'
  const lead =
    options.reason === 'overcap'
      ? `File '${filePath}' (${totalLines} lines) exceeds the read cap — showing a structural outline instead of the full contents.`
      : options.reason === 'pivot'
        ? // Matches AUTO_OUTLINE_PIVOT_FOOTER's "File is large; returned
          // outline instead of full body" — the two used to contradict each
          // other, the header claiming a cap and the footer a policy choice.
          `File '${filePath}' (${totalLines} lines) is large — showing a structural outline instead of the full contents.`
        : `Structural outline of '${filePath}' (${totalLines} lines).`

  // When the scan was byte-capped, the outline only covers the head — say so
  // explicitly so the model doesn't treat a partial table as the whole file.
  const truncationNote = options.truncated
    ? `\nNOTE: the file exceeds the 10 MB scan cap; only the first ${totalLines} scanned lines are outlined — deeper symbols are not listed.`
    : ''

  const { coveredPct, largestPct } = outlineCoverage(entries, totalLines)
  const coverageNote =
    totalLines >= COVERAGE_NOTE_MIN_LINES ||
    largestPct >= COVERAGE_NOTE_DOMINANT_PCT
      ? `\n${entries.length} symbol${entries.length === 1 ? '' : 's'} covering ` +
        `${coveredPct}% of the lines; the largest spans ${largestPct}% of the file.`
      : ''

  const header =
    `<system-reminder>\n` +
    `${lead}${coverageNote}${truncationNote}\n` +
    `Call Read(file_path, symbol='${firstSymbol}') to expand one symbol's ` +
    `body with real line numbers, or Read(file_path, offset=N, limit=M) ` +
    `for an arbitrary range.\n` +
    `</system-reminder>`

  const trailer =
    dropped > 0
      ? `\n  … (+${dropped} more symbols — use offset/limit to read specific ranges)`
      : ''

  return `${header}\n\n${body}${trailer}\n`
}
