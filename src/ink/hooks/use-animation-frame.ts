import { useContext, useEffect, useState } from 'react'
import { ClockContext } from '../components/ClockContext.js'
import type { DOMElement } from '../dom.js'
import { useTerminalViewport } from './use-terminal-viewport.js'

/**
 * Hook for synchronized animations that pause when offscreen.
 *
 * Returns a ref to attach to the animated element and the current animation time.
 * All instances share the same clock, so animations stay in sync.
 * The clock only runs when at least one keepAlive subscriber exists.
 *
 * Pass `null` to pause — unsubscribes from the clock so no ticks fire.
 * Time freezes at the last value and resumes from the current clock time
 * when a number is passed again. Pass `0` for "every tick", letting the clock's
 * own interval be the rate limiter — passing the tick interval itself would
 * drop roughly every other tick to timer jitter.
 *
 * While the element is scrolled offscreen the time is held (no re-render, so no
 * scrollback flicker), but the subscription stays alive and polls visibility
 * each tick, so the animation resumes on its own the moment the element scrolls
 * back into view. (Visibility isn't reactive, so we can't rely on a re-render
 * to notice the return — without this poll the frame would stay frozen until
 * some unrelated re-render, e.g. a focus change or keypress, unsticks it.)
 *
 * @param intervalMs - How often to update, or null to pause
 * @returns [ref, time] - Ref to attach to element, elapsed time in ms
 *
 * @example
 * function Spinner() {
 *   const [ref, time] = useAnimationFrame(120)
 *   const frame = Math.floor(time / 120) % FRAMES.length
 *   return <Box ref={ref}>{FRAMES[frame]}</Box>
 * }
 *
 * The clock automatically slows when the terminal is blurred,
 * so consumers don't need to handle focus state.
 */
export function useAnimationFrame(
  intervalMs: number | null = 16,
): [ref: (element: DOMElement | null) => void, time: number] {
  const clock = useContext(ClockContext)
  const [viewportRef, , isVisibleNow] = useTerminalViewport()
  const [time, setTime] = useState(() => clock?.now() ?? 0)

  const active = intervalMs !== null

  useEffect(() => {
    if (!clock || !active) return

    let lastUpdate = clock.now()

    const onChange = (): void => {
      // Held offscreen: skip the re-render (avoids scrollback flicker) but keep
      // polling, so we resume the instant the element scrolls back into view.
      if (!isVisibleNow()) return
      const now = clock.now()
      if (now - lastUpdate >= intervalMs!) {
        lastUpdate = now
        setTime(now)
      }
    }

    // keepAlive: true — animations drive the clock
    return clock.subscribe(onChange, true)
  }, [clock, intervalMs, active, isVisibleNow])

  return [viewportRef, time]
}
