/**
 * Which loaded entries are one physical file. The identity is the device and
 * inode of the directory entry itself: a hard link, or a path through a
 * linked directory, is the same file, while a symlinked file stays an entry
 * of its own, so that a link can alias an agent under another name.
 */
import { lstat } from 'fs/promises'

import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'

export type IdentifiedFile = { filePath: string; identity: string | undefined }

export async function fileIdentityOf(path: string): Promise<string | undefined> {
  try {
    return identityFromStats(await lstat(path, { bigint: true }))
  } catch (error) {
    logForDebugging(`[markdown config] no identity for ${path}, so it is kept: ${errorMessage(error)}`)
    return undefined
  }
}

/**
 * Compared as exact integers, since a large inode (ExFAT) rounded to a double
 * could fold two files into one. An inode of 0 identifies nothing: some file
 * systems report it for every file.
 */
export function identityFromStats({ dev, ino }: { dev: bigint; ino: bigint }): string | undefined {
  return ino === 0n ? undefined : `${dev}:${ino}`
}

/** The first entry of each file, in order; an entry whose identity is unknown is kept. */
export function keepFirstOfEachFile<T extends IdentifiedFile>(entries: readonly T[]): T[] {
  const seen = new Set<string>()
  return entries.filter(({ filePath, identity }) => {
    if (identity === undefined) return true
    if (seen.has(identity)) {
      logForDebugging(`[markdown config] ${filePath} is a file loaded already`)
      return false
    }
    seen.add(identity)
    return true
  })
}
