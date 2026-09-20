import type { StrategyResult } from 'src/agent/tools/toolResultSummarizer/types.js'

// ============================================================
// Strategy 5: Glob
// ============================================================

const GLOB_MAX_PATHS = 50

export function summarizeGlobOutput(text: string): StrategyResult | null {
  const allLines = text.split('\n').filter(l => l.length > 0)

  // Separate Glob's own notices from actual paths — they are metadata. Both
  // have to be here: counting a notice as a path inflates the total, and the
  // 50-path cap can then drop the INCOMPLETE line, which is the one saying the
  // listing is a prefix rather than the whole answer.
  // `Directories are inferred` is the third of them: a `type: "dir"` listing is
  // evidenced by the files inside each directory, so that note is what says an
  // empty directory is missing from the ANSWER rather than from the tree.
  const NOTICE_RE =
    /^\((?:Results are truncated|INCOMPLETE:|Directories are inferred)/i
  const notices = allLines.filter(l => NOTICE_RE.test(l))
  const pathLines = allLines.filter(l => !NOTICE_RE.test(l))

  // No paths means Glob returned nothing useful — pass through.
  if (pathLines.length === 0) return null

  const total = pathLines.length
  const kept = pathLines.slice(0, GLOB_MAX_PATHS)
  const omitted = total - kept.length

  const parts: string[] = []
  if (omitted > 0) {
    parts.push(`Glob summary: ${total} path${total === 1 ? '' : 's'} found, showing first ${kept.length}`)
  } else {
    parts.push(`Glob summary: ${total} path${total === 1 ? '' : 's'} found`)
  }

  for (const p of kept) parts.push(p)

  if (omitted > 0) {
    parts.push(`<omitted paths="${omitted}"/>`)
  }

  for (const notice of notices) parts.push(notice)

  return { body: parts.join('\n'), strategy: 'glob-top-n' }
}
