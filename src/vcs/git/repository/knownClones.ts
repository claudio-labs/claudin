import { errorMessage } from 'src/shared/errors.js'

/** Local clones: a lower-cased `owner/name` to absolute paths, most recently used first. */
export type RepoPaths = Record<string, string[]>

/** Where the mapping is kept, narrowed to the two operations the bookkeeping needs. */
export type RepoPathStore = {
  readonly read: () => RepoPaths | undefined
  readonly write: (next: RepoPaths) => void
}

export function pathsUnder(mapping: RepoPaths | undefined, repo: string): string[] {
  return [...(mapping?.[repo.toLowerCase()] ?? [])]
}

/** The mapping with `path` first under `repo` and not repeated; null when it is first already. */
export function withPathFirst(
  mapping: RepoPaths | undefined,
  repo: string,
  path: string,
): RepoPaths | null {
  const key = repo.toLowerCase()
  const current = mapping?.[key] ?? []
  if (current[0] === path) return null
  return { ...mapping, [key]: [path, ...current.filter(known => known !== path)] }
}

/** The mapping without any copy of `path` under `repo`, dropping the entry once empty; null when nothing changes. */
export function withoutPath(
  mapping: RepoPaths | undefined,
  repo: string,
  path: string,
): RepoPaths | null {
  const key = repo.toLowerCase()
  const current = mapping?.[key]
  if (current === undefined || !current.includes(path)) return null
  const next = { ...mapping }
  const remaining = current.filter(known => known !== path)
  if (remaining.length > 0) next[key] = remaining
  else delete next[key]
  return next
}

export type CloneRecorderDeps = {
  /** The session repository's github.com `owner/name`, or null. */
  readonly detectRepository: () => Promise<string | null>
  /** The directory the session was started in. */
  readonly launchDirectory: () => string
  readonly repositoryRootOf: (path: string) => string | null
  /** Resolves symlinks; a path that cannot be resolved comes back as given. */
  readonly resolvePath: (path: string) => Promise<string>
  readonly store: RepoPathStore
  readonly log: (message: string) => void
}

/**
 * Records where the session's GitHub repository is cloned: the root of the
 * repository around the launch directory, or the launch directory itself,
 * moved to the front of its list. Detection follows the session cwd while
 * the path follows the launch directory. Nothing is written when the path is
 * first already, and a failure is logged, never thrown.
 */
export async function recordCurrentClone(deps: CloneRecorderDeps): Promise<void> {
  try {
    const repo = await deps.detectRepository()
    if (repo === null) return
    const launch = deps.launchDirectory()
    const path = await deps.resolvePath(deps.repositoryRootOf(launch) ?? launch)
    const next = withPathFirst(deps.store.read(), repo, path)
    if (next !== null) deps.store.write(next)
  } catch (error) {
    deps.log(`Could not record the repository's local clone: ${errorMessage(error)}`)
  }
}
