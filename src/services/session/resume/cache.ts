/**
 * Memoized session-message lookup cache.
 *
 * Extracted in Wave 2 of the 11c sessionStorage split. The memoized
 * `getSessionMessages` is exported with its `.cache` property intact so that
 * callers like `getLastSessionLog` (still in sessionStorage.ts during the
 * split) can prime the cache after a single full read.
 *
 * IMPORTANT: this module's cache is shared by every importer — it is the
 * one source of truth for "which UUIDs are persisted for this session?".
 * `clearSessionMessagesCache()` must be called after compaction or any
 * operation that invalidates UUIDs.
 */
import type { UUID } from 'crypto'
import memoize from 'lodash-es/memoize.js'

import { loadSessionFile } from 'src/services/session/resume/transcriptLoad.js'

/**
 * Gets message UUIDs for a specific session without loading all sessions.
 * Memoized to avoid re-reading the same session file multiple times.
 */
export const getSessionMessages = memoize(
  async (sessionId: UUID): Promise<Set<UUID>> => {
    const { messages } = await loadSessionFile(sessionId)
    return new Set(messages.keys())
  },
  (sessionId: UUID) => sessionId,
)

/**
 * Clear the memoized session messages cache.
 * Call after compaction when old message UUIDs are no longer valid.
 */
export function clearSessionMessagesCache(): void {
  getSessionMessages.cache.clear?.()
}

/**
 * Check if a message UUID exists in the session storage
 */
export async function doesMessageExistInSession(
  sessionId: UUID,
  messageUuid: UUID,
): Promise<boolean> {
  const messageSet = await getSessionMessages(sessionId)
  return messageSet.has(messageUuid)
}
