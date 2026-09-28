// Node built-ins only: the portable listing, which an editor-extension host
// loads, parses with this module too.
import { resolve, sep } from 'path'

const WORKTREE_FIELD = 'worktree '
const TRAILING_CR_RE = /\r$/

/** The working-tree paths of `git worktree list --porcelain`, NFC, in git's order: the main one first. */
export function parseWorktreeList(porcelain: string): string[] {
  const paths: string[] = []
  for (const rawLine of porcelain.split('\n')) {
    const line = rawLine.replace(TRAILING_CR_RE, '')
    if (line.startsWith(WORKTREE_FIELD)) {
      paths.push(line.slice(WORKTREE_FIELD.length).normalize('NFC'))
    }
  }
  return paths
}

/**
 * Puts the working tree that holds `cwd` first and the rest in
 * `localeCompare` order. The holder is the deepest listed tree containing
 * `cwd`, because worktrees can sit inside the main checkout, as
 * `.claudin/worktrees/<slug>` does.
 */
export function currentWorktreeFirst(paths: readonly string[], cwd: string): string[] {
  const here = resolve(cwd).normalize('NFC')
  let holder: string | undefined
  for (const path of paths) {
    if (contains(path, here) && (holder === undefined || path.length > holder.length)) {
      holder = path
    }
  }
  const others = paths.filter(path => path !== holder).sort((a, b) => a.localeCompare(b))
  return holder === undefined ? others : [holder, ...others]
}

function contains(tree: string, dir: string): boolean {
  const root = resolve(tree)
  return dir === root || dir.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}
