import type { ExtractionCursorStore } from 'src/memory/extract/extractionCursor.js'

/** A cursor store in memory, for a test that keeps no file. */
export function memoryCursorStore(): ExtractionCursorStore {
  const cursors = new Map<string, string>()
  return {
    read: sessionId => cursors.get(sessionId),
    write: (sessionId, uuid) => void cursors.set(sessionId, uuid),
  }
}
