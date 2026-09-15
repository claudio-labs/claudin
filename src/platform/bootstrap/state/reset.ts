/**
 * resetStateForTests — the only writer that touches every cluster at once.
 *
 * It copies a fresh getInitialState() over the singleton, so any STATE field
 * is covered wherever its accessors ended up. The three turn-token values in
 * cost.ts are NOT STATE fields, so they need the explicit hook below; that
 * asymmetry is the whole reason this lives in its own module instead of beside
 * the store.
 */
import { resetTurnTokenState } from 'src/platform/bootstrap/state/cost.js'
import {
  getInitialState,
  STATE,
} from 'src/platform/bootstrap/state/store.js'
import type { State } from 'src/platform/bootstrap/state/types.js'

// Only used in tests
export function resetStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetStateForTests can only be called in tests')
  }
  Object.entries(getInitialState()).forEach(([key, value]) => {
    STATE[key as keyof State] = value as never
  })
  resetTurnTokenState()
  // Deliberately NOT sessionSwitched.clear(). Its three subscribers —
  // stableStubState's clipped-id map, loopSentinels' first-fire memory,
  // concurrentSessions' PID file — subscribe at module load and never
  // re-subscribe, so clearing here unsubscribed them for the REST of the
  // process: every later file in the same runner then asserted eviction
  // against a dead signal, and whether it broke depended on whether the
  // module happened to load before this call. registerSession() drops its
  // own previous listener now, which is the leak the clear was really for.
}
