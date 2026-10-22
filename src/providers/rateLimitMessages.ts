/**
 * Centralized rate limit message generation
 * Single source of truth for all rate limit-related messages
 *
 * Every message names the provider first, the way its chip reads in /usage:
 * `Anthropic · weekly limit reached · resets …`, `OpenRouter · rate limit
 * reached · resets in 42s`, `Codex OAuth · 5h ▰▰▰▰▰▰▰▰▱▱ 76% · resets …`.
 */

import {
  getOauthAccountInfo,
  getSubscriptionType,
} from 'src/providers/auth/auth.js'
import { hasClaudeAiBillingAccess } from 'src/providers/usage/billing.js'
import { formatCountdownDuration } from 'src/shared/text/format.js'
import type { ClaudeAILimits, RateLimitType } from 'src/providers/claudeAiLimits.js'
import type { RateLimitInfo } from 'src/providers/rateLimitInfo.js'
import {
  formatLimitReached,
  formatResetSuffix,
  formatUsageWarning,
  type LimitWindow,
} from 'src/providers/usageWarnings.js'

/**
 * The shape every limit message has — `<provider> · <what happened>` — so the
 * renderer can tell one from ordinary text. Built from the same phrases the
 * formatters below use.
 */
const LIMIT_EVENT_PHRASES = [
  '[\\w ]*limit reached',
  'quota exhausted',
  'out of extra usage',
  'now using extra usage',
  'close to your extra usage spending limit',
]
const LIMIT_MESSAGE_RE = new RegExp(
  `^[^·\\n]{1,80} · (?:${LIMIT_EVENT_PHRASES.join('|')})(?: · |$)`,
)

/**
 * How limit messages started before they named the provider first. A resumed
 * transcript still carries them, so they keep routing to the limit renderer.
 */
const LEGACY_LIMIT_PREFIXES = [
  "You've hit your",
  "You've used",
  "You're now using extra usage",
  "You're close to",
  "You're out of extra usage",
  'Rate limit reached',
  'Quota exhausted',
] as const

/**
 * Check if a message is a rate limit error
 */
export function isRateLimitErrorMessage(text: string): boolean {
  return (
    LIMIT_MESSAGE_RE.test(text) ||
    LEGACY_LIMIT_PREFIXES.some(prefix => text.startsWith(prefix))
  )
}

/**
 * `OpenAI · rate limit reached` — everything before the part that changes as
 * the clock runs down. Exported so the renderer can tell whether the limit
 * currently in force is the one a given transcript message is about.
 */
export function formatProviderLimitHead(
  info: RateLimitInfo,
  providerLabel: string,
): string {
  if (info.kind === 'exhausted') return `${providerLabel} · quota exhausted`
  return `${providerLabel} · ${info.limitName ?? 'rate limit'} reached`
}

/** The part that changes: the remaining time, or why there isn't one. */
export function formatProviderLimitTail(
  info: RateLimitInfo,
  nowMs: number = Date.now(),
): string {
  if (info.kind === 'exhausted') {
    return 'enable billing for this provider, or switch with /provider'
  }
  if (info.resetsAtMs === undefined) {
    // With no clock to show, the provider's own wording is the only
    // information there is — and `errorDetails` is not rendered anywhere, so
    // putting it there would drop it on the floor. This is the case that used
    // to read "Request rejected (429) · <detail>".
    return info.detail === undefined
      ? 'no reset time reported'
      : `${info.detail} · no reset time reported`
  }
  const remainingMs = info.resetsAtMs - nowMs
  if (remainingMs <= 0) {
    return 'the limit should have cleared — try again'
  }
  return `resets in ${formatCountdownDuration(remainingMs)}`
}

/**
 * The one message every provider gets when a request is rate limited:
 * `OpenAI · rate limit reached · resets in 2h 14m`.
 */
export function formatProviderLimitMessage(
  info: RateLimitInfo,
  providerLabel: string,
  nowMs: number = Date.now(),
): string {
  return `${formatProviderLimitHead(info, providerLabel)} · ${formatProviderLimitTail(info, nowMs)}`
}

export type RateLimitMessage = {
  message: string
  severity: 'error' | 'warning'
}

/** Pro and Enterprise have one weekly limit, so their Sonnet limit is it. */
function sonnetIsWeekly(): boolean {
  const subscriptionType = getSubscriptionType()
  return subscriptionType === 'pro' || subscriptionType === 'enterprise'
}

/** The window a Claude limit type is: `session`, `weekly`, `weekly Opus` … */
export function claudeWindowLabel(type: RateLimitType | undefined): string | undefined {
  switch (type) {
    case 'five_hour':
      return 'session'
    case 'seven_day':
      return 'weekly'
    case 'seven_day_opus':
      return 'weekly Opus'
    case 'seven_day_sonnet':
      return sonnetIsWeekly() ? 'weekly' : 'weekly Sonnet'
    case 'overage':
      return 'extra usage'
    case undefined:
      return undefined
  }
}

/**
 * Whether an `allowed_warning` should reach the user at all.
 *
 * Only above 70% utilization: after a week resets, the API can still send
 * allowed_warning with stale data at low usage. And not for non-billing
 * Team/Enterprise users with extra usage on — they roll into overage
 * seamlessly.
 */
