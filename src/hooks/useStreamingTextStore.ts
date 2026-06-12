import { useSyncExternalStore } from 'react'
import { FRAME_INTERVAL_MS } from '../ink/constants.js'

/**
 * External store for the live streaming-text preview.
 *
 * Why a store instead of REPL useState: text deltas arrive at network chunk
 * rate (often 100+/s on fast providers). As root-level REPL state, every
 * delta re-ran the entire ~4.3k-line REPL component plus a yoga layout pass —
 * Ink's 16 ms throttle only caps stdout paints, not React reconciliation.
 * Routing deltas through this store means:
 *
 *  - the value is updated synchronously per delta (cheap string concat, and
 *    consumers like the Esc-interrupt partial-text capture read the freshest
 *    value with no frame lag),
 *  - subscriber notification for text appends is coalesced to the shared
 *    FRAME_INTERVAL_MS (matching Ink's paint throttle, leading + trailing),
 *  - presence transitions (null ↔ non-null) always notify synchronously, so
 *    the streaming row mounts immediately and — critically — the clear on
 *    final-message arrival lands in the same task as the subsequent
 *    setMessages. That makes the switch atomic via React batching: Ink
 *    passes the LegacyRoot tag, but react-reconciler 0.33 (React 19)
 *    compiled legacy mode out, so the root runs in ConcurrentMode — a store
 *    notify and a setState issued in the same task auto-batch into ONE
 *    commit, flushed asynchronously after the task (verified empirically:
 *    1 render, 1 commit, nothing flushes synchronously). A presence notify
 *    routed through the coalesced path instead would fire in a LATER task,
 *    splitting clear and setMessages into two commits with a paintable
 *    duplicated-text gap between them (Ink's throttled stdout paint usually
 *    hides it, but that's timing, not a guarantee) — that's why presence
 *    bypasses the coalescing,
 *  - only the leaf that renders the text (StreamingTextRow in Messages.tsx)
 *    subscribes to the value; REPL subscribes to presence only, so per-delta
 *    reconciliation shrinks from the whole REPL tree to one small row.
 */

type Listener = () => void

let value: string | null = null
const listeners = new Set<Listener>()
let notifyTimer: ReturnType<typeof setTimeout> | null = null
let lastNotifyAt = 0

function notifyNow(): void {
  if (notifyTimer !== null) {
    clearTimeout(notifyTimer)
    notifyTimer = null
  }
  lastNotifyAt = Date.now()
  for (const listener of listeners) {
    listener()
  }
}

function scheduleNotify(): void {
  if (notifyTimer !== null) {
    return
  }
  const elapsed = Date.now() - lastNotifyAt
  if (elapsed >= FRAME_INTERVAL_MS) {
    // Leading edge: a fresh delta after an idle gap shows immediately.
    notifyNow()
    return
  }
  notifyTimer = setTimeout(notifyNow, FRAME_INTERVAL_MS - elapsed)
}

export const streamingTextStore = {
  /** Apply an updater (same shape the stream handler emits). Appends notify
   *  coalesced to the frame interval; presence flips notify synchronously. */
  update(f: (current: string | null) => string | null): void {
    const prev = value
    value = f(prev)
    if (value === prev) {
      return
    }
    if ((prev === null) !== (value === null)) {
      notifyNow()
    } else {
      scheduleNotify()
    }
  },
  /** Synchronous clear — used by turn resets; drops any pending notify. */
  clear(): void {
    streamingTextStore.update(() => null)
  },
  /** Read the freshest value without subscribing (no frame lag). */
  read(): string | null {
    return value
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  getSnapshot(): string | null {
    return value
  },
  getPresenceSnapshot(): boolean {
    return value !== null
  },
  /** Test-only: reset module-level state between cases. */
  resetForTesting(): void {
    if (notifyTimer !== null) {
      clearTimeout(notifyTimer)
      notifyTimer = null
    }
    value = null
    lastNotifyAt = 0
    listeners.clear()
  },
}

/** Subscribe to the full streaming text — leaf renderer only. */
export function useStreamingTextValue(): string | null {
  return useSyncExternalStore(
    streamingTextStore.subscribe,
    streamingTextStore.getSnapshot,
  )
}

/** Subscribe to presence only (null ↔ non-null) — re-renders twice per
 *  stream block instead of per delta. */
export function useStreamingTextPresence(): boolean {
  return useSyncExternalStore(
    streamingTextStore.subscribe,
    streamingTextStore.getPresenceSnapshot,
  )
}
