// How long the main loop stays on its fallback model after the primary gave
// way. withRetry.ts decides when it gives way, and fallbackModel.ts which model
// takes over. Ten minutes, the floor withRetry.ts's fast-mode cooldown uses
// too: long enough that a sustained outage does not cost every turn its
// retries again, short enough that the loop is back on the primary soon after
// it recovers. Process-wide, keyed by the primary→fallback pair.

export const FALLBACK_HOLD_MS = 10 * 60 * 1000

const holds = new Map<string, number>()

const holdKey = (primary: string, fallback: string): string =>
  `${primary}\0${fallback}`

/** The primary gave way to the fallback at `now`: hold the fallback from here. */
export function holdFallback(
  primary: string,
  fallback: string,
  now: number = Date.now(),
): void {
  holds.set(holdKey(primary, fallback), now + FALLBACK_HOLD_MS)
}

/** Whether a loop on `primary` should start on `fallback` instead, at `now`. */
export function isFallbackHeld(
  primary: string,
  fallback: string,
  now: number = Date.now(),
): boolean {
  const key = holdKey(primary, fallback)
  const until = holds.get(key)
  if (until === undefined) return false
  if (now < until) return true
  holds.delete(key)
  return false
}

export function _resetFallbackHoldsForTesting(): void {
  holds.clear()
}

/**
 * The user picked a model (/model): whatever they chose is what the loop
 * runs on, the primary they gave up on included, so every hold ends.
 */
export function clearFallbackHolds(): void {
  holds.clear()
}
