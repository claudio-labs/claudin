import type { StrategyResult } from 'src/agent/tools/toolResultSummarizer/types.js'
import { truncateLine } from 'src/agent/tools/toolResultSummarizer/bash.js'

// ============================================================
// Strategy 2: Grep
// ============================================================
//
// Regroups a content-mode ripgrep body by file: per-file header, up to
// GREP_MAX_MATCHES_PER_FILE matches with a `+N more` tail, up to GREP_MAX_FILES
// files with an `<omitted>` tail, context clamped to GREP_CONTEXT_RADIUS lines
// around each surviving match, and verbatim repeats collapsed to a
// back-reference. Anything that cannot be anchored to a match is preserved
// literally, so a malformed or mixed-format body degrades into a passthrough
// (via the caller's no-win guard) instead of losing lines.
//
// The header REPLACES the path on the lines it covers — they carry `NN:text`
// only. That is what makes a match-only body shrink at all: while the path was
// repeated under the header, the grouping cost more than it saved on every
// result rg didn't pad with context, and the no-win guard threw those summaries
// away. A header that would replace too few paths to cover its own cost is not
// emitted at all and the block stays inline, so the strategy no longer has a
// shape it reliably makes worse. A body rg emitted with no filename at all (a
// content search scoped to one file) groups headerless under GREP_NO_PATH.
//
// Measured over the recorded transcripts (scripts/bench/perf/grep-summarizer-replay.ts,
// 5,095 real content-mode results): 15.5% of all Grep chars and 33.5% of the
// context-bearing ones, across 443 results. That is the two-tier gate above
// (GREP_SUMMARIZE_FLOOR): 166 results from the ≥6,000 band and 277 lossless
// ones between 3,000 and 6,000. The bench prints the three policies side by
// side — admitting everything over 3,000 would reach 22.5%, but the count of
// results that trade a match line for a counter goes from 56 to 331, which is
// the column that decided this.

const GREP_MAX_MATCHES_PER_FILE = 10
const GREP_MAX_FILES = 50

/**
 * How far a context line may sit from the nearest surviving match in its own
 * file before it is dropped. Ripgrep's `-A/-B/-C` lines are 91% of the body of
 * every context-bearing Grep result and 43.6% of all content-mode Grep chars
 * (measured over a week of transcripts), and callers routinely ask for `-C 12`
 * or more. ±3 keeps a readable window around each hit.
 */
const GREP_CONTEXT_RADIUS = 3

// Ripgrep marks a match line `path:NN:text` and a context line `path-NN-text`.
// Unanchored and global: the separator run occurs inside real paths as well as
// at the true boundary, so every candidate is enumerated and the whole result
// votes on which one is real (see chooseGrepSplits).
const GREP_PREFIX_RE = /([:-])(\d+)\1/g
// The same line with the filename omitted (`-H false`, i.e. a content search
// scoped to one file): a leading line number and ONE separator, not two.
const GREP_PATHLESS_RE = /^(\d+)([:-])/
const GREP_BLANK_RE = /^\s*$/
// rg prints this between non-contiguous context blocks; the per-file grouping
// below replaces what it conveyed.
const GREP_BLOCK_SEPARATOR = '--'
// `path:count` — the shape of `output_mode: "count"`, which is already small.
const GREP_COUNT_LINE_RE = /^[^:]+:\d+$/

type GrepEntry = {
  n: number
  /**
   * The line number exactly as rg wrote it. `n` is for arithmetic (sorting and
   * the context clamp); this is what gets printed, so a summary cannot hand
   * back a locator that differs by a character from the line it came from.
   */
  raw: string
  body: string
  isMatch: boolean
}

type GrepSplit = { file: string } & GrepEntry

/**
 * The file key for a body rg emitted without any path — a content search scoped
 * to a single file, where every line is `NN:text`. There is no path to group
 * under and none to strip, so the block prints headerless and the saving comes
 * from the context clamp alone.
 */
const GREP_NO_PATH = ''

