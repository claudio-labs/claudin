import type { StructuredPatchHunk } from 'diff'

/**
 * Added and removed lines over a list of hunks.
 *
 * Kept free of imports beyond the hunk type: the transcript's collapsed tool
 * rows call it on every render, and must not pull the write path in with it.
 * Hunks carry no file headers, so a line starting `+++` or `---` is content.
 */
export function countAddDel(hunks: readonly StructuredPatchHunk[]): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const { lines } of hunks) {
    for (const line of lines) {
      if (line.startsWith('+')) additions += 1
      else if (line.startsWith('-')) deletions += 1
    }
  }
  return { additions, deletions }
}
