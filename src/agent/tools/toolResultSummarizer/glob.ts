import type { StrategyResult } from 'src/agent/tools/toolResultSummarizer/types.js'

// ============================================================
// Strategy 5: Glob
// ============================================================

const GLOB_MAX_PATHS = 50

// Glob's own notices, which are metadata rather than paths. Both functions
// below must tell them apart: counting a notice as a path inflates the total,
// and the 50-path cap can then drop the INCOMPLETE line, which is the one
// saying the listing is a prefix rather than the whole answer.
// `Directories are inferred` is the third of them: a `type: "dir"` listing is
// evidenced by the files inside each directory, so that note is what says an
// empty directory is missing from the ANSWER rather than from the tree.
const NOTICE_RE =
  /^\((?:Results are truncated|INCOMPLETE:|Directories are inferred)/i

const GLOB_INDENT = '  '

export function summarizeGlobOutput(text: string): StrategyResult | null {
  const allLines = text.split('\n').filter(l => l.length > 0)

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

/** The directory a listed path sits in, with its slash; '' for a line that is no groupable path. */
function groupDir(line: string): string {
  if (line.length === 0 || line.endsWith('/') || NOTICE_RE.test(line)) return ''
  const slash = line.lastIndexOf('/')
  return slash < 0 ? '' : line.slice(0, slash + 1)
}

/**
 * Every path of a Glob listing, each run of consecutive paths in one directory
 * printed under that directory. Only adjacent paths are grouped: Glob orders
 * by modification time unless asked otherwise, and the order is part of the
 * answer. A run the header would not pay for stays as it was, and the notices
 * stay where they were. Null when no run pays.
 */
export function compactGlobOutput(text: string): StrategyResult | null {
  const lines = text.split('\n')
  // An indented path would read as one listed under the group before it.
  if (lines.some(l => l.startsWith(' '))) return null
  const out: string[] = []
  let grouped = false
  for (let i = 0; i < lines.length; ) {
    const dir = groupDir(lines[i]!)
    let end = i + 1
    if (dir !== '') {
      while (end < lines.length && groupDir(lines[end]!) === dir) end++
    }
    // The header costs the directory and a newline; each path under it drops
    // the directory and pays the indent.
    if (dir !== '' && (end - i) * (dir.length - GLOB_INDENT.length) > dir.length + 1) {
      out.push(dir)
      for (let k = i; k < end; k++) out.push(GLOB_INDENT + lines[k]!.slice(dir.length))
      grouped = true
    } else {
      for (let k = i; k < end; k++) out.push(lines[k]!)
    }
    i = end
  }
  if (!grouped) return null
  const paths = lines.filter(l => l.length > 0 && !NOTICE_RE.test(l)).length
  return { body: out.join('\n'), strategy: 'compact-glob', envelopeAttrs: { paths: String(paths) } }
}