/**
 * Every way one ripgrep line could be split into `path`, line number and text,
 * left to right. A line usually has more than one: the code text can contain
 * `:9:`, and the path itself can contain `-2026-`.
 *
 * `allowPathless` admits the `NN:text` form, whose "path" is the empty string.
 * It is off for the first pass because a normal result's literal bucket is full
 * of lines that would parse that way by accident.
 */
function grepLineSplits(line: string, allowPathless: boolean): GrepSplit[] {
  const out: GrepSplit[] = []
  if (allowPathless) {
    const m = GREP_PATHLESS_RE.exec(line)
    if (m) {
      out.push({
        file: GREP_NO_PATH,
        n: Number(m[1]),
        raw: m[1]!,
        body: line.slice(m[0].length),
        isMatch: m[2] === ':',
      })
    }
  }
  for (const m of line.matchAll(GREP_PREFIX_RE)) {
    const cut = m.index
    if (cut === 0) continue
    out.push({
      file: line.slice(0, cut),
      n: Number(m[2]),
      raw: m[2]!,
      body: line.slice(cut + m[0].length),
      isMatch: m[1] === ':',
    })
  }
  return out
}

/**
 * Picks one split per line, using the whole result as evidence.
 *
 * Taking the leftmost split — what this did before — mislabels every line of a
 * file whose own name carries a separator run: `notes-2026-07-25.md:12:text`
 * reads as file `notes`, line 2026, and the file then has context but no match,
 * so the strategy drops it into the literal bucket and summarizes nothing. The
 * three kinds of candidate are separable by how they behave ACROSS lines:
 *
 * - the real path recurs with a different line number on every line it appears;
 * - a split inside the path pins the same number every time (`notes` is always
 *   line 2026);
 * - a split inside the code text belongs to one line only.
 *
 * So rank by distinct line numbers, then by lines covered, and keep the
 * leftmost on a tie — which is what a single-line result gets, i.e. the old
 * behavior, and it degrades to the literal bucket rather than to a wrong path.
 *
 * A body where fewer than half the lines carry a path is retried as pathless —
 * a content search scoped to one file, where rg omits the filename entirely and
 * this used to parse nothing and ship in full. The retry is purely additive (a
 * line starting with a path has no pathless reading), and gating it on the
 * majority is what keeps a NORMAL result byte-identical: its literal bucket
 * routinely holds a stray `117:text` line that must stay preserved rather than
 * become a clampable entry.
 */
function chooseGrepSplits(lines: string[]): Array<GrepSplit | null> {
  const pathed = rankGrepSplits(lines.map(l => grepLineSplits(l, false)))
  const parsed = pathed.reduce((n, s) => (s === null ? n : n + 1), 0)
  if (parsed * 2 >= lines.length) return pathed
  const pathless = rankGrepSplits(lines.map(l => grepLineSplits(l, true)))
  const parsedPathless = pathless.reduce((n, s) => (s === null ? n : n + 1), 0)
  return parsedPathless > parsed ? pathless : pathed
}

function rankGrepSplits(perLine: GrepSplit[][]): Array<GrepSplit | null> {
  const numbers: Record<string, Set<number>> = Object.create(null)
  const covered: Record<string, number> = Object.create(null)
  for (const splits of perLine) {
    for (const s of splits) {
      numbers[s.file] ??= new Set()
      numbers[s.file]!.add(s.n)
      covered[s.file] = (covered[s.file] ?? 0) + 1
    }
  }
  return perLine.map(splits => {
    let best: GrepSplit | null = null
    let bestDistinct = -1
    let bestCovered = -1
    for (const s of splits) {
      const distinct = numbers[s.file]!.size
      const cover = covered[s.file]!
      if (
        distinct > bestDistinct ||
        (distinct === bestDistinct && cover > bestCovered)
      ) {
        best = s
        bestDistinct = distinct
        bestCovered = cover
      }
    }
    return best
  })
}

/** Full `path:NN:text` — for lines emitted OUTSIDE a per-file header. */
function renderGrepLine(file: string, entry: GrepEntry, body: string): string {
  const sep = entry.isMatch ? ':' : '-'
  return `${file}${sep}${entry.raw}${sep}${body}`
}

