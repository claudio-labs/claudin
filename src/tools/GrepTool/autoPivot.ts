import { feature } from 'bun:bundle'

import { RG_LINE_RE } from './relativize.js'

/**
 * Auto-pivot for BROAD content-mode Grep results: when a search matched widely
 * enough that its first N lines are an arbitrary slice rather than an answer,
 * the tool returns the symbol map (`output_mode:"symbols"`) instead of the
 * lines. Same move as FileReadTool's AUTO_OUTLINE_ON_ELISION, applied to search.
 *
 * The gate here is a pure function on the shape of the result; the decision to
 * honour it lives in GrepTool.call(), which owns the map building. Splitting
 * them keeps the policy testable and lets the replay bench
 * (scripts/profile/grep-summarizer-replay.ts --pivot) evaluate candidate
 * thresholds over recorded results without booting the tool.
 *
 * Measured over every recorded session transcript in
 * ~/.claudin/projects/-home-viudes-projects-claudin (5,109 content-mode Grep
 * results, 7,257,694 chars of tool_result):
 *
 * - 2,155 results (46.8% of those chars) pass an explicit `head_limit` and are
 *   suppressed below. That is deliberate sizing, not an accident: the values
 *   cluster at 10-60, well under the 250 default.
 * - the shipping policy pivots 64 results, replacing 620,647 chars of lines
 *   with 139,016 chars of map: **6.6% of all content-mode Grep chars saved
 *   outright, 3.7% on top of what the summarizer already saves losslessly** —
 *   the second number is the one that justifies a lossy mode change.
 * - loosening to `files ≥ 3` would reach 8.6% / 4.3% and `files ≥ 8` drops to
 *   4.1% / 2.7%. Five is the deliberate middle: a search that landed in three
 *   files is usually a search whose lines are the answer.
 * - the match-line trigger earns its place on top of the char one: dropping it
 *   loses 5 pivots and 0.3pp of the marginal saving.
 * - {@link pivotWins} is load-bearing, not belt-and-braces: it blocked 5 of 69
 *   admitted results whose map was not materially smaller.
 *
 * Re-measure with `NODE_ENV=test bun --preload ./src/stubs/test-preload.ts
 * scripts/profile/grep-summarizer-replay.ts --pivot`.
 */

/**
 * Emitted-content size at which a wide search stops being readable as lines.
 * Sits above GREP_SUMMARIZE_THRESHOLD (6,000 in toolResultSummarizer.ts) on
 * purpose: below it the summarizer still compacts the result WITHOUT dropping a
 * match line, and a lossless win must always beat a lossy one.
 */
export const GREP_PIVOT_THRESHOLD_CHARS = 6_000

/**
 * Companion trigger for the dense case: many short match lines can stay under
 * the char threshold while still being a locator dump rather than an answer.
 */
export const GREP_PIVOT_THRESHOLD_MATCH_LINES = 60

/**
 * Breadth requirement, applied to BOTH triggers. A search that landed in a
 * handful of files is answerable with its lines however long it is; this is
 * also what keeps single-file searches out of the pivot without a rule of their
 * own (rg omits the path prefix when the target is one file, so they measure as
 * zero files).
 */
export const GREP_PIVOT_MIN_FILES = 5

/**
 * The map has to be meaningfully smaller than the lines it replaces, not just
 * smaller — trading match text for a same-sized symbol table is a loss. Mirrors
 * the no-win guard the Grep summarizer applies (toolResultSummarizer.ts).
 */
export const GREP_PIVOT_WIN_RATIO = 0.7

export type GrepPivotShape = {
  /** Length of the content that would otherwise be emitted. */
  chars: number
  /** rg lines that are matches; -A/-B/-C context lines do not count. */
  matchLines: number
  /** Distinct files those match lines came from. */
  files: number
}

/**
 * Measures the shape of a would-be content result. `rgLines` are the raw rg
 * lines (absolute paths, as buildSymbolsOutput consumes them) so the file count
 * is exactly the file count of the map that would replace them; `chars` is the
 * length of the relativized text that would actually be sent.
 *
 * RG_LINE_RE only matches the `path:NN:` form, so context lines (`path-NN-`)
 * fall out here the same way they fall out of the map.
 */
export function measureGrepShape(
  rgLines: string[],
  chars: number,
): GrepPivotShape {
  const files = new Set<string>()
  let matchLines = 0
  for (const line of rgLines) {
    const m = RG_LINE_RE.exec(line)
    if (!m) continue
    files.add(m[1]!)
    matchLines++
  }
  return { chars, matchLines, files: files.size }
}

export type GrepPivotDecision = {
  shape: GrepPivotShape
  /** The caller passed `head_limit` explicitly — any value, including 0. */
  headLimitGiven: boolean
  /** The caller is paginating deliberately. */
  offset: number
  /**
   * `-n` is on. Belt-and-braces: rg without it emits `path:text`, which
   * measures as zero files and cannot open the gate anyway — this states the
   * requirement instead of leaning on that coincidence.
   */
  lineNumbers: boolean
}

/**
 * The policy, with no side effects and no feature-flag read — the bench and the
 * tests exercise this directly. Suppressed whenever the caller sized the output
 * on purpose (`head_limit`), is walking it (`offset`), or asked for lines
 * without numbers (`-n: false`), which leaves nothing to map.
 */
export function shouldAutoPivot({
  shape,
  headLimitGiven,
  offset,
  lineNumbers,
}: GrepPivotDecision): boolean {
  if (headLimitGiven) return false
  if (offset > 0) return false
  if (!lineNumbers) return false
  if (shape.files < GREP_PIVOT_MIN_FILES) return false
  return (
    shape.chars >= GREP_PIVOT_THRESHOLD_CHARS ||
    shape.matchLines >= GREP_PIVOT_THRESHOLD_MATCH_LINES
  )
}

/** Post-build check: the map only ships if it is materially smaller. */
export function pivotWins(mapChars: number, contentChars: number): boolean {
  return mapChars <= contentChars * GREP_PIVOT_WIN_RATIO
}

/**
 * Runtime gate. Shape copied from FileReadTool's autoOutlineOnElisionEnabled:
 * the test-preload stubs every `feature()` to false, so tests force-enable via
 * the env var, and DISABLE wins over FORCE so a user can always turn it off.
 */
export function grepAutoPivotEnabled(): boolean {
  if (process.env.CLAUDIN_DISABLE_GREP_AUTO_PIVOT === '1') return false
  if (process.env.CLAUDIN_FORCE_GREP_AUTO_PIVOT === '1') return true
  if (feature('GREP_AUTO_PIVOT')) return true
  return false
}

/**
 * Appended to a pivoted tool_result so the model knows the mode change was
 * deliberate and how to opt back in. Single declarative line, like
 * AUTO_OUTLINE_PIVOT_FOOTER, so it survives downstream normalisation.
 */
export const GREP_AUTO_PIVOT_FOOTER =
  '\n\n<system-reminder>Search matched broadly; returned the symbol map instead of matching lines. Re-run with head_limit set (or a narrower path/glob) to get the lines themselves.</system-reminder>'
