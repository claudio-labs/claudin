/**
 * Session-live accumulator for bytes removed from tool results before they
 * enter the model context (bash output filter, tool-result summarizer / JSON
 * compression, and large-output persistence). Surfaced as the "Context tokens
 * saved" line in the `/usage` Session tab.
 *
 * The token-saving features already compute these deltas, but the numbers were
 * only sent to `logEvent`, which is a no-op stub in the open build. This module
 * keeps a volatile per-session total so the savings are visible to the user.
 *
 * Volatile by design: resets with the session (wired into resetCostState). It
 * is NOT persisted across sessions — project-aggregate is a separate follow-up.
 */

let savedBytes = 0

/**
 * Record a single reduction. Only positive deltas count; a no-win transform
 * (kept >= raw) is ignored so we never report negative savings. Fail-safe:
 * non-finite inputs are dropped.
 */
export function recordBytesSaved(rawBytes: number, keptBytes: number): void {
  if (!Number.isFinite(rawBytes) || !Number.isFinite(keptBytes)) return
  const delta = rawBytes - keptBytes
  if (delta > 0) savedBytes += delta
}

/** Total bytes saved this session. Convert to tokens via BYTES_PER_TOKEN. */
export function getBytesSaved(): number {
  return savedBytes
}

/** Reset the session accumulator. Called from resetCostState. */
export function resetBytesSaved(): void {
  savedBytes = 0
}
