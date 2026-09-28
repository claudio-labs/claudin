import type { GitDiffStats } from 'src/vcs/git/gitDiff/types.js'

/** git keeps this summary line in English whatever the locale, so it is safe to match. */
const SUMMARY_LINE = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/

/** `git diff --shortstat` output to totals; null when git printed no summary (no changes). */
export function parseShortstat(stdout: string): GitDiffStats | null {
  const summary = SUMMARY_LINE.exec(stdout)
  if (summary === null) return null
  return {
    filesCount: Number(summary[1]),
    linesAdded: Number(summary[2] ?? 0),
    linesRemoved: Number(summary[3] ?? 0),
  }
}
