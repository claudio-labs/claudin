import { useEffect, useState } from 'react'

/**
 * Animates a numeric value toward a target by ramping up `step` units every
 * `intervalMs` milliseconds. Used to make growing counters (e.g. token totals)
 * feel "alive" rather than snapping to the latest value.
 *
 * Resets to 0 when the target drops to 0.
 */
export function useRampedNumber(
  target: number,
  step: number = 500,
  intervalMs: number = 100,
): number {
  const [displayed, setDisplayed] = useState(0)
  useEffect(() => {
    if (target === 0) {
      setDisplayed(0)
      return
    }
    // Snap down immediately when the target shrinks (e.g. a task drops out of
    // an aggregate sum); only ramp upward.
    setDisplayed(prev => (prev > target ? target : prev))
    const id = setInterval(() => {
      setDisplayed(prev => {
        if (prev >= target) return prev
        return Math.min(target, prev + step)
      })
    }, intervalMs)
    return () => clearInterval(id)
  }, [target, step, intervalMs])
  return displayed
}
