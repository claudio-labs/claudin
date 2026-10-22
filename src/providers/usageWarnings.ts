/**
 * The in-REPL usage-limit lines, one shape for every provider that reports a
 * limit:
 *
 *   Anthropic · weekly ▰▰▰▰▰▰▰▰▰▱ 92% · resets Oct 24, 3pm (in 2d 4h)
 *   Codex OAuth · 5h limit reached · resets 4:10pm (in 1h 12m)
 *
 * The provider comes first, named as the profile is (`getActiveProviderLabel`),
 * so the line reads the same as the provider's chip in /usage. Pure: callers
 * pass the clock.
 */
import {
  formatCountdownDuration,
  formatResetTime,
} from 'src/shared/text/format.js'

/** One usage window of one provider, as a warning needs it. */
export type LimitWindow = {
  /** Stable per window across responses (`codex:primary`, `seven_day`). */
  key: string
  /** `5h`, `weekly`, `session` … */
  label: string
  /** 0-100. */
  usedPercent: number
  resetsAtMs?: number
}

const BAR_CELLS = 10
const BAR_FILLED = '▰'
const BAR_EMPTY = '▱'

/** `▰▰▰▰▰▰▰▰▰▱` for 92%: one cell per tenth, rounded. */
export function formatUsageBar(usedPercent: number, cells: number = BAR_CELLS): string {
  const ratio = Math.min(100, Math.max(0, usedPercent)) / 100
  const filled = Math.round(ratio * cells)
  return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(cells - filled)
}

/**
 * ` · resets 3pm (in 2h 14m)` for a reset in the future, ` · resets 3pm` once
 * it has passed, and nothing at all with no timestamp. The remaining time is
 * what makes a wall-clock reset actionable — "3pm" alone says nothing about
 * how long that is from now.
 */
export function formatResetSuffix(
  resetsAtMs: number | undefined,
  nowMs: number = Date.now(),
): string {
  if (!resetsAtMs) return ''
  // No time zone: the countdown already says how far it is, and the line has
  // to share the footer row (Notifications.tsx never shrinks its column).
  const resetTime = formatResetTime(Math.floor(resetsAtMs / 1000))
  if (!resetTime) return ''
  const remainingMs = resetsAtMs - nowMs
  if (remainingMs <= 0) return ` · resets ${resetTime}`
  return ` · resets ${resetTime} (in ${formatCountdownDuration(remainingMs)})`
}

/** `Anthropic · weekly ▰▰▰▰▰▰▰▰▰▱ 92% · resets …` */
export function formatUsageWarning(
  providerLabel: string,
  window: LimitWindow,
  nowMs: number = Date.now(),
): string {
  const pct = Math.floor(Math.min(100, Math.max(0, window.usedPercent)))
  return `${providerLabel} · ${window.label} ${formatUsageBar(window.usedPercent)} ${pct}%${formatResetSuffix(window.resetsAtMs, nowMs)}`
}

/** The footer's standing reminder: `Anthropic weekly 92%`. */
export function formatUsageIndicator(
  providerLabel: string,
  window: LimitWindow,
): string {
  return `${providerLabel} ${window.label} ${Math.floor(window.usedPercent)}%`
}

/** `5h`, `weekly`, `30d` for a window's length; `fallback` when unknown. */
export function formatWindowDuration(
  windowMinutes: number | undefined,
  fallback: string,
): string {
  if (windowMinutes === undefined || windowMinutes <= 0) {
    return fallback
  }

  if (windowMinutes === 60 * 24 * 7) {
    return 'weekly'
  }

  if (windowMinutes % (60 * 24) === 0) {
    return `${windowMinutes / (60 * 24)}d`
  }

  if (windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}h`
  }

  return `${windowMinutes}m`
}

/**
 * `Anthropic · weekly limit reached · resets …`. `limitName` is the whole
 * noun phrase (`weekly limit`, `rate limit`), so every limit kind shares the
 * shape the router in rateLimitMessages.ts recognizes.
 */
export function formatLimitReached(
  providerLabel: string,
  limitName: string,
  resetSuffix: string,
): string {
  return `${providerLabel} · ${limitName} reached${resetSuffix}`
}

/** Thresholds the Codex CLI warns at, in used percent. */
export const CODEX_WARNING_THRESHOLDS: readonly number[] = [75, 90, 95]

/** The highest threshold already announced per window, and for which reset. */
export type ThresholdState = Readonly<
  Record<string, { threshold: number; resetsAtMs?: number }>
>

/**
 * How far apart two reports of one window's reset can be and still be the
 * same window. The Codex backend's `reset_at` drifts by seconds between
 * responses (1795289222 over HTTP, 1795289225 over the socket a minute
 * later, 2026-10-22); a real reset moves it by the whole window.
 */
const SAME_RESET_TOLERANCE_MS = 5 * 60_000

function isSameReset(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return Math.abs(a - b) <= SAME_RESET_TOLERANCE_MS
}

/**
 * The window that just crossed a threshold not yet announced for it — the
 * fullest one when several did — and the state to keep. Each threshold is
 * announced once per window; a new reset instant re-arms the window, and
 * falling back under the lowest threshold forgets it. 100% is the limit
 * itself, which the limit-reached message covers.
 */
export function crossedThreshold(
  windows: readonly LimitWindow[],
  state: ThresholdState,
  thresholds: readonly number[] = CODEX_WARNING_THRESHOLDS,
): { window?: LimitWindow; state: ThresholdState } {
  const next: Record<string, { threshold: number; resetsAtMs?: number }> = {
    ...state,
  }
  let crossed: LimitWindow | undefined
  for (const window of windows) {
    const reached = thresholds.filter(t => window.usedPercent >= t).at(-1)
    if (reached === undefined || window.usedPercent >= 100) {
      if (reached === undefined) delete next[window.key]
      continue
    }
    const prev = next[window.key]
    if (prev !== undefined && isSameReset(prev.resetsAtMs, window.resetsAtMs) && reached <= prev.threshold) {
      // Follow the drift, so it never adds up to a re-arm.
      next[window.key] = { threshold: prev.threshold, resetsAtMs: window.resetsAtMs }
      continue
    }
    next[window.key] = { threshold: reached, resetsAtMs: window.resetsAtMs }
    if (!crossed || window.usedPercent > crossed.usedPercent) crossed = window
  }
  return { window: crossed, state: next }
}

/**
 * The window the footer keeps on screen: the fullest one at or above
 * `floorPercent` whose reset has not passed.
 */
export function standingWindow(
  windows: readonly LimitWindow[],
  floorPercent: number,
  nowMs: number = Date.now(),
): LimitWindow | undefined {
  let fullest: LimitWindow | undefined
  for (const window of windows) {
    if (window.usedPercent < floorPercent) continue
    if (window.resetsAtMs !== undefined && window.resetsAtMs <= nowMs) continue
    if (!fullest || window.usedPercent > fullest.usedPercent) fullest = window
  }
  return fullest
}
