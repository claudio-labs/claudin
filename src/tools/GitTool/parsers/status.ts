/**
 * `git status` rendering.
 *
 * The measured tail of this shape is untracked-file explosions — a `node_modules`
 * or a build directory the model does not care about individually, listed one
 * path per line. Tracked changes are never grouped: they are the thing the
 * model is asking about.
 */

/** Group untracked entries only once there are more than this many. */
export const UNTRACKED_GROUP_THRESHOLD = 12

const SHORT_LINE_RE = /^(..) (.+)$/
const UNTRACKED_RE = /^\?\? /

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '.' : path.slice(0, cut + 1)
}

/**
 * @returns a rendering with untracked paths collapsed per directory, or null
 * when the body is not `--short` output or has too few untracked entries to be
 * worth grouping.
 */
export function renderStatusShort(text: string): string | null {
  const lines = text.split('\n').filter(Boolean)
  if (lines.length === 0) return null

  const tracked: string[] = []
  const untracked: string[] = []
  for (const line of lines) {
    const m = line.match(SHORT_LINE_RE)
    if (!m) return null // not `--short` output; leave it alone
    if (UNTRACKED_RE.test(line)) untracked.push(m[2] ?? '')
    else tracked.push(line)
  }

  if (untracked.length <= UNTRACKED_GROUP_THRESHOLD) return null

  const byDir = new Map<string, number>()
  for (const path of untracked) {
    byDir.set(dirOf(path), (byDir.get(dirOf(path)) ?? 0) + 1)
  }

  const groups = [...byDir.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([dir, n]) => (n === 1 ? `?? ${dir}` : `?? ${dir} (${n} files)`))

  return [
    ...tracked,
    `${untracked.length} untracked files in ${byDir.size} directories:`,
    ...groups,
  ].join('\n')
}
