/**
 * Whether an end of turn dreams, as pure decisions. The session scan is the
 * only costly fact, so the decision comes in two steps: everything that can
 * stop a dream before the scan, then what the scan found.
 */

export type DreamThresholds = {
  /** Hours since the last consolidation before another one is due. */
  readonly minHours: number
  /** Other sessions touched since the last consolidation. */
  readonly minSessions: number
  /** The least time between two scans of the session directory. */
  readonly scanIntervalMs: number
}

export type ScheduleFacts = {
  readonly gatesOpen: boolean
  readonly now: number
  /** 0 when no consolidation is on record. */
  readonly lastConsolidatedAt: number
  /** Undefined until the first scan of this schedule. */
  readonly lastScanAt: number | undefined
}

export type BeforeScan =
  | { readonly kind: 'closed' }
  | { readonly kind: 'notDue' }
  | { readonly kind: 'throttled' }
  | { readonly kind: 'scan' }

export type AfterScan =
  | { readonly kind: 'tooFewSessions'; readonly count: number }
  | { readonly kind: 'due'; readonly sessionIds: readonly string[]; readonly lastAt: number }

type DreamDecision = Exclude<BeforeScan, { kind: 'scan' }> | AfterScan

const HOUR_MS = 60 * 60 * 1000

export function decideBeforeScan(facts: ScheduleFacts, thresholds: DreamThresholds): BeforeScan {
  if (!facts.gatesOpen) return { kind: 'closed' }
  if (facts.now - facts.lastConsolidatedAt < thresholds.minHours * HOUR_MS) return { kind: 'notDue' }
  if (facts.lastScanAt !== undefined && facts.now - facts.lastScanAt < thresholds.scanIntervalMs) {
    return { kind: 'throttled' }
  }
  return { kind: 'scan' }
}

/** `otherSessionIds` are the sessions the scan found, the current one already left out. */
export function decideAfterScan(
  otherSessionIds: readonly string[],
  lastConsolidatedAt: number,
  thresholds: DreamThresholds,
): AfterScan {
  return otherSessionIds.length < thresholds.minSessions
    ? { kind: 'tooFewSessions', count: otherSessionIds.length }
    : { kind: 'due', sessionIds: otherSessionIds, lastAt: lastConsolidatedAt }
}
