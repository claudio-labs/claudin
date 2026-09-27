import { useEffect } from 'react'
import {
  updateSessionPresence,
  whenSessionRegistered,
} from 'src/sessions/concurrentSessions.js'
import {
  readSessionPresence,
  type SessionPresence,
  samePresence,
} from 'src/sessions/sessionPresence.js'
import { useAppStateStore } from 'src/terminal/state/AppState.js'

const PRESENCE_POLL_MS = 1500

/**
 * Keep this session's presence in its PID record, so the session list in
 * other instances can show it running (a blinking dot), its running agents
 * and its cost. Polled rather than wired to each source: the turn clock, the
 * task table and the cost counters change in different places, and the PID
 * file is only rewritten when what the list shows changed.
 */
export function useSessionPresence(): void {
  const store = useAppStateStore()
  useEffect(() => {
    let last: SessionPresence | undefined
    let cancelled = false
    const publish = (): void => {
      const next = readSessionPresence(store.getState().tasks)
      if (last && samePresence(last, next)) return
      last = next
      void whenSessionRegistered().then(registered => {
        if (registered && !cancelled) void updateSessionPresence(next)
      })
    }
    publish()
    const timer = setInterval(publish, PRESENCE_POLL_MS)
    timer.unref?.()
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [store])
}
