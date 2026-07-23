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

import type { SymbolEntry } from './scanSymbols.js'

/** Token ceiling for the rendered outline body. */
export const OUTLINE_MAX_TOKENS = 10_000

// Bytes per token. The auto-cap is an internal safety guard, not user-facing
// precision — a coarse 4 bytes/token heuristic keeps this module free of the
// provider/tokenizer dependency chain.
const BYTES_PER_TOKEN = 4

function estimateTokens(text: string): number {
  return Math.ceil(text.length / BYTES_PER_TOKEN)
}

export type RenderOutlineOptions = {
  /** true when produced because a plain Read exceeded the cap. */
  overCap?: boolean
  /**
   * true when the symbol scan only saw the head of the file (it exceeds the
   * 10 MB scan cap). The header states this so the outline never silently
   * pretends to be complete.
   */
  truncated?: boolean
}

function rangeLabel(entry: SymbolEntry): string {
  return `${entry.startLine}-${entry.endLine}`
}

function renderBody(entries: SymbolEntry[]): {
  body: string
  shown: number
} {
  // Align the range column to the widest range string for readability.
  const widest = entries.reduce(
    (w, e) => Math.max(w, rangeLabel(e).length),
    0,
  )
  const lines: string[] = []
  let estimate = 0
  let shown = 0
  for (const entry of entries) {
    const indent = '  '.repeat(entry.depth + 1)
    const range = rangeLabel(entry).padEnd(widest)
    const line = `${indent}${range}  ${entry.signature}`
    const lineTokens = estimateTokens(line + '\n')
    if (shown > 0 && estimate + lineTokens > OUTLINE_MAX_TOKENS) {
      break
    }
    lines.push(line)
    estimate += lineTokens
    shown++
  }
  return { body: lines.join('\n'), shown }
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
  const lead = options.overCap
    ? `File '${filePath}' (${totalLines} lines) exceeds the read cap — showing a structural outline instead of the full contents.`
    : `Structural outline of '${filePath}' (${totalLines} lines).`

  // When the scan was byte-capped, the outline only covers the head — say so
  // explicitly so the model doesn't treat a partial table as the whole file.
  const truncationNote = options.truncated
    ? `\nNOTE: the file exceeds the 10 MB scan cap; only the first ${totalLines} scanned lines are outlined — deeper symbols are not listed.`
    : ''

  const header =
    `<system-reminder>\n` +
    `${lead}${truncationNote}\n` +
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
