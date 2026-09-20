/**
 * Context relief — the ONE decision that clips old tool_results.
 *
 * On by default. `CLAUDIN_DISABLE_RELIEF_POLICY=1` turns off the window lane
 * only; the RSS lane, the idle-gap clip and autocompact keep running, so the
 * killswitch leaves a safe state rather than the pre-policy one.
 *
 * Before this module there were four client-side mechanisms that did not
 * know about each other (an estimate-driven stable-stub clip, an RSS
 * byte-guard, a stub-only message eviction and a display-cap eviction), each
 * with its own unit and trigger, two of which DROPPED messages from the API
 * view with no stub. `docs/tech/cache/context-relief-policy.md` measured what
 * that cost over a week of sessions. Now:
 *
 *   one trigger   — real usage (`tokenCountWithEstimation`: the previous
 *                   response's usage plus an estimate of the tail), never the
 *                   pure client estimate that drifts 30%+ on code;
 *   two lanes     — `window`: usage crossed a fraction of the effective
 *                   window (capped below autocompact so the cheap clip
 *                   pre-empts the expensive wipe); `rss`: retained full
 *                   tool_results exceed the profile's high water (a memory
 *                   bound, reachable only on 1M-window models);
 *   one action    — add the oldest clearable tool_use ids to the stable-stub
 *                   clipped set (`stableStubState.ts`). The wire path rewrites
 *                   them to byte-stable stubs that keep the head, so the
 *                   cache breaks once per event and the model can still see
 *                   that the result existed. Nothing is ever dropped.
 *
 * The clip is decided pre-request (`microCompact.ts`) and applied at the wire
 * on that same request, so the next response's usage already reflects it —
 * no hysteresis state is needed: the band `B` below the trigger is what
 * spaces the events (`B* ≈ sqrt(2·w·R·g / r)` ≈ 60k at Anthropic prices; the
 * cost curve is flat around it, see the design doc).
 *
 * Pure: everything here is a function of its input. The shell that reads
 * the profile, the model window and the messages lives in microCompact.ts.
 */

import type { CacheProfile } from 'src/agent/cache/cacheProfile.js'

export type ReliefLane = 'window' | 'rss'

export type ReliefProfile = Pick<
  CacheProfile,
  | 'sizeStubThresholdFraction'
  | 'reliefBandTokens'
  | 'retainedHighWaterTokens'
  | 'retainedLowWaterTokens'
>

export type ReliefInput = {
  /** Real usage of the conversation as the next request will see it. */
  usedTokens: number
  effectiveWindow: number
  /** null when autocompact is disabled (nothing to pre-empt). */
  autocompactThreshold: number | null
  /** Estimated tokens of full, clearable tool_results still in the array. */
  retainedFullResultTokens: number
  profile: ReliefProfile
  windowLaneEnabled: boolean
}

export type ReliefDecision =
  | { kind: 'none' }
  | {
      kind: 'clip'
      lane: ReliefLane
      /** How much the selected clips must free (estimated tokens). */
      tokensToFree: number
      trigger: number
      target: number
    }

/** A clearable tool_result, oldest first, with what stubbing it frees. */
export type ReliefCandidate = {
  toolUseId: string
  savings: number
  /** The tool_use's `clearableInputFields`, when clipping this id also
   * stubs its input (Tool.ts). Absent for a result-only candidate. */
  inputFields?: readonly string[]
  /** Set when the candidate has NO clearable result side (apply_patch: a
   * 4k patch and a one-line "Success"). Such an id goes into the clipped
   * INPUTS registry only — never into the result set, whose explicit-clip
   * contract stubs regardless of size. */
  inputOnly?: true
}

// The window trigger sits below the autocompact threshold by a margin that
// scales with the window: a fixed margin either starves small windows (20k
// out of a 40k bench window) or is too thin on a 1M one (a single big Read
// is ~20k). 10% of the effective window, clamped to [5k, 20k].
export const RELIEF_MARGIN_MIN_TOKENS = 5_000
export const RELIEF_MARGIN_MAX_TOKENS = 20_000
const RELIEF_MARGIN_FRACTION = 0.1

// The band never eats more than this fraction of the trigger, so a small
// window still keeps most of its context after a clip.
const RELIEF_BAND_MAX_FRACTION = 0.3

