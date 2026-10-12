// A read-gate refusal that carries the lines it is refusing over.
//
// Census of 2026-09-14..20 (tool-error-census-2026-09-20.md): 102 coverage
// refusals ("only read in part … not in what you read"), 86 of them for lines
// the model genuinely never Read — 52 the import block, reached after a Grep
// and a range Read of the function being changed. The recovery was always the
// same two calls, a Read of the region and the same patch again, and in 50% of
// them the resubmit was byte-identical: the forced Read bought nothing but a
// round-trip at 300k+ of context.
//
// So when the old side of the hunk (or Edit's `old_string`) sits in the file
// EXACTLY and UNIQUELY, the refusal stands but answers with the region itself,
// numbered the way Read numbers it, and registers that slice in readFileState
// exactly as a Read(offset, limit) would have — the identical resubmit then
// passes the gate. The invariant is intact: the model still sees the lines
// before the write lands, it just sees them one call sooner. Since 2026-09-24
// Patch refuses only a file never read at all, and since 2026-09-29 it applies
// even that when every hunk matches exactly, so only its all-or-nothing mode
// (CLAUDIN_PATCH_ALL_OR_NOTHING) still serves. Edit took the same rule on
// 2026-10-12 and serves nothing: what an exact, unique match would have
// served, it now applies. `locateExactText` is its check for that.
//
// What is NOT served, on purpose:
//   - a hunk that does not match exactly, or matches twice: the model's guess
//     was wrong or ambiguous, and serving a best-effort neighbourhood would be
//     the fuzzy matcher's job at apply time, not the gate's;
//   - more than MAX_SERVED_LINES in one refusal: a hunk that large is a
//     rewrite, and the message would be the file;
//   - Delete File — there is no old side to match;
//   - an entry under a clip-pin stand-down marker, which has its own budget.
//
// A Write has no old side either, but it replaces the whole file, so what its
// refusal needs is the whole file: `serveWholeFile`, under the same cap.
//
// The entry written here carries `dedupExempt` (fileStateCache.ts): its bytes
// live in a refusal, not in a Read tool_result, so FileReadTool's stub must
// never claim "unchanged since your last read" against it.
import { addLineNumbers } from 'src/shared/fs/file.js'
import type { FileStateCache } from 'src/shared/fs/fileStateCache.js'

/** Lines shown on each side of the matched block. */
export const SERVED_REGION_CONTEXT_LINES = 2
/** Above this many lines in one refusal, nothing is served. */
export const MAX_SERVED_LINES = 200
/**
 * Above this many bytes a whole file is not served: one minified line can be
 * megabytes. The caller checks it on the stat, before reading the file.
 */
export const MAX_SERVED_FILE_BYTES = 32 * 1024

/** 1-based, inclusive file lines. */
export type LineRegion = { start: number; end: number }

/** The lines a file holds, with the trailing newline's phantom line dropped. */
export function fileLinesOf(text: string): string[] {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body === '' ? [] : body.split('\n')
}

/**
 * Where `needed` (whole lines, compared trimmed, so indentation drift still
 * tolerance) sits in the file. `null` when it is absent or matches more than
 * once. Blank-only needles localize nothing and are never served.
 */
export function locateExactLines(
  fileLines: readonly string[],
  needed: readonly string[],
): LineRegion | null {
  const wanted = needed.map(line => line.trim())
  if (wanted.length === 0 || wanted.every(line => line === '')) return null
  let found: LineRegion | null = null
  const last = fileLines.length - wanted.length
  for (let i = 0; i <= last; i++) {
    let ok = true
    for (let k = 0; k < wanted.length; k++) {
      if (fileLines[i + k]!.trim() !== wanted[k]) {
        ok = false
        break
      }
    }
    if (!ok) continue
    if (found) return null
    found = { start: i + 1, end: i + wanted.length }
  }
  return found
}

/**
 * The same question for a substring needle (Edit's `old_string`, which may
 * start and end mid-line): exact and unique in the file text.
 */
export function locateExactText(
  fileText: string,
  needle: string,
): LineRegion | null {
  if (needle.trim() === '') return null
  const at = fileText.indexOf(needle)
  if (at < 0 || fileText.indexOf(needle, at + 1) >= 0) return null
  const start = countLines(fileText, 0, at) + 1
  const end = countLines(fileText, at, at + needle.length) + start
  return { start, end: needle.endsWith('\n') ? end - 1 : end }
}

function countLines(text: string, from: number, to: number): number {
  let n = 0
  for (let i = from; i < to; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/** The 1-based line each occurrence of `needle` starts on; none for a blank needle. */
export function occurrenceLines(text: string, needle: string): number[] {
  if (needle === '') return []
  const lines: number[] = []
  let line = 1
  let from = 0
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
    line += countLines(text, from, at)
    from = at
    lines.push(line)
  }
  return lines
}

/**
 * Widen each region by the context lines, clamp to the file, and merge the
 * ones that touch or overlap — the model sees one numbered block per
 * neighbourhood, and the cache gets one slice per block. `null` past the cap.
 */
export function mergeServedRegions(
  regions: readonly LineRegion[],
  totalLines: number,
): LineRegion[] | null {
  const widened = regions
    .map(r => ({
      start: Math.max(1, r.start - SERVED_REGION_CONTEXT_LINES),
      end: Math.min(totalLines, r.end + SERVED_REGION_CONTEXT_LINES),
    }))
    .sort((a, b) => a.start - b.start)
  const merged: LineRegion[] = []
  for (const r of widened) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end)
    } else {
      merged.push({ ...r })
    }
  }
  const total = merged.reduce((n, r) => n + (r.end - r.start + 1), 0)
  return total > MAX_SERVED_LINES ? null : merged
}

/**
 * Register the regions as read — one `set` per region, which is what a
 * Read(offset, limit) of each would have done, so `carrySeenRanges` keeps the
 * earlier ones — and render them for the refusal.
 */
export function serveRegions(
  readFileState: FileStateCache,
  absPath: string,
  fileLines: readonly string[],
  mtime: number,
  regions: readonly LineRegion[],
): string {
  const blocks: string[] = []
  for (const region of regions) {
    const slice = fileLines.slice(region.start - 1, region.end)
    const content = slice.length === 0 ? '' : `${slice.join('\n')}\n`
    readFileState.set(absPath, {
      content,
      timestamp: mtime,
      offset: region.start,
      limit: region.end - region.start + 1,
      dedupExempt: true,
    })
    blocks.push(addLineNumbers({ content: slice.join('\n'), startLine: region.start }))
  }
  return blocks.join('\n…\n')
}

/**
 * A Write's refusal over a file of at most MAX_SERVED_LINES lines (and, as
 * its caller checks first, MAX_SERVED_FILE_BYTES bytes): the file, numbered
 * the way Read numbers it, registered as a whole-file read of this version,
 * so the resubmit passes if it still applies. `null` past the line cap. No
 * `dedupExempt`: Read's dedup gate never matches a whole-file entry.
 */
export function serveWholeFile(
  readFileState: FileStateCache,
  absPath: string,
  fileText: string,
  mtime: number,
): string | null {
  const lines = fileLinesOf(fileText)
  if (lines.length > MAX_SERVED_LINES) return null
  readFileState.set(absPath, {
    content: fileText,
    timestamp: mtime,
    offset: undefined,
    limit: undefined,
  })
  return addLineNumbers({ content: lines.join('\n'), startLine: 1 })
}
