import type { PrStatus } from 'src/vcs/git/ghPrStatus.js'
import type { PrStatusState } from 'src/vcs/hooks/usePrStatus.js'

/** No pull request known. The pill starts this way, stamped 0. */
export function emptyPill(lastUpdated = 0): PrStatusState {
  return { number: null, url: null, reviewState: null, label: null, lastUpdated }
}

/**
 * The pill after an answer from the code host, stamped `now` when anything it
 * shows changed. When nothing did, the very same object comes back, so React
 * skips the render. The URL counts as shown (finding 7).
 */
export function pillAfterAnswer(current: PrStatusState, answer: PrStatus | null, now: number): PrStatusState {
  const next: PrStatusState = answer ? { ...answer, lastUpdated: now } : emptyPill(now)
  const unchanged =
    next.number === current.number &&
    next.url === current.url &&
    next.reviewState === current.reviewState &&
    next.label === current.label
  return unchanged ? current : next
}
