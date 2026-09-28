import { statSync } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { getErrnoCode } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'

/**
 * Everything this module knows about a repository comes through here, so the
 * parsing on top of it can run against an in-memory directory in tests.
 */
export type GitFiles = {
  /** The file's text; null when it is missing, unreadable or not a file. */
  readText(path: string): Promise<string | null>
  /** Whether a directory is there, following symlinks. */
  isDirectory(path: string): Promise<boolean>
  /** The directories inside `path`; null when it cannot be listed. */
  listDirectories(path: string): Promise<string[] | null>
}

/**
 * Failures that only mean "nothing usable there". A repository is full of
 * optional files, and an answer of null is part of the contract for each of
 * them, so these are not worth a log line. Anything else is.
 */
const ABSENCE_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG'])

function reportUnexpected(error: unknown): void {
  const code = getErrnoCode(error)
  if (code === undefined || !ABSENCE_CODES.has(code)) logError(error)
}

export const diskGitFiles: GitFiles = {
  async readText(path) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      reportUnexpected(error)
      return null
    }
  },

  async isDirectory(path) {
    try {
      return (await stat(path)).isDirectory()
    } catch (error) {
      reportUnexpected(error)
      return false
    }
  },

  async listDirectories(path) {
    try {
      const entries = await readdir(path, { withFileTypes: true })
      return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch (error) {
      reportUnexpected(error)
      return null
    }
  },
}

const ABSENT_STAMP = 'absent'

/**
 * A fingerprint of a file's state, compared between polls. git replaces files
 * by renaming a lock file over them, which changes the inode even when the
 * size and the clock tick stay the same.
 */
export function fileStamp(path: string): string {
  try {
    const stats = statSync(path, { throwIfNoEntry: false })
    if (stats === undefined) return ABSENT_STAMP
    return `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`
  } catch (error) {
    reportUnexpected(error)
    return ABSENT_STAMP
  }
}
