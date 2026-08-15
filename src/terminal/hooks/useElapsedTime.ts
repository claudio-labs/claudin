import { useCallback, useRef, useSyncExternalStore } from 'react'
import { formatDuration } from 'src/shared/text/format.js'

/**
 * Hook that returns formatted elapsed time since startTime.
 * Uses useSyncExternalStore with interval-based updates for efficiency.
 *
 * @param startTime - Unix timestamp in ms
 * @param isRunning - Whether to actively update the timer
 * @param ms - How often should we trigger updates?
 * @param pausedMs - Total paused duration to subtract
 * @param endTime - If set, freezes the duration at this timestamp (for
 *   terminal tasks). Without this, viewing a 2-min task 30 min after
 *   completion would show "32m".
 * @returns Formatted duration string (e.g., "1m 23s")
 */
export function useElapsedTime(
  startTime: number,
  isRunning: boolean,
  ms: number = 1000,
  pausedMs: number = 0,
  endTime?: number,
): string {
  const get = () =>
    formatDuration(Math.max(0, (endTime ?? Date.now()) - startTime - pausedMs))

  const subscribe = useCallback(
    (notify: () => void) => {
      if (!isRunning) return () => {}
      const interval = setInterval(notify, ms)
      return () => clearInterval(interval)
    },
    [isRunning, ms],
  )

  return useSyncExternalStore(subscribe, get, get)
}

/**
 * Whole seconds elapsed since startTime, re-rendering on an interval.
 *
 * Floors to the second so a live stopwatch ticks `1s → 2s` instead of walking
 * through formatDuration's sub-second decimals (`0.4s`, `0.9s`), and so the
 * caller can decide what to do below one second.
 *
 * @param startTime - Unix timestamp in ms
 * @param isRunning - Whether to actively update the timer
 * @param ms - How often should we trigger updates?
 */
export function useElapsedSeconds(
  startTime: number,
  isRunning: boolean,
  ms: number = 1000,
): number {
  const get = () => Math.max(0, Math.floor((Date.now() - startTime) / 1000))

  const subscribe = useCallback(
    (notify: () => void) => {
      if (!isRunning) return () => {}
      const interval = setInterval(notify, ms)
      return () => clearInterval(interval)
    },
    [isRunning, ms],
  )

  return useSyncExternalStore(subscribe, get, get)
}

/**
 * Whole seconds elapsed for a run that was already going before this mount.
 *
 * The clock ticks locally, so it keeps moving even when whatever reports
 * `reportedSeconds` (a shell's output poller) goes quiet or hasn't started
 * yet. The reported value only ever moves the anchor *earlier*: a remount
 * restarts the local count at zero, and that is what recovers the real start.
 *
 * @param reportedSeconds - Elapsed seconds as last reported by an external
 *   poller, if any
 */
export function useAnchoredElapsedSeconds(reportedSeconds?: number): number {
  const reportedMs = (reportedSeconds ?? 0) * 1000
  const startedAtRef = useRef(Date.now() - reportedMs)
  if (Date.now() - startedAtRef.current < reportedMs) {
    startedAtRef.current = Date.now() - reportedMs
  }
  return useElapsedSeconds(startedAtRef.current, true)
}
