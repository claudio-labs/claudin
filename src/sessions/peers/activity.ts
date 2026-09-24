/**
 * Whether this session is busy or idle, as another session sees it: busy
 * while a turn runs or something waits in its queue, idle otherwise. The REPL
 * reports it (hooks/useSessionActivity.ts); this module keeps the value and
 * tells whoever subscribed when it goes idle.
 */
export type SessionActivity = 'busy' | 'idle'

export type ActivityInputs = {
  isLoading: boolean
  /** Commands queued for the main thread — each one starts a turn. */
  queuedForMain: number
}

export function activityOf({ isLoading, queuedForMain }: ActivityInputs): SessionActivity {
  return isLoading || queuedForMain > 0 ? 'busy' : 'idle'
}

// A turn ending with a queued command behind it flips idle and back within a
// tick; waiting this long means an idle notice goes out only for a real stop.
export const IDLE_DEBOUNCE_MS = 750

let current: SessionActivity = 'busy'
let idleSince: number | undefined
const idleListeners = new Set<(finishedAt: number) => void>()
let pendingIdle: ReturnType<typeof setTimeout> | undefined

export function getSessionActivity(): SessionActivity {
  return current
}

/** When the current idle stretch began; undefined while busy. */
export function getIdleSince(): number | undefined {
  return idleSince
}

/** Called once per settled idle stretch, with when the last turn ended. */
export function onSessionIdle(listener: (finishedAt: number) => void): () => void {
  idleListeners.add(listener)
  return () => {
    idleListeners.delete(listener)
  }
}

export function reportSessionActivity(
  next: SessionActivity,
  now: number = Date.now(),
  debounceMs: number = IDLE_DEBOUNCE_MS,
): void {
  if (next === current) return
  current = next
  if (pendingIdle) clearTimeout(pendingIdle)
  pendingIdle = undefined
  if (next === 'busy') {
    idleSince = undefined
    return
  }
  idleSince = now
  pendingIdle = setTimeout(() => {
    pendingIdle = undefined
    if (current !== 'idle') return
    for (const listener of idleListeners) listener(now)
  }, debounceMs)
  pendingIdle.unref?.()
}

export function resetSessionActivityForTests(): void {
  if (pendingIdle) clearTimeout(pendingIdle)
  pendingIdle = undefined
  current = 'busy'
  idleSince = undefined
  idleListeners.clear()
}
