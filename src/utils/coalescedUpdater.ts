import { FRAME_INTERVAL_MS } from 'src/ink/constants.js'

export type CoalescedUpdater<T> = {
  /** Queue a functional update. Order is preserved across flushes. */
  enqueue(f: (prev: T) => T): void
  /** Apply everything queued, now, as a single composed update. */
  flush(): void
  /** Drop everything queued without applying (stale stream teardown). */
  cancel(): void
}

/**
 * Coalesces functional state updates to one `apply` call per frame interval
 * (leading + trailing, mirroring Ink's paint throttle). Used for per-chunk
 * stream state (e.g. streamingToolUses on input_json_delta) where each
 * network chunk would otherwise trigger a full React commit: Ink's 16 ms
 * throttle caps stdout paints, but reconciliation + yoga layout run once per
 * setState. Updaters compose in arrival order, so reset-then-append
 * sequences behave identically to the uncoalesced path — callers only need
 * to `flush()` before state the queue must precede (final message arrival)
 * and `cancel()` when the owning stream is torn down.
 */
export function createCoalescedUpdater<T>(
  apply: (f: (prev: T) => T) => void,
  intervalMs: number = FRAME_INTERVAL_MS,
): CoalescedUpdater<T> {
  let pending: Array<(prev: T) => T> = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastFlushAt = 0

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function flush(): void {
    clearTimer()
    if (pending.length === 0) {
      return
    }
    const fns = pending
    pending = []
    lastFlushAt = Date.now()
    apply(prev => {
      let acc = prev
      for (const f of fns) {
        acc = f(acc)
      }
      return acc
    })
  }

  return {
    enqueue(f: (prev: T) => T): void {
      pending.push(f)
      if (timer !== null) {
        return
      }
      const elapsed = Date.now() - lastFlushAt
      if (elapsed >= intervalMs) {
        // Leading edge: first update after an idle gap applies immediately.
        flush()
        return
      }
      timer = setTimeout(flush, intervalMs - elapsed)
    },
    flush,
    cancel(): void {
      clearTimer()
      pending = []
    },
  }
}
