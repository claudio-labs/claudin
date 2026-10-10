import type { StrategyResult } from 'src/agent/tools/toolResultCompaction/types.js'

// ============================================================
// Glob
// ============================================================

// Glob's own notices, which are metadata rather than paths: counting one as a
// path inflates the total, and grouping one would bury the INCOMPLETE line,
// which says the listing is a prefix rather than the whole answer.
// `Directories are inferred` is the third of them: a `type: "dir"` listing is
// evidenced by the files inside each directory, so that note is what says an
// empty directory is missing from the ANSWER rather than from the tree.
const NOTICE_RE =
  /^\((?:Results are truncated|INCOMPLETE:|Directories are inferred)/i

const GLOB_INDENT = '  '

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
