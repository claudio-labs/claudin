import { statSync } from 'fs'
import { stat } from 'fs/promises'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage, isFsInaccessible } from 'src/shared/errors.js'

/** What a path names once symlinks are followed. */
export type EntryKind = 'directory' | 'file' | 'other' | 'missing'

export type ProbeEntry = (path: string) => EntryKind

export function probeEntry(path: string): EntryKind {
  try {
    const stats = statSync(path, { throwIfNoEntry: false })
    if (stats === undefined) return 'missing'
    if (stats.isDirectory()) return 'directory'
    return stats.isFile() ? 'file' : 'other'
  } catch (error) {
    reportUnexpectedFsError(path, error)
    return 'missing'
  }
}

/** Whether anything exists at `path`, following symlinks, so a dangling link does not count. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    reportUnexpectedFsError(path, error)
    return false
  }
}

/**
 * A path that is missing, sits behind a file, lacks permission or loops is as
 * good as absent to every question this unit asks, so only stranger failures
 * leave a trace.
 */
export function reportUnexpectedFsError(path: string, error: unknown): void {
  if (!isFsInaccessible(error)) {
    logForDebugging(`Could not examine ${path}: ${errorMessage(error)}`)
  }
}
