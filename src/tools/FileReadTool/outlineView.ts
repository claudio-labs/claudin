import { feature } from 'bun:bundle'
import type { ToolUseContext } from 'src/Tool.js'
import {
  renderOutline,
  type OutlineReason,
} from 'src/tools/shared/codeOutline/renderOutline.js'
import {
  SCAN_MAX_BYTES,
  scanSymbols,
  type OutlineLang,
  type SymbolEntry,
} from 'src/tools/shared/codeOutline/scanSymbols.js'
import { isAbortError } from 'src/shared/errors.js'
import { readFileInRange } from 'src/shared/fs/readFileInRange.js'
import { logError } from 'src/shared/log.js'
import type { Output } from 'src/tools/FileReadTool/schemas.js'

/**
 * Footer appended to outline tool_results produced by AUTO_OUTLINE_ON_ELISION
 * — kept as a single declarative line so it survives any downstream text
 * normalisation and shows up identically in transcripts. Exported for tests
 * and for the optional UI badge that mirrors the same wording.
 *
 * It advertises `view='full'` because that is the one-round-trip way back to
 * the body, and measurement said the model never found it: across eight
 * headless A/B runs (~200 Reads) `view='full'` was used once. What it did
 * instead was rebuild the file in slices — ~19 repeat Reads per run, walking
 * contiguous ranges with almost no overlap. The tool description already
 * mentions `view='full'` (see prompt.ts), but this footer arrives at the
 * moment of the decision and the local instruction is the one that wins.
 *
 * The dropped `view='outline'` suggestion was dead advice: renderOutline's
 * pivot path and an explicit `view='outline'` both go through the same
 * renderBody() under the same OUTLINE_MAX_TOKENS cap, so "map further" handed
 * back a byte-identical table to the one just served.
 *
 * Only the pivot is allowed to say this. The over-cap outline is reached from
 * a catch that also requires `view === undefined`, so there `view='full'`
 * rethrows the FileTooLargeError instead of returning a body — see the
 * over-cap branch below and its regression test.
 */
export const AUTO_OUTLINE_PIVOT_FOOTER =
  "\n\n<system-reminder>File is large; returned outline instead of full body. Pass view='full' to load the whole body in one call, or offset/limit/symbol for a specific range.</system-reminder>"

/**
 * Body size at which a vanilla full-file Read pivots to an outline. ~10 KB is
 * the empirical floor where Opus starts narrating about needing "the middle"
 * of a large literal tool_result and re-Reads in slices; below it the full
 * body fits in working context without inducing the slice-walk loop.
 */
export const READ_AUTO_OUTLINE_THRESHOLD_CHARS = 10_000

/**
 * Line-count companion to the char threshold: a long code file with many
 * short lines can stay under 10 KB while still being tiring to read whole
 * ("more than 2 functions and more than 250 lines → bring only what
 * matters"). Only pivots when the scan also finds at least
 * READ_AUTO_OUTLINE_MIN_SYMBOLS symbols, so a long single-function file still
 * returns its body.
 */
export const READ_AUTO_OUTLINE_THRESHOLD_LINES = 250
export const READ_AUTO_OUTLINE_MIN_SYMBOLS = 3

/**
 * Single source of truth for the AUTO_OUTLINE_ON_ELISION gate. Tests can
 * force-enable via `CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION=1` because the
 * test-preload (src/stubs/test-preload.ts) stubs every `feature()` call to
 * `false` and a local `mock.module('bun:bundle', …)` runs too late to win
 * against it. Production behavior is unchanged: the build-time preprocessor
 * folds `feature('AUTO_OUTLINE_ON_ELISION')` to its flag value.
 */
export function autoOutlineOnElisionEnabled(): boolean {
  if (process.env.CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION === '1') return true
  if (process.env.CLAUDIN_DISABLE_AUTO_OUTLINE_ON_ELISION === '1') return false
  if (feature('AUTO_OUTLINE_ON_ELISION')) return true
  return false
}

export type ScannedFile = {
  /** Full file content split into lines — the basis scanSymbols computed on. */
  lines: string[]
  /** Raw file content (capped at SCAN_MAX_BYTES). */
  source: string
  entries: SymbolEntry[]
  mtimeMs: number
  /** true when the read was byte-capped — the scan only saw the head. */
  truncated: boolean
}

/**
 * Options for {@link scanFile}. `preloaded` reuses source already in memory
 * (the line-count auto-pivot path) to avoid a redundant disk read; `maxBytes`
 * lets a test inject a tiny scan cap to exercise the truncation flag without a
 * real multi-megabyte fixture.
 */
type ScanFileOptions = {
  preloaded?: { source: string; mtimeMs: number; truncated?: boolean }
  maxBytes?: number
  /** Encoding Standard label to decode with, when the file is not UTF-8.
   *  Without it the scan reads mojibake and finds no symbols at all. */
  encoding?: string
}

