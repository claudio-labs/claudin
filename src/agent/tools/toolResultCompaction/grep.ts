import type { StrategyResult } from 'src/agent/tools/toolResultSummarizer/types.js'

// ============================================================
// Grep
// ============================================================
//
// One strategy: `compactGrepOutput`, a lossless regroup of a content-mode
// ripgrep body. Nothing is dropped, clamped or reordered — each run of one
// file's lines goes under a `--- path ---` header that replaces the path on
// them, and every other byte stays where rg printed it. The parser below
// decides which of a line's candidate splits is the real path.

// Ripgrep marks a match line `path:NN:text` and a context line `path-NN-text`.
// Unanchored and global: the separator run occurs inside real paths as well as
// at the true boundary, so every candidate is enumerated and the whole result
// votes on which one is real (see chooseGrepSplits).
const GREP_PREFIX_RE = /([:-])(\d+)\1/g
// The same line with the filename omitted (`-H false`, i.e. a content search
// scoped to one file): a leading line number and ONE separator, not two.
const GREP_PATHLESS_RE = /^(\d+)([:-])/
// rg prints this between non-contiguous context blocks; the regroup keeps it.
const GREP_BLOCK_SEPARATOR = '--'

type GrepEntry = {
  n: number
  /**
   * The line number exactly as rg wrote it — what gets printed, so the regroup
   * hands back the very bytes of the line it came from. `n` is its value.
   */
  raw: string
  body: string
  isMatch: boolean
}

type GrepSplit = { file: string } & GrepEntry

/**
 * The file key for a body rg emitted without any path — a content search scoped
 * to a single file, where every line is `NN:text`. There is no path to group
 * under, so the regroup leaves such a body as it is.
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
 * reads as file `notes`, line 2026, and the file then has context but no match.
 * The
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
 * no line would otherwise parse. The retry is purely additive (a line starting
 * with a path has no pathless reading), and gating it on the majority keeps a
 * stray `117:text` line in a NORMAL result from being read as a numbered one.
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

const GREP_HEADER_RE = /^--- .* ---$/
const GREP_NUMBERED_RE = /^\d+[:-]/
/** What a header line costs beyond the path it names: `--- `, ` ---` and its newline. */
const GREP_HEADER_OVERHEAD = 9

/**
 * The lossless regroup: rg's output in rg's order, every line kept, each run
 * of lines from one file under a `--- path ---` header that replaces the path
 * on them (`NN:text` a match, `NN-text` context). The `--` between blocks
 * stays inside the run; every other line ships as rg printed it, and ends the
 * run.
 *
 * Two rules keep a header from saying anything false. A file earns one only
 * with a match line of its own: a path the parser misread shows up as context
 * alone (`phase-0-plan.md:31:x` read as file `phase`, line 0), the invariant
 * the cut keeps too. And a run earns one only when it pays for itself, as in
 * the Glob regroup, so a single hit keeps its path inline.
 *
 * Null when no line names a file, when rg printed no filenames (a search
 * scoped to one file), when no run pays, or when a line printed as rg printed
 * it would read as a header or a numbered line, which would make the output
 * ambiguous.
 */
export function compactGrepOutput(text: string): StrategyResult | null {
  const lines = text.split('\n')
  const splits = chooseGrepSplits(lines)
  const matched = new Set<string>()
  for (const split of splits) {
    if (split?.isMatch && split.file !== GREP_NO_PATH) matched.add(split.file)
  }
  /** The file line `i` would be grouped under, or null when it ships as printed. */
  const fileOf = (i: number): string | null => {
    const split = splits[i]
    return split && matched.has(split.file) ? split.file : null
  }
  const out: string[] = []
  let grouped = false
  for (let i = 0; i < lines.length; ) {
    const file = fileOf(i)
    if (file === null) {
      const line = lines[i]!
      if (line !== GREP_BLOCK_SEPARATOR && (GREP_HEADER_RE.test(line) || GREP_NUMBERED_RE.test(line))) return null
      out.push(line)
      i++
      continue
    }
    // The run: this file's lines and the `--` between them; a trailing `--` stays outside.
    let last = i
    let count = 1
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === GREP_BLOCK_SEPARATOR) continue
      if (fileOf(j) !== file) break
      last = j
      count++
    }
    // Each line under the header drops the path and one separator.
    if (count * (file.length + 1) > file.length + GREP_HEADER_OVERHEAD) {
      out.push(`--- ${file} ---`)
      for (let k = i; k <= last; k++) {
        const split = splits[k]
        if (lines[k] === GREP_BLOCK_SEPARATOR || !split) out.push(lines[k]!)
        else out.push(`${split.raw}${split.isMatch ? ':' : '-'}${split.body}`)
      }
      grouped = true
    } else {
      for (let k = i; k <= last; k++) {
        const line = lines[k]!
        if (line !== GREP_BLOCK_SEPARATOR && GREP_NUMBERED_RE.test(line)) return null
        out.push(line)
      }
    }
    i = last + 1
  }
  return grouped ? { body: out.join('\n'), strategy: 'compact-grep' } : null
}
