/**
 * `git worktree list --porcelain -z`, read into records. The main working tree
 * comes first; each record is a run of `key value` fields ended by an empty one.
 */

export type ListedWorktree = {
  readonly path: string
  readonly head: string | null
  /** The short branch name; null when detached or bare. */
  readonly branch: string | null
}

const LOCAL_BRANCH_PREFIX = 'refs/heads/'

function valueOf(fields: readonly string[], key: string): string | null {
  const field = fields.find(entry => entry.startsWith(`${key} `))
  return field === undefined ? null : field.slice(key.length + 1)
}

export function parseWorktreeList(listing: string): ListedWorktree[] {
  const records: string[][] = [[]]
  for (const field of listing.split('\0')) {
    if (field === '') records.push([])
    else records[records.length - 1]?.push(field)
  }
  const worktrees: ListedWorktree[] = []
  for (const fields of records) {
    const path = valueOf(fields, 'worktree')
    if (path === null) continue
    const ref = valueOf(fields, 'branch')
    worktrees.push({
      path,
      head: valueOf(fields, 'HEAD'),
      branch: ref?.startsWith(LOCAL_BRANCH_PREFIX) ? ref.slice(LOCAL_BRANCH_PREFIX.length) : ref,
    })
  }
  return worktrees
}