/**
 * `NN:text` — for lines under a `--- file (N matches) ---` header, where the
 * path is dead weight. Repeating it is what made the summary of a match-only
 * body LARGER than the input: the path is the longest term on most lines, so
 * the grouping paid for a header AND kept everything the header replaced. The
 * `file:line` reference the model needs is still reconstructable from the two.
 */
function renderGrepBlockLine(entry: GrepEntry, body: string): string {
  const sep = entry.isMatch ? ':' : '-'
  return `${entry.raw}${sep}${body}`
}

/** Whichever of the two forms reproduces the line rg actually emitted. */
function renderGrepSourceLine(
  file: string,
  entry: GrepEntry,
  body: string,
): string {
  return file === GREP_NO_PATH
    ? renderGrepBlockLine(entry, body)
    : renderGrepLine(file, entry, body)
}

/**
 * Exported for the replay bench (scripts/bench/perf/grep-summarizer-replay.ts) and
 * the regression tests, which need the raw strategy body without the envelope
 * and without the dispatch threshold.
 */
export function summarizeGrepOutput(text: string): StrategyResult | null {
  const lines = text.split('\n').filter(l => l.length > 0)
  if (lines.length === 0) return null

  // Count-mode passthrough: if ≥80% of lines look like `path:count`,
  // the output is already small and structured.
  const countLineMatches = lines.reduce(
    (n, l) => (GREP_COUNT_LINE_RE.test(l) ? n + 1 : n),
    0,
  )
  if (countLineMatches / lines.length >= 0.8) return null

  // Parse lines into (file, lineNumber, text, isMatch). Unparseable lines go to
  // the "other" bucket, preserved verbatim.
  // Null-prototype objects with explicit sorted iteration: determinism, and a
  // file (or a line body) literally named `__proto__` must not reach through to
  // Object.prototype — assigning it on a plain object leaves `byFile[file]`
  // without a `push`, which threw where the whole path is supposed to fail open.
  const byFile: Record<string, GrepEntry[]> = Object.create(null)
  const files: string[] = []
  const other: string[] = []
  let totalMatches = 0
  let totalContext = 0

  const splits = chooseGrepSplits(lines)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line === GREP_BLOCK_SEPARATOR) continue
    const parsed = splits[i]
    if (!parsed) {
      other.push(line)
      continue
    }
    // A blank context line carries nothing the surrounding lines don't.
    if (!parsed.isMatch && GREP_BLANK_RE.test(parsed.body)) continue
    const { file, ...entry } = parsed
    if (!(file in byFile)) {
      byFile[file] = []
      files.push(file)
    }
    byFile[file]!.push(entry)
    if (entry.isMatch) totalMatches++
    else totalContext++
  }

  if (files.length === 0) return null

  const matchCount = (file: string): number =>
    byFile[file]?.reduce((n, e) => n + (e.isMatch ? 1 : 0), 0) ?? 0

  // A file with context but no match cannot happen in well-formed rg output —
  // context only exists around a match in the same file. It DOES happen when a
  // result mixes path forms (transcripts recorded before context lines were
  // relativized have absolute-path context and relative-path matches). Those
  // lines have no anchor, so clamping them would be guesswork: preserve them
  // literally instead of silently dropping them, and let the no-win guard
  // decide whether the summary is still worth shipping.
  const matchedFiles = files.filter(f => matchCount(f) > 0)
  if (matchedFiles.length === 0) return null
  for (const file of files) {
    if (matchCount(file) > 0) continue
    for (const entry of byFile[file]!) {
      other.push(renderGrepSourceLine(file, entry, entry.body))
      totalContext--
    }
  }

  // Sort files: primary by match count DESC, secondary by filename ASC
  // — pure deterministic ordering (no Map iteration, no Date).
  const sortedFiles = [...matchedFiles].sort((a, b) => {
    const diff = matchCount(b) - matchCount(a)
    if (diff !== 0) return diff
    return a < b ? -1 : a > b ? 1 : 0
  })

  const kept = sortedFiles.slice(0, GREP_MAX_FILES)
  const dropped = sortedFiles.slice(GREP_MAX_FILES)

  // Dedupe runs last, over surviving lines only: a back-reference to a line
  // that the clamp or the per-file cap removed would point at nothing.
  const firstSeen: Record<string, string> = Object.create(null)
  /** The body to print for one entry: its own, or a reference to an earlier one. */
  const dedupeBody = (file: string, entry: GrepEntry): string => {
    // The locator stays fully qualified: a back-reference routinely points at a
    // line under a DIFFERENT file's header.
    const locator =
      file === GREP_NO_PATH ? `line ${entry.raw}` : `${file}:${entry.raw}`
    const seen = firstSeen[entry.body]
    if (seen === undefined) {
      firstSeen[entry.body] = locator
      return entry.body
    }
    const marker = `… same as ${seen}`
    // Only a win when the repeated body is longer than the reference to it.
    return marker.length < entry.body.length ? marker : entry.body
  }

  const fileBlocks: string[] = []
  let contextKept = 0
  // Match lines this body replaces with a counter rather than printing. The
  // dispatch gate turns on it, so it counts BOTH elision paths.
  let matchesElided = 0

  for (const file of kept) {
    const entries = [...byFile[file]!].sort((a, b) => a.n - b.n)
    const matches = entries.filter(e => e.isMatch)
    const shownMatches = matches.slice(0, GREP_MAX_MATCHES_PER_FILE)
    const anchors = shownMatches.map(e => e.n)
    const shown = entries.filter(entry => {
      if (entry.isMatch) return shownMatches.includes(entry)
      // Context survives only next to a match that is itself still shown.
      return anchors.some(a => Math.abs(a - entry.n) <= GREP_CONTEXT_RADIUS)
    })

    const rendered = shown.map(entry => ({
      entry,
      body: dedupeBody(file, entry),
    }))
    for (const entry of shown) {
      if (!entry.isMatch) contextKept++
    }
    const extra = matches.length - shownMatches.length
    matchesElided += extra
    const more =
      extra > 0 ? `+${extra} more match${extra === 1 ? '' : 'es'}` : null

    // A pathless body has no path to hoist, so there is nothing to head.
    if (file === GREP_NO_PATH) {
      for (const r of rendered) {
        fileBlocks.push(truncateLine(renderGrepBlockLine(r.entry, r.body)))
      }
      if (more !== null) fileBlocks.push(more)
      continue
    }

    // The header only pays when it replaces the path on enough lines to cover
    // its own cost — with one match and no context it does not, and the summary
    // grew where it was emitted anyway. Rather than guess a line count, build
    // both forms and keep the shorter: the crossover moves with the length of
    // the path, which is the whole term being traded.
    const grouped = [
      `--- ${file} (${matches.length} match${matches.length === 1 ? '' : 'es'}) ---`,
      ...rendered.map(r => truncateLine(renderGrepBlockLine(r.entry, r.body))),
      ...(more === null ? [] : [more]),
    ]
    const inline = [
      ...rendered.map(r => truncateLine(renderGrepLine(file, r.entry, r.body))),
      ...(more === null ? [] : [`${file}: ${more}`]),
    ]
    fileBlocks.push(
      ...(grouped.join('\n').length <= inline.join('\n').length
        ? grouped
        : inline),
    )
  }

  const body: string[] = []
  body.push(
    `Grep summary: files=${matchedFiles.length}, matches=${totalMatches}` +
      (totalContext > 0 ? `, context=${contextKept}/${totalContext}` : '') +
      (other.length > 0 ? `, other=${other.length}` : ''),
  )
  body.push(...fileBlocks)

  if (dropped.length > 0) {
    const droppedMatches = dropped.reduce((n, f) => n + matchCount(f), 0)
    matchesElided += droppedMatches
    body.push(
      `<omitted>: ${dropped.length} file${dropped.length === 1 ? '' : 's'}, ${droppedMatches} match${droppedMatches === 1 ? '' : 'es'} not shown`,
    )
  }

  if (other.length > 0) {
    body.push('--- other (preserved literally) ---')
    for (const line of other) body.push(truncateLine(line))
  }

  return { body: body.join('\n'), strategy: 'grep-grouped', matchesElided }
}
