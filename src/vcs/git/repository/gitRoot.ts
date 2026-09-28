import { dirname, join, resolve } from 'path'
import { rememberLookups } from 'src/vcs/git/repository/boundedMemory.js'
import { type ProbeEntry, probeEntry } from 'src/vcs/git/repository/entryKind.js'

/** How many paths each root memory keeps before forgetting the least recently used. */
export const ROOT_MEMORY_CAPACITY = 50

/**
 * The nearest directory, climbing from `start`, that holds a `.git` directory
 * or regular file. The climb is lexical: symlinks in `start` stay unresolved,
 * because callers key identity on the path as they spell it. The answer is
 * NFC, the spelling every path the session stores uses.
 */
export function climbToGitRoot(start: string, probe: ProbeEntry): string | null {
  let dir = resolve(start)
  while (true) {
    const marker = probe(join(dir, '.git'))
    if (marker === 'directory' || marker === 'file') return dir.normalize('NFC')
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Remembered per start path as spelled, so a repository created or removed
 * after the first lookup goes unnoticed until the entry is forgotten.
 */
export const findGitRoot = rememberLookups(
  (startPath: string) => climbToGitRoot(startPath, probeEntry),
  ROOT_MEMORY_CAPACITY,
)

export async function dirIsInGitRepo(cwd: string): Promise<boolean> {
  return findGitRoot(cwd) !== null
}
