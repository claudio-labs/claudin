import type { Dirent } from 'fs'
import { join } from 'path'
import { logForDebugging } from 'src/shared/debug.js'
import { getErrnoCode } from 'src/shared/errors.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'

const RULE_FILE_SUFFIX = '.md'

/** A missing directory, or a file in its place, is not worth a log line. */
const ORDINARY_MISSES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])

/**
 * Every rule file below `dir`, at any depth. Links are followed: their files
 * are listed at the target's path, and `visitedDirs` (real paths) ends a loop.
 * A directory that cannot be read contributes nothing; this never throws.
 */
export async function listRuleFiles(dir: string, visitedDirs: Set<string>): Promise<string[]> {
  const fs = getFsImplementation()
  let entries: Dirent[]
  try {
    const realDir = fs.realpathSync(dir)
    if (visitedDirs.has(realDir)) return []
    visitedDirs.add(realDir)
    entries = await fs.readdir(dir)
  } catch (error) {
    noteUnreadable(error, dir)
    return []
  }

  const found: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await listRuleFiles(path, visitedDirs)))
    else if (entry.isSymbolicLink()) found.push(...(await followLink(path, entry.name, visitedDirs)))
    else if (entry.isFile() && isRuleFileName(entry.name)) found.push(path)
  }
  return found
}

/** For a linked file the link's own name decides whether it is a rule. */
async function followLink(link: string, name: string, visitedDirs: Set<string>): Promise<string[]> {
  const fs = getFsImplementation()
  let target: string
  let isDirectory: boolean
  let isFile: boolean
  try {
    target = fs.realpathSync(link)
    const stats = await fs.stat(target)
    isDirectory = stats.isDirectory()
    isFile = stats.isFile()
  } catch {
    return []
  }
  if (isDirectory) return listRuleFiles(target, visitedDirs)
  return isFile && isRuleFileName(name) ? [target] : []
}

function isRuleFileName(name: string): boolean {
  return name.endsWith(RULE_FILE_SUFFIX)
}

function noteUnreadable(error: unknown, dir: string): void {
  const code = getErrnoCode(error)
  if (code !== undefined && ORDINARY_MISSES.has(code)) return
  logForDebugging(`Rules directory not read: ${dir} (${code ?? String(error)})`, { level: 'warn' })
}
