/**
 * The Codex plan's usage windows as the last response reported them: the
 * `x-codex-*` headers over HTTP, the `codex.rate_limits` event over the
 * socket (both normalized by usage/codexUsage.ts into the type /usage shows).
 * Fed only by the Codex shim; read by the in-REPL limit warning.
 *
 * The store also runs the warning policy, so a threshold is announced once
 * however many renders read it: the Codex CLI's 75/90/95%, once per window.
 */
import isEqual from 'lodash-es/isEqual.js'

import {
  type CodexUsageData,
  type CodexUsageWindow,
} from 'src/providers/usage/codexUsage.js'
import {
  crossedThreshold,
  formatWindowDuration,
  type LimitWindow,
  type ThresholdState,
} from 'src/providers/usageWarnings.js'

let current: CodexUsageData | undefined
let thresholds: ThresholdState = {}
let announced: { id: number; window: LimitWindow } | undefined
let announcements = 0
const listeners = new Set<() => void>()

function toLimitWindow(
  key: string,
  window: CodexUsageWindow,
): LimitWindow {
  const resetsAtMs = window.resetsAt ? Date.parse(window.resetsAt) : NaN
  return {
    key,
    label: formatWindowDuration(window.windowMinutes, 'usage'),
    usedPercent: window.usedPercent,
    resetsAtMs: Number.isFinite(resetsAtMs) ? resetsAtMs : undefined,
  }
}

/** Every window the data names, keyed stably across responses. */
export function codexLimitWindows(data: CodexUsageData): LimitWindow[] {
  const windows: LimitWindow[] = []
  for (const snapshot of data.snapshots) {
    if (snapshot.primary) windows.push(toLimitWindow(`${snapshot.limitName}:primary`, snapshot.primary))
    if (snapshot.secondary) windows.push(toLimitWindow(`${snapshot.limitName}:secondary`, snapshot.secondary))
  }
  return windows
}

/** What the last Codex response said; a repeat of it notifies nobody. */
export function recordCodexLimits(data: CodexUsageData | undefined): void {
  if (!data || data.snapshots.length === 0 || isEqual(data, current)) return
  current = data
  const crossed = crossedThreshold(codexLimitWindows(data), thresholds)
  thresholds = crossed.state
  if (crossed.window) announced = { id: ++announcements, window: crossed.window }
  for (const listener of listeners) listener()
}

export function getCodexLimits(): CodexUsageData | undefined {
  return current
}

/** The last threshold crossing, with an id that changes once per crossing. */
export function getCodexAnnouncement(): { id: number; window: LimitWindow } | undefined {
  return announced
}

export function subscribeCodexLimits(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function resetCodexLimitsForTesting(): void {
  current = undefined
  thresholds = {}
  announced = undefined
  listeners.clear()
}
