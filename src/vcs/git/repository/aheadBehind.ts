/** Commits HEAD has that its upstream lacks (`ahead`), and the reverse (`behind`). */
export type AheadBehind = { ahead: number; behind: number }

const COUNTS_RE = /^(\d+)\s+(\d+)$/

/** Reads `git rev-list --left-right --count HEAD...@{upstream}`, HEAD's side first; anything else counts as zeros. */
export function parseAheadBehind(output: string): AheadBehind {
  const counts = COUNTS_RE.exec(output.trim())
  if (counts === null) return { ahead: 0, behind: 0 }
  return { ahead: Number(counts[1]), behind: Number(counts[2]) }
}
