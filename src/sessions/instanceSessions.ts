/**
 * The sessions this claudin process has been on, most recent first: the
 * "open here" group of the session list. Kept in memory only, so after a
 * restart they read as inactive like any other transcript. An id that never
 * got a transcript (the fresh session a --resume replaces) is harmless — the
 * list only shows ids it found on disk.
 */
import { getSessionId, onSessionSwitch } from 'src/platform/bootstrap/state.js'

let visited: string[] = []
let unsubscribe: (() => void) | undefined

function visit(sessionId: string): void {
  visited = [sessionId, ...visited.filter(id => id !== sessionId)]
}

/** Start recording, from the session this process is on now. */
export function trackInstanceSessions(): void {
  unsubscribe?.()
  visit(getSessionId())
  unsubscribe = onSessionSwitch(visit)
}

/** Every session visited in this process, the current one first. */
export function getInstanceSessionIds(): readonly string[] {
  return visited
}

/** End a session here: it leaves the "open here" group and reads as inactive. */
export function closeInstanceSession(sessionId: string): void {
  visited = visited.filter(id => id !== sessionId)
}

export function resetInstanceSessionsForTests(): void {
  unsubscribe?.()
  unsubscribe = undefined
  visited = []
}
