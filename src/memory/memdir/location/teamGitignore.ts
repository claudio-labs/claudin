const BLANKET_IGNORES: ReadonlySet<string> = new Set([
  '.claudin',
  '/.claudin',
  '.claudin/',
  '/.claudin/',
])
const TEAM_CARVE_OUT_PREFIXES = [
  '!.claudin/memory/team',
  '!/.claudin/memory/team',
] as const

/**
 * Best effort, not git's matcher: only the four blanket spellings and an
 * explicit re-include of the team directory are recognized, and the last one
 * seen wins. Wildcard forms such as `.claudin/*` are not evaluated.
 */
export function gitignoreSwallowsClaudinDir(gitignoreText: string): boolean {
  let ignored = false
  for (const rawLine of gitignoreText.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (BLANKET_IGNORES.has(line)) {
      ignored = true
    } else if (TEAM_CARVE_OUT_PREFIXES.some(prefix => line.startsWith(prefix))) {
      ignored = false
    }
  }
  return ignored
}
