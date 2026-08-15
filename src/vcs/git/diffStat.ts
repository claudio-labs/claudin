import type { StructuredPatchHunk } from 'diff'

/**
 * Count added/removed lines in a structured patch.
 *
 * Lives in its own leaf module because both the write tools and the TUI's
 * collapse path need it: `collapseReadSearch.ts` runs on every transcript
 * re-render and must not pull in `stagedWrite.ts` (LSP manager, MCP notify,
 * team-memory guard) just to add two numbers.
 */
export function countAddDel(hunks: StructuredPatchHunk[]): {
  additions: number
  deletions: number
} {
  let additions = 0
  let deletions = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions++
      else if (line.startsWith('-')) deletions++
    }
  }
  return { additions, deletions }
}
