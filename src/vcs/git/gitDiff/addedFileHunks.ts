import type { StructuredPatchHunk } from 'diff'
import { MAX_LINES_PER_FILE } from 'src/vcs/git/gitDiff/limits.js'

/**
 * An untracked file shown as all-added, which git itself has no hunk for.
 * Unlike a patch between two texts, it starts at old line 0, as git numbers a
 * new file.
 */
export function buildAddedFileHunks(content: string): StructuredPatchHunk[] {
  if (content === '') return []
  const lines = leadingLines(content, MAX_LINES_PER_FILE).map(line => `+${line}`)
  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines }]
}

/**
 * Up to `limit` lines, split at `\n` alone so a CRLF line keeps its `\r`. A
 * final newline ends the last line instead of starting an empty one.
 */
function leadingLines(text: string, limit: number): string[] {
  const lines: string[] = []
  let start = 0
  while (lines.length < limit && start < text.length) {
    const end = text.indexOf('\n', start)
    if (end === -1) {
      lines.push(text.slice(start))
      break
    }
    lines.push(text.slice(start, end))
    start = end + 1
  }
  return lines
}