function warningIsShown(limits: ClaudeAILimits): boolean {
  const WARNING_THRESHOLD = 0.7
  if (limits.utilization !== undefined && limits.utilization < WARNING_THRESHOLD) {
    return false
  }
  const subscriptionType = getSubscriptionType()
  const isTeamOrEnterprise =
    subscriptionType === 'team' || subscriptionType === 'enterprise'
  const hasExtraUsageEnabled =
    getOauthAccountInfo()?.hasExtraUsageEnabled === true
  return !(isTeamOrEnterprise && hasExtraUsageEnabled && !hasClaudeAiBillingAccess())
}

/**
 * The window an `allowed_warning` is about, as the warning bar draws it, or
 * null when there is nothing to show (or no utilization to draw).
 */
export function getClaudeWarningWindow(limits: ClaudeAILimits): LimitWindow | null {
  if (limits.isUsingOverage || limits.status !== 'allowed_warning') return null
  const label = claudeWindowLabel(limits.rateLimitType)
  if (!label || limits.utilization === undefined || !warningIsShown(limits)) {
    return null
  }
  return {
    key: limits.rateLimitType ?? 'unified',
    label,
    usedPercent: limits.utilization * 100,
    resetsAtMs: limits.resetsAt ? limits.resetsAt * 1000 : undefined,
  }
}

/**
 * Get the appropriate rate limit message based on limit state
 * Returns null if no message should be shown
 */
export function getRateLimitMessage(
  limits: ClaudeAILimits,
  providerLabel: string,
): RateLimitMessage | null {
  // Check overage scenarios first (when subscription is rejected but overage is available)
  // getUsingOverageText is rendered separately from warning.
  if (limits.isUsingOverage) {
    if (limits.overageStatus === 'allowed_warning') {
      return {
        message: `${providerLabel} · close to your extra usage spending limit`,
        severity: 'warning',
      }
    }
    return null
  }

  if (limits.status === 'rejected') {
    return {
      message: getLimitReachedText(limits, providerLabel),
      severity: 'error',
    }
  }

  if (limits.status === 'allowed_warning' && warningIsShown(limits)) {
    const text = getEarlyWarningText(limits, providerLabel)
    if (text) return { message: text, severity: 'warning' }
  }

  return null
}

/**
 * Get error message for API errors (used in errors.ts)
 * Returns the message string or null if no error message should be shown
 */
export function getRateLimitErrorMessage(
  limits: ClaudeAILimits,
  providerLabel: string,
): string | null {
  const message = getRateLimitMessage(limits, providerLabel)
  return message?.severity === 'error' ? message.message : null
}

/**
 * Get the warning to toast in the REPL
 * Returns the warning message string or null if no warning should be shown
 */
export function getRateLimitWarning(
  limits: ClaudeAILimits,
  providerLabel: string,
): string | null {
  const message = getRateLimitMessage(limits, providerLabel)
  // Errors are shown in AssistantTextMessages, never as a toast.
  return message?.severity === 'warning' ? message.message : null
}

function getLimitReachedText(limits: ClaudeAILimits, providerLabel: string): string {
  // if BOTH subscription (checked before this method) and overage are exhausted
  if (limits.overageStatus === 'rejected') {
    // Show the earliest reset time to indicate when user can resume
    const earliestReset =
      limits.resetsAt && limits.overageResetsAt
        ? Math.min(limits.resetsAt, limits.overageResetsAt)
        : (limits.resetsAt ?? limits.overageResetsAt)
    const suffix = formatResetSuffix(earliestReset ? earliestReset * 1000 : undefined)
    if (limits.overageDisabledReason === 'out_of_credits') {
      return `${providerLabel} · out of extra usage${suffix}`
    }
    return formatLimitReached(providerLabel, 'usage limit', suffix)
  }

  const label = claudeWindowLabel(limits.rateLimitType)
  const limitName =
    label === undefined || limits.rateLimitType === 'overage'
      ? 'usage limit'
      : `${label} limit`
  return formatLimitReached(
    providerLabel,
    limitName,
    formatResetSuffix(limits.resetsAt ? limits.resetsAt * 1000 : undefined),
  )
}

function getEarlyWarningText(
  limits: ClaudeAILimits,
  providerLabel: string,
): string | null {
  const window = getClaudeWarningWindow(limits)
  if (window) return formatUsageWarning(providerLabel, window)

  // No utilization to draw: say which limit is near, and when it resets.
  const label = claudeWindowLabel(limits.rateLimitType)
  if (!label) return null
  const limitName = label === 'extra usage' ? 'extra usage limit' : `${label} limit`
  const suffix = formatResetSuffix(limits.resetsAt ? limits.resetsAt * 1000 : undefined)
  return `${providerLabel} · approaching ${limitName}${suffix}`
}

// The early-warning line used to carry an upsell suffix — `/upgrade to keep
// using Claudin` for Pro/Max, `/extra-usage to request more` for
// Team/Enterprise. Both commands were removed with the consumer-billing
// surfaces, so every branch of that helper named something a user cannot run.
// It went with them rather than being repointed: neither action has a terminal
// equivalent here, and the warning itself is still the useful half.

/**
 * Get notification text for overage mode transitions
 * Used for transient notifications when entering overage mode
 */
export function getUsingOverageText(
  limits: ClaudeAILimits,
  providerLabel: string,
): string {
  const label =
    limits.rateLimitType === 'overage'
      ? undefined
      : claudeWindowLabel(limits.rateLimitType)
  if (!label) return `${providerLabel} · now using extra usage`
  const suffix = formatResetSuffix(limits.resetsAt ? limits.resetsAt * 1000 : undefined)
  return suffix
    ? `${providerLabel} · now using extra usage · your ${label} limit${suffix}`
    : `${providerLabel} · now using extra usage`
}
