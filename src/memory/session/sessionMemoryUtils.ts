/**
 * Reading a session's memory file, and the id of the last message a
 * session-memory summary covered.
 *
 * Nothing in this build writes the file or sets the id to anything but
 * undefined any more; compaction and the away summary still read both, so
 * they stay until those callers are rewritten.
 */
import { readFile } from 'fs/promises'
import { getSessionMemoryPath } from 'src/memory/session/paths.js'
import { logForDebugging } from 'src/shared/debug.js'
import { isENOENT, isFsInaccessible } from 'src/shared/errors.js'

let summarizedThroughMessageId: string | undefined

export function getLastSummarizedMessageId(): string | undefined {
  return summarizedThroughMessageId
}

/** `undefined` clears it. */
export function setLastSummarizedMessageId(messageId: string | undefined): void {
  summarizedThroughMessageId = messageId
}

/**
 * The file exactly as it is on disk, read afresh at every call, or null when
 * it cannot be reached: missing, behind a file where a folder should be, a
 * symlink loop, or no permission. Any other failure (a folder standing where
 * the file should be, say) is the caller's to see.
 */
export async function getSessionMemoryContent(): Promise<string | null> {
  const path = getSessionMemoryPath()
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (!isFsInaccessible(error)) throw error
    if (!isENOENT(error)) {
      logForDebugging(`session memory at ${path} cannot be read (${error.code}), treating it as absent`)
    }
    return null
  }
}
