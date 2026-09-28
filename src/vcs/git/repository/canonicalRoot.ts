import { rememberLookups } from 'src/vcs/git/repository/boundedMemory.js'
import { findGitRoot, ROOT_MEMORY_CAPACITY } from 'src/vcs/git/repository/gitRoot.js'
import { canonicalRootOf, nodeWorktreeFs } from 'src/vcs/git/repository/worktreePointer.js'

/**
 * The canonical root of a directory known to hold `.git`, remembered per
 * root: a worktree removed after its first lookup keeps mapping to its main
 * repository.
 */
export const canonicalRootOfRepository = rememberLookups(
  (root: string) => canonicalRootOf(root, nodeWorktreeFs),
  ROOT_MEMORY_CAPACITY,
)

/** The repository identity that project config, memory and trust are keyed by. */
export const findCanonicalGitRoot = Object.assign(
  (startPath: string): string | null => {
    const root = findGitRoot(startPath)
    return root === null ? null : canonicalRootOfRepository(root)
  },
  { cache: canonicalRootOfRepository.cache },
)

/** Drops null and empty entries and keeps the first occurrence of each root, in order. */
export function dedupeCanonicalRoots(roots: ReadonlyArray<string | null>): string[] {
  return [...new Set(roots.filter((root): root is string => Boolean(root)))]
}

/** The canonical root of `cwd`, then of each additional directory; no repeats, no non-repositories. */
export function resolveWorkspaceRoots(cwd: string, additionalDirs: readonly string[]): string[] {
  return dedupeCanonicalRoots([cwd, ...additionalDirs].map(dir => findCanonicalGitRoot(dir)))
}