/**
 * Reads a file in full and scans its symbol table. Returns null when the scan
 * yields nothing (unsupported shape, parse failure) so callers degrade to a
 * normal Read. Abort errors propagate; other read errors fail open as null.
 *
 * Exported for the truncation unit test, which injects a tiny `maxBytes` to
 * exercise the byte-cap `truncated` flag without a real multi-MB fixture.
 */
export async function scanFile(
  resolvedFilePath: string,
  lang: OutlineLang,
  signal: AbortSignal,
  options: ScanFileOptions = {},
): Promise<ScannedFile | null> {
  let source: string
  let mtimeMs: number
  let truncated: boolean
  if (options.preloaded) {
    source = options.preloaded.source
    mtimeMs = options.preloaded.mtimeMs
    truncated = options.preloaded.truncated ?? false
  } else {
    try {
      const res = await readFileInRange(
        resolvedFilePath,
        0,
        undefined,
        options.maxBytes ?? SCAN_MAX_BYTES,
        signal,
        { truncateOnByteLimit: true, encoding: options.encoding },
      )
      source = res.content
      mtimeMs = res.mtimeMs
      truncated = res.truncatedByBytes ?? false
    } catch (e) {
      if (isAbortError(e)) throw e
      logError(e)
      return null
    }
  }
  const entries = scanSymbols(source, lang)
  if (entries.length === 0) return null
  const lines = source.split('\n')
  // Drop the phantom empty element a trailing newline produces, so outline
  // totalLines matches the text-read line count (cat -n semantics). Symbol
  // line ranges are unaffected — they only ever point at real lines.
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return { lines, source, entries, mtimeMs, truncated }
}

/**
 * Exact symbol lookup. On a name collision prefers the shallowest (top-level);
 * on a depth tie prefers the widest line span — for overloaded TS functions
 * this picks the implementation (which has a body) over the bare signatures.
 */
export function findSymbolEntry(
  entries: SymbolEntry[],
  name: string,
): SymbolEntry | null {
  let best: SymbolEntry | null = null
  for (const e of entries) {
    if (e.name !== name) continue
    if (best === null || e.depth < best.depth) {
      best = e
    } else if (
      e.depth === best.depth &&
      e.endLine - e.startLine > best.endLine - best.startLine
    ) {
      best = e
    }
  }
  return best
}

export function formatSymbolList(names: string[]): string {
  const shown = names.slice(0, 15)
  const suffix =
    names.length > shown.length ? `, … (${names.length} total)` : ''
  return shown.join(', ') + suffix
}

/**
 * Builds the 'outline' result. The model has NOT seen real file content — only
 * the skeleton — so the cache entry is marked partial (Edit/Write will require
 * a fresh Read). Per FileState convention, `content` holds raw disk bytes.
 */
export function makeOutlineData(
  scanned: ScannedFile,
  file_path: string,
  fullFilePath: string,
  readFileState: ToolUseContext['readFileState'],
  reason: OutlineReason,
): { data: Output } {
  const content = renderOutline(
    scanned.entries,
    file_path,
    scanned.lines.length,
    { reason, truncated: scanned.truncated },
  )
  readFileState.set(fullFilePath, {
    content: scanned.source,
    timestamp: Math.floor(scanned.mtimeMs),
    offset: undefined,
    limit: undefined,
    isPartialView: true,
  })
  return {
    data: {
      type: 'outline' as const,
      file: {
        filePath: file_path,
        content,
        totalLines: scanned.lines.length,
        symbolCount: scanned.entries.length,
        ...(reason === 'pivot' ? { autoPivot: true } : {}),
      },
    },
  }
}

/**
 * Builds the 'unfold' result: one symbol's body as a normal partial Read. The
 * model has seen these exact lines, so the cache entry is NOT partial —
 * Edit/Write stay unblocked. Line numbering is applied downstream from
 * `startLine`, so the model sees the symbol's real line numbers.
 */
export function makeUnfoldData(
  scanned: ScannedFile,
  entry: SymbolEntry,
  file_path: string,
  fullFilePath: string,
  readFileState: ToolUseContext['readFileState'],
  toolUseId: string | undefined,
): { data: Output } {
  const slice = scanned.lines
    .slice(entry.startLine - 1, entry.endLine)
    .join('\n')
  const numLines = entry.endLine - entry.startLine + 1
  readFileState.set(fullFilePath, {
    content: slice,
    timestamp: Math.floor(scanned.mtimeMs),
    offset: entry.startLine,
    limit: numLines,
    toolUseId,
  })
  return {
    data: {
      type: 'text' as const,
      file: {
        filePath: file_path,
        content: slice,
        numLines,
        startLine: entry.startLine,
        totalLines: scanned.lines.length,
      },
    },
  }
}