// Below this fraction of the trigger the profile's fixed band is used; above
// it the band grows with the window. 60k was sized for a 200k window (B* ≈
// sqrt(2·w·R·g/r) in the design doc); on a 1M window the same 60k under a
// 750k trigger spaced clip events so closely that a session at its floor
// fired one every request, and each event is a full-prefix rewrite (~$7 at
// 730k). 0.15 leaves windows up to ~400k on the fixed band and gives the
// 1M window a 112k band.
const RELIEF_BAND_TRIGGER_FRACTION = 0.15

// An event that can free less than this is not worth a prefix rewrite. When
// the clearable candidates are exhausted (every old result already a stub,
// the rest inside the protected window) the policy would otherwise clip one
// tiny result per request for ~0k each — 140 such events in one session —
// and report each as a rewrite. Below the floor the caller records the
// session as starved instead of clipping.
export const RELIEF_MIN_EVENT_TOKENS = 4_000

export function reliefMargin(effectiveWindow: number): number {
  return Math.min(
    RELIEF_MARGIN_MAX_TOKENS,
    Math.max(RELIEF_MARGIN_MIN_TOKENS, effectiveWindow * RELIEF_MARGIN_FRACTION),
  )
}

/**
 * The window-lane trigger: the profile's fraction of the effective window,
 * capped a margin below autocompact so the clip fires first. 0 when the
 * window is unknown.
 */
export function reliefTrigger(
  effectiveWindow: number,
  autocompactThreshold: number | null,
  fraction: number,
): number {
  if (!(effectiveWindow > 0)) return 0
  const fractionTrigger = fraction * effectiveWindow
  if (autocompactThreshold === null) return fractionTrigger
  const cap = autocompactThreshold - reliefMargin(effectiveWindow)
  return cap > 0 ? Math.min(fractionTrigger, cap) : fractionTrigger
}

export function decideRelief(input: ReliefInput): ReliefDecision {
  const { profile } = input
  let best: ReliefDecision = { kind: 'none' }

  if (input.windowLaneEnabled) {
    const trigger = reliefTrigger(
      input.effectiveWindow,
      input.autocompactThreshold,
      profile.sizeStubThresholdFraction,
    )
    if (trigger > 0 && input.usedTokens > trigger) {
      const band = Math.min(
        Math.max(
          profile.reliefBandTokens,
          trigger * RELIEF_BAND_TRIGGER_FRACTION,
        ),
        trigger * RELIEF_BAND_MAX_FRACTION,
      )
      const target = trigger - band
      best = {
        kind: 'clip',
        lane: 'window',
        tokensToFree: input.usedTokens - target,
        trigger,
        target,
      }
    }
  }

  if (
    Number.isFinite(profile.retainedHighWaterTokens) &&
    input.retainedFullResultTokens > profile.retainedHighWaterTokens
  ) {
    const tokensToFree =
      input.retainedFullResultTokens - profile.retainedLowWaterTokens
    // Both lanes fired: one clip event, sized by whichever asks for more.
    if (best.kind === 'none' || tokensToFree > best.tokensToFree) {
      best = {
        kind: 'clip',
        lane: 'rss',
        tokensToFree,
        trigger: profile.retainedHighWaterTokens,
        target: profile.retainedLowWaterTokens,
      }
    }
  }

  return best
}

/**
 * Oldest-first, stop as soon as the accumulated savings cover the request.
 * Candidates are already in array order; a candidate that frees nothing is
 * skipped rather than clipped for no gain.
 */
export function selectReliefIds(
  candidates: readonly ReliefCandidate[],
  tokensToFree: number,
): { ids: string[]; savings: number; selected: ReliefCandidate[] } {
  const ids: string[] = []
  const selected: ReliefCandidate[] = []
  let savings = 0
  for (const c of candidates) {
    if (savings >= tokensToFree) break
    if (c.savings <= 0) continue
    ids.push(c.toolUseId)
    selected.push(c)
    savings += c.savings
  }
  return { ids, savings, selected }
}

export function isReliefWindowLaneEnabled(): boolean {
  const v = process.env.CLAUDIN_DISABLE_RELIEF_POLICY
  return !(v === '1' || v === 'true')
}
