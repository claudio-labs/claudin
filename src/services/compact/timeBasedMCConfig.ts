import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { getCacheProfile } from '../cache/cacheProfile.js'

/**
 * GrowthBook config for time-based microcompact.
 *
 * Triggers content-clearing microcompact when the gap since the last main-loop
 * assistant message exceeds a threshold — the server-side prompt cache has
 * almost certainly expired, so the full prefix will be rewritten anyway.
 * Clearing old tool results before the request shrinks what gets rewritten.
 *
 * Runs BEFORE the API call (in microcompactMessages, upstream of callModel)
 * so the shrunk prompt is what actually gets sent. Running after the first
 * miss would only help subsequent turns.
 *
 * Main thread only — subagents have short lifetimes where gap-based eviction
 * doesn't apply.
 */
export type TimeBasedMCConfig = {
  /** Master switch. When false, time-based microcompact is a no-op. */
  enabled: boolean
  /** Trigger when (now − last assistant timestamp) exceeds this many minutes.
   *  60 is the safe choice: the server's 1h cache TTL is guaranteed expired
   *  for all users, so we never force a miss that wouldn't have happened. */
  gapThresholdMinutes: number
  /** Keep this many most-recent compactable tool results.
   *  When set, takes priority over any default; older results are cleared. */
  keepRecent: number
}

export function getTimeBasedMCConfig(): TimeBasedMCConfig {
  // Defaults come from the cache profile: under 'retain' the idle-gap clear
  // is the cheap moment to clip (cache already expired); under 'aggressive'
  // the age prune has already stubbed everything old, so it stays off.
  // Claudin's GrowthBook is a no-telemetry stub that returns the fallback,
  // so the profile values ARE the effective config.
  const profile = getCacheProfile()
  const defaults: TimeBasedMCConfig = {
    enabled: profile.timeBasedClipEnabled,
    gapThresholdMinutes: profile.timeBasedGapMinutes,
    keepRecent: profile.timeBasedKeepRecent,
  }
  // Hoist the GB read so exposure fires on every eval path, not just when
  // the caller's other conditions (querySource, messages.length) pass.
  return getFeatureValue_CACHED_MAY_BE_STALE<TimeBasedMCConfig>(
    'tengu_slate_heron',
    defaults,
  )
}
