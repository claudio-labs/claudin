/**
 * Lagging cache marker — the second message-level `cache_control` that keeps
 * the server's lookback window able to find the previous request's write.
 *
 * On by default. `CLAUDIN_DISABLE_LAG_CACHE_MARKER=1` turns it off.
 *
 * Anthropic's prompt cache resolves a breakpoint by checking at most 20
 * positions behind it (the breakpoint itself is position 1; a run of
 * consecutive `tool_use` blocks is one position, a run of `tool_result`
 * blocks likewise). When nothing matches in that window, checking stops and
 * resumes at the NEXT explicit breakpoint — for us the system prompt — so the
 * whole message history is billed as a cache write again.
 *
 * `addCacheBreakpoints` emits exactly one message marker, deferred to the
 * earliest index whose suffix is ≥ 2048 estimated tokens. During a run of
 * tiny tool calls that marker crawls while the uncached tail grows to 15–30
 * messages; the next big block (a pasted screenshot, a Read that drags a rule
 * file in) moves the marker to the end in one step, 20+ positions past the
 * last entry, and the lookback misses. Session ab1e69e8 (2026-09-13) paid
 * seven of these — 3.06M of its 3.80M cache-write tokens, every one with
 * `cache_read` falling to exactly the system breakpoint and the client-side
 * detector reporting "prompt unchanged", which was true.
 *
 * The docs' answer is a second breakpoint "closer to that position from the
 * start so a write accumulates there before you need it". That is what this
 * module places: a marker on the message that carried the PREVIOUS request's
 * marker. It sits on content the server already holds, so it costs nothing
 * (breakpoints are free; only writes and reads bill), and when the lookback
 * from the main marker misses, it resumes here and finds the entry.
 *
 * The previous marker is remembered by message `uuid`, not index: a
 * `<available-deferred-tools>` prepend, stable stubs, a compaction or /clear
 * all leave a uuid either in place or absent — an absent uuid simply means no
 * lag marker this turn, no reset hook needed. A retry re-renders the same
 * request (same last-message uuid), so the state rotates only when the tail
 * has changed; otherwise the retry would coalesce the lag into the main
 * marker and lose the protection on the attempt that needs it.
 */

import type { AssistantMessage, UserMessage } from "src/shared/types/message.js";
import { isEnvTruthy } from "src/shared/envUtils.js";

/** The lookback window the API documents: positions checked per breakpoint. */
export const CACHE_LOOKBACK_POSITIONS = 20;

type LagState = {
  /** uuid of the message that carried the main marker on the request before
   *  the current one — where the lag goes while the current one is retried. */
  prevMarkerUuid: string | null;
  /** uuid of the message that carried the main marker on the current request. */
  markerUuid: string;
  /** uuid of the last message of the current request — same uuid means a retry. */
  lastMessageUuid: string;
};

const stateByKey = new Map<string, LagState>();
// Same cap as the break detector's previousStateBySource: sub-agents key on
// their agentId, so a busy session would otherwise grow this forever.
const MAX_TRACKED_KEYS = 10;

export function isLagMarkerEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDIN_DISABLE_LAG_CACHE_MARKER);
}

export type LagMarkerResult = {
  /** Index to carry the lagging marker, or undefined for none this request. */
  lagIndex: number | undefined;
  /**
   * Positions (as the API counts them) between the previous request's marker
   * and this one. Undefined when there is no previous marker to measure from.
   * ≥ CACHE_LOOKBACK_POSITIONS is the case the lag marker exists for.
   */
  advancedPositions: number | undefined;
};

/**
 * Resolve where the lagging marker goes for this request and rotate the
 * per-key state. `markerIndex` is the main marker's FINAL index (after the
 * defer walk and the clip-frontier cap).
 */
export function resolveLagMarker(
  key: string,
  messages: readonly (UserMessage | AssistantMessage)[],
  markerIndex: number,
): LagMarkerResult {
  const none: LagMarkerResult = { lagIndex: undefined, advancedPositions: undefined };
  if (messages.length === 0 || markerIndex < 0 || markerIndex >= messages.length) {
    return none;
  }
  const markerUuid = messages[markerIndex]!.uuid;
  const lastMessageUuid = messages[messages.length - 1]!.uuid;
  const prev = stateByKey.get(key);

  if (!prev) {
    remember(key, { prevMarkerUuid: null, markerUuid, lastMessageUuid });
    return none;
  }

  // A retry re-renders the same tail: keep pointing at the marker the
  // previous request wrote, don't rotate onto this attempt's own marker.
  const isRetry = prev.lastMessageUuid === lastMessageUuid;
  const lagUuid = isRetry ? prev.prevMarkerUuid : prev.markerUuid;
  if (!isRetry) {
    remember(key, { prevMarkerUuid: prev.markerUuid, markerUuid, lastMessageUuid });
  }
  if (lagUuid === null) return none;

  const prevIndex = findIndexByUuid(messages, lagUuid, markerIndex);
  if (prevIndex === undefined) return none;

  const advancedPositions = countPositions(messages, prevIndex, markerIndex);
  // Same message as the main marker (the defer walk did not move): one
  // marker on the wire, nothing to lag to.
  const lagIndex = prevIndex < markerIndex ? prevIndex : undefined;
  return { lagIndex, advancedPositions };
}

/**
 * Walk backward from `upTo` looking for the message with `uuid`. The previous
 * marker is never far behind the current one, so this is a short scan in the
 * common case and a full one only after a compaction dropped the message.
 */
function findIndexByUuid(
  messages: readonly (UserMessage | AssistantMessage)[],
  uuid: string,
  upTo: number,
): number | undefined {
  for (let i = upTo; i >= 0; i -= 1) {
    if (messages[i]!.uuid === uuid) return i;
  }
  return undefined;
}

/**
 * Positions between two marker indexes, counted the way the API's lookback
 * counts them: every content block is a position, except that a run of
 * consecutive `tool_use` blocks collapses to one and a run of consecutive
 * `tool_result` blocks collapses to one. Counts the blocks of
 * (fromExclusive, toInclusive].
 */
export function countPositions(
  messages: readonly (UserMessage | AssistantMessage)[],
  fromExclusive: number,
  toInclusive: number,
): number {
  let positions = 0;
  let runType: string | null = null;
  for (let i = fromExclusive + 1; i <= toInclusive; i += 1) {
    const content = messages[i]!.message.content;
    if (typeof content === "string") {
      positions += 1;
      runType = null;
      continue;
    }
    for (const block of content) {
      const type = block.type;
      if (type === "tool_use" || type === "tool_result") {
        if (runType !== type) positions += 1;
        runType = type;
      } else {
        positions += 1;
        runType = null;
      }
    }
  }
  return positions;
}

function remember(key: string, state: LagState): void {
  if (!stateByKey.has(key)) {
    while (stateByKey.size >= MAX_TRACKED_KEYS) {
      const oldest = stateByKey.keys().next().value;
      if (oldest === undefined) break;
      stateByKey.delete(oldest);
    }
  }
  stateByKey.set(key, state);
}

export function _resetLagMarkerStateForTesting(): void {
  stateByKey.clear();
}
