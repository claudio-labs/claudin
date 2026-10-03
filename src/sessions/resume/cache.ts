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

import { loadSessionFile } from 'src/sessions/resume/transcriptLoad.js'

export const getSessionMessages = memoize(
  async (sessionId: UUID): Promise<Set<UUID>> => {
    const { messages } = await loadSessionFile(sessionId)
    return new Set(messages.keys())
  },
  (sessionId: UUID) => sessionId,
)

export function clearSessionMessagesCache(): void {
  getSessionMessages.cache.clear?.()
}

export async function doesMessageExistInSession(
  sessionId: UUID,
  messageUuid: UUID,
): Promise<boolean> {
  const recorded = await getSessionMessages(sessionId)
  return recorded.has(messageUuid)
}
