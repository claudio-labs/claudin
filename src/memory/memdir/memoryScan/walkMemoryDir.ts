import type { Dirent, Stats } from 'fs'
import { readdir, stat } from 'fs/promises'
import { join } from 'path'

export type WalkMemoryDirDeps = {
  readdir: (dir: string) => Promise<Dirent[]>
  /** Follows symlinks. */
  stat: (path: string) => Promise<Stats>
}

const defaultDeps: WalkMemoryDirDeps = {
  readdir: dir => readdir(dir, { withFileTypes: true }),
  stat,
}

/** Files this many directories below the root are listed; deeper ones are not. */
const MAX_DIR_DEPTH = 2

const INDEX_FILE_NAME = 'MEMORY.md'

function isMemoryFileName(name: string): boolean {
  return name.endsWith('.md') && name !== INDEX_FILE_NAME
}

/** A directory's identity, whatever name reached it. */
function identity(stats: Stats): string {
  return `${stats.dev}:${stats.ino}`
}

type Found = { name: string; rel: string; depth: number }

/**
 * Relative paths of the memory files under `root`, walked level by level.
 *
 * Symlinked directories are entered under the link's name, but no directory
 * is entered twice: a link back to an ancestor, or a second name for one
 * already walked, is passed over, so a cycle neither repeats files nor
 * empties the listing. At each level real directories are claimed before
 * links, so a file keeps its real name where it has one. An entry that
 * cannot be read is skipped; only the root failing rejects.
 */
export async function walkMemoryDir(
  root: string,
  signal: AbortSignal,
  deps: WalkMemoryDirDeps = defaultDeps,
): Promise<string[]> {
  const entered = new Set([identity(await deps.stat(root))])
  const rootEntries = await deps.readdir(root)
  const files: string[] = []
  let level: Array<{ found: Found; entries: Dirent[] }> = [
    { found: { name: '', rel: '', depth: 0 }, entries: rootEntries },
  ]

  while (level.length > 0 && !signal.aborted) {
    const dirs: Found[] = []
    const links: Found[] = []
    for (const { found: parent, entries } of level) {
      for (const entry of entries) {
        const child: Found = {
          name: entry.name,
          rel: parent.rel === '' ? entry.name : join(parent.rel, entry.name),
          depth: parent.depth + 1,
        }
        if (entry.isDirectory()) dirs.push(child)
        else if (entry.isSymbolicLink()) links.push(child)
        else if (entry.isFile() && isMemoryFileName(entry.name)) files.push(child.rel)
      }
    }

    const toEnter: Found[] = []
    for (const dir of [...dirs.filter(d => d.depth <= MAX_DIR_DEPTH), ...links]) {
      const target = await statOrNull(join(root, dir.rel), deps)
      if (target?.isFile()) {
        if (isMemoryFileName(dir.name)) files.push(dir.rel)
      } else if (target?.isDirectory() && dir.depth <= MAX_DIR_DEPTH && !entered.has(identity(target))) {
        entered.add(identity(target))
        toEnter.push(dir)
      }
    }

    level = []
    for (const dir of toEnter) {
      const entries = await readdirOrEmpty(join(root, dir.rel), deps)
      level.push({ found: dir, entries })
    }
  }
  return files
}

async function statOrNull(path: string, deps: WalkMemoryDirDeps): Promise<Stats | null> {
  try {
    return await deps.stat(path)
  } catch {
    return null
  }
}

async function readdirOrEmpty(path: string, deps: WalkMemoryDirDeps): Promise<Dirent[]> {
  try {
    return await deps.readdir(path)
  } catch {
    return []
  }
}
