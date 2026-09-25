/**
 * Session memory state read by session-memory compaction
 * (src/agent/compact/sessionMemoryCompact.ts) and the away summary.
 */

import { isFsInaccessible } from 'src/shared/errors.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { getSessionMemoryPath } from 'src/memory/session/paths.js'

// Track the last summarized message ID (shared state)
let lastSummarizedMessageId: string | undefined

/**
 * Get the message ID up to which the session memory is current
 */
export function getLastSummarizedMessageId(): string | undefined {
  return lastSummarizedMessageId
}

/**
 * Set the last summarized message ID
 */
export function setLastSummarizedMessageId(
  messageId: string | undefined,
): void {
  lastSummarizedMessageId = messageId
}

/**
 * Get the current session memory content
 */
export async function getSessionMemoryContent(): Promise<string | null> {
  const fs = getFsImplementation()
  const memoryPath = getSessionMemoryPath()

  try {
    const content = await fs.readFile(memoryPath, { encoding: 'utf-8' })


    return content
  } catch (e: unknown) {
    if (isFsInaccessible(e)) return null
    throw e
  }
}
