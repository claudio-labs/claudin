/**
 * Filesystem primitives shared by the Claude→Claudin startup migration and by
 * every `/import` adapter. Extracted from `claudinMigration.ts` with their
 * behavior unchanged.
 *
 * The invariant they all encode: **nothing here overwrites**. An import that
 * loses config the user already had is worse than one that skips a file and
 * says so, so each of these reports "did not write" rather than clobbering,
 * and the caller turns that into a conflict row in the report.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs'
import { dirname } from 'path'

import {
  asTable,
  type JsonTable,
} from 'src/platform/import/translate/values.js'

/**
 * A file that does not parse is an expected condition here, not a fault: these
 * read config written by other tools and by older versions of this one. The
 * null is the signal, and every caller turns it into a warning the user sees.
 */
export function readJson(path: string): JsonTable | null {
  try {
    return asTable(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

export function writeJson(path: string, data: JsonTable): void {
  writeFileSync(path, JSON.stringify(data, null, 2), { encoding: 'utf8' })
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

/**
 * Copies one file, byte for byte, only when the destination is absent.
 * Returns whether it wrote; throws only on a real IO failure.
 */
export function copyFileIfAbsent(sourcePath: string, destPath: string): boolean {
  if (!existsSync(sourcePath)) return false
  if (existsSync(destPath)) return false
  ensureDir(dirname(destPath))
  writeFileSync(destPath, readFileSync(sourcePath))
  return true
}

/**
 * Recursive copy that leaves every already-existing destination file alone
 * (`force: false` with `errorOnExist: false`). Returns whether the source was
 * a directory worth copying at all.
 *
 * `dereference` is what makes this an import rather than a link: sharing one
 * skill directory across agents by symlinking it into each of their config
 * dirs is common, and `cpSync` defaults to reproducing the link, so the
 * "imported" skill would still live in — and die with — the other agent's
 * config. Resolving instead means a dangling link throws, which `applyOne`
 * turns into a visible error row rather than a silently broken skill.
 */
export function copyTreeWithoutOverwriting(
  sourceDir: string,
  destDir: string,
): boolean {
  if (!existsSync(sourceDir)) return false
  if (!statSync(sourceDir).isDirectory()) return false
  ensureDir(dirname(destDir))
  cpSync(sourceDir, destDir, {
    recursive: true,
    force: false,
    errorOnExist: false,
    dereference: true,
  })
  return true
}

export function countTopLevelEntries(dir: string): number {
  try {
    if (!existsSync(dir)) return 0
    return readdirSync(dir).length
  } catch {
    return 0
  }
}

/**
 * Lists the files under `dir` matching `extension`, recursing into
 * subdirectories and returning paths relative to `dir` so a caller can keep a
 * foreign tool's namespacing (`git/commit.toml` → the `git:commit` command).
 */
export function listFilesRecursive(dir: string, extensions: string[]): string[] {
  const found: string[] = []
  const walk = (current: string, prefix: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of entries.sort()) {
      const absolute = `${current}/${entry}`
      const relative = prefix ? `${prefix}/${entry}` : entry
      let isDirectory: boolean
      try {
        isDirectory = statSync(absolute).isDirectory()
      } catch {
        continue
      }
      if (isDirectory) {
        walk(absolute, relative)
      } else if (extensions.some(ext => entry.endsWith(ext))) {
        found.push(relative)
      }
    }
  }
  if (!existsSync(dir)) return found
  walk(dir, '')
  return found
}
