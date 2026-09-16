/**
 * Centralized rate limit message generation
 * Single source of truth for all rate limit-related messages
 */

import {
  getOauthAccountInfo,
  getSubscriptionType,
} from 'src/providers/auth/auth.js'
import { hasClaudeAiBillingAccess } from 'src/providers/usage/billing.js'
import {
  formatCountdownDuration,
  formatResetTime,
} from 'src/shared/text/format.js'
import type { ClaudeAILimits } from 'src/providers/claudeAiLimits.js'
import type { RateLimitInfo } from 'src/providers/rateLimitInfo.js'

/**
 * Head of the provider-agnostic limit message. Exported so the renderer can
 * tell whether the limit currently in force is the one a given transcript
 * message is about.
 */
export const PROVIDER_LIMIT_PREFIX = 'Rate limit reached'
export const QUOTA_EXHAUSTED_PREFIX = 'Quota exhausted'

/**
 * All possible rate limit error message prefixes
 * Export this to avoid fragile string matching in UI components
 */
export const RATE_LIMIT_ERROR_PREFIXES = [
  "You've hit your",
  "You've used",
  "You're now using extra usage",
  "You're close to",
  "You're out of extra usage",
  PROVIDER_LIMIT_PREFIX,
  QUOTA_EXHAUSTED_PREFIX,
] as const

/**
 * Check if a message is a rate limit error
 */
export function isRateLimitErrorMessage(text: string): boolean {
  return RATE_LIMIT_ERROR_PREFIXES.some(prefix => text.startsWith(prefix))
}

/**
 * `Rate limit reached · OpenAI` — everything before the part that changes as
 * the clock runs down.
 */
export function formatProviderLimitHead(
  info: RateLimitInfo,
  providerLabel: string,
): string {
  const prefix =
    info.kind === 'exhausted' ? QUOTA_EXHAUSTED_PREFIX : PROVIDER_LIMIT_PREFIX
  return `${prefix} · ${providerLabel}`
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
 * `Rate limit reached · OpenAI · resets in 2h 14m`.
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

/**
 * Get the appropriate rate limit message based on limit state
 * Returns null if no message should be shown
 */
export function getRateLimitMessage(
  limits: ClaudeAILimits,
  model: string,
): RateLimitMessage | null {
  // Check overage scenarios first (when subscription is rejected but overage is available)
  // getUsingOverageText is rendered separately from warning.
  if (limits.isUsingOverage) {
    // Show warning if approaching overage spending limit
    if (limits.overageStatus === 'allowed_warning') {
      return {
        message: "You're close to your extra usage spending limit",
        severity: 'warning',
      }
    }
    return null
  }

  // ERROR STATES - when limits are rejected
  if (limits.status === 'rejected') {
    return { message: getLimitReachedText(limits, model), severity: 'error' }
  }

  // WARNING STATES - when approaching limits with early warning
  if (limits.status === 'allowed_warning') {
    // Only show warnings when utilization is above threshold (70%)
    // This prevents false warnings after week reset when API may send
    // allowed_warning with stale data at low usage levels
    const WARNING_THRESHOLD = 0.7
    if (
      limits.utilization !== undefined &&
      limits.utilization < WARNING_THRESHOLD
    ) {
      return null
    }

    // Don't warn non-billing Team/Enterprise users about approaching plan limits
    // if overages are enabled - they'll seamlessly roll into overage
    const subscriptionType = getSubscriptionType()
    const isTeamOrEnterprise =
      subscriptionType === 'team' || subscriptionType === 'enterprise'
    const hasExtraUsageEnabled =
      getOauthAccountInfo()?.hasExtraUsageEnabled === true

    if (
      isTeamOrEnterprise &&
      hasExtraUsageEnabled &&
      !hasClaudeAiBillingAccess()
    ) {
      return null
    }

    const text = getEarlyWarningText(limits)
    if (text) {
      return { message: text, severity: 'warning' }
    }
  }

  // No message needed
  return null
}

/**
 * Get error message for API errors (used in errors.ts)
 * Returns the message string or null if no error message should be shown
 */
export function getRateLimitErrorMessage(
  limits: ClaudeAILimits,
  model: string,
): string | null {
  const message = getRateLimitMessage(limits, model)

  // Only return error messages, not warnings
  if (message && message.severity === 'error') {
    return message.message
  }

  return null
}

/**
 * Get warning message for UI footer
 * Returns the warning message string or null if no warning should be shown
 */
export function getRateLimitWarning(
  limits: ClaudeAILimits,
  model: string,
): string | null {
  const message = getRateLimitMessage(limits, model)

  // Only return warnings for the footer - errors are shown in AssistantTextMessages
  if (message && message.severity === 'warning') {
    return message.message
  }

  // Don't show errors in the footer
  return null
}

function getLimitReachedText(limits: ClaudeAILimits, model: string): string {
  const resetsAt = limits.resetsAt
  const resetMessage = formatResetSuffix(resetsAt)

  // if BOTH subscription (checked before this method) and overage are exhausted
  if (limits.overageStatus === 'rejected') {
    // Show the earliest reset time to indicate when user can resume
    const earliestReset =
      resetsAt && limits.overageResetsAt
        ? Math.min(resetsAt, limits.overageResetsAt)
        : (resetsAt ?? limits.overageResetsAt)
    const overageResetMessage = formatResetSuffix(earliestReset)

    if (limits.overageDisabledReason === 'out_of_credits') {
      return `You're out of extra usage${overageResetMessage}`
    }

    return formatLimitReachedText('limit', overageResetMessage, model)
  }

  if (limits.rateLimitType === 'seven_day_sonnet') {
    const subscriptionType = getSubscriptionType()
    const isProOrEnterprise =
      subscriptionType === 'pro' || subscriptionType === 'enterprise'
    // For pro and enterprise, Sonnet limit is the same as weekly
    const limit = isProOrEnterprise ? 'weekly limit' : 'Sonnet limit'
    return formatLimitReachedText(limit, resetMessage, model)
  }

  if (limits.rateLimitType === 'seven_day_opus') {
    return formatLimitReachedText('Opus limit', resetMessage, model)
  }

  if (limits.rateLimitType === 'seven_day') {
    return formatLimitReachedText('weekly limit', resetMessage, model)
  }

  if (limits.rateLimitType === 'five_hour') {
    return formatLimitReachedText('session limit', resetMessage, model)
  }

  return formatLimitReachedText('usage limit', resetMessage, model)
}

function getEarlyWarningText(limits: ClaudeAILimits): string | null {
  let limitName: string | null = null
  switch (limits.rateLimitType) {
    case 'seven_day':
      limitName = 'weekly limit'
      break
    case 'five_hour':
      limitName = 'session limit'
      break
    case 'seven_day_opus':
      limitName = 'Opus limit'
      break
    case 'seven_day_sonnet':
      limitName = 'Sonnet limit'
      break
    case 'overage':
      limitName = 'extra usage'
      break
    case undefined:
      return null
  }

  // utilization and resetsAt should be defined since early warning is calculated with them
  const used = limits.utilization
    ? Math.floor(limits.utilization * 100)
    : undefined
  const resetTime = limits.resetsAt
    ? formatResetTime(limits.resetsAt, true)
    : undefined

  if (used && resetTime) {
    return `You've used ${used}% of your ${limitName} · resets ${resetTime}`
  }

  if (used) {
    return `You've used ${used}% of your ${limitName}`
  }

  if (limits.rateLimitType === 'overage') {
    // For the "Approaching <x>" verbiage, "extra usage limit" makes more sense than "extra usage"
    limitName += ' limit'
  }

  if (resetTime) {
    return `Approaching ${limitName} · resets ${resetTime}`
  }

  return `Approaching ${limitName}`
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
export function getUsingOverageText(limits: ClaudeAILimits): string {
  const resetTime = limits.resetsAt
    ? formatResetTime(limits.resetsAt, true)
    : ''

  let limitName = ''
  if (limits.rateLimitType === 'five_hour') {
    limitName = 'session limit'
  } else if (limits.rateLimitType === 'seven_day') {
    limitName = 'weekly limit'
  } else if (limits.rateLimitType === 'seven_day_opus') {
    limitName = 'Opus limit'
  } else if (limits.rateLimitType === 'seven_day_sonnet') {
    const subscriptionType = getSubscriptionType()
    const isProOrEnterprise =
      subscriptionType === 'pro' || subscriptionType === 'enterprise'
    // For pro and enterprise, Sonnet limit is the same as weekly
    limitName = isProOrEnterprise ? 'weekly limit' : 'Sonnet limit'
  }

  if (!limitName) {
    return 'Now using extra usage'
  }

  const resetMessage = resetTime
    ? ` · Your ${limitName} resets ${resetTime}`
    : ''
  return `You're now using extra usage${resetMessage}`
}

function formatLimitReachedText(
  limit: string,
  resetMessage: string,
  _model: string,
): string {
  return `You've hit your ${limit}${resetMessage}`
}

/**
 * ` · resets 3pm (in 2h 14m)` for a reset in the future, ` · resets 3pm` once
 * it has passed, and nothing at all when the API sent no timestamp. The
 * remaining time is what makes a wall-clock reset actionable — "3pm" alone
 * says nothing about how long that is from now.
 */
function formatResetSuffix(resetsAtSeconds: number | undefined): string {
  if (!resetsAtSeconds) return ''
  const resetTime = formatResetTime(resetsAtSeconds, true)
  if (!resetTime) return ''
  const remainingMs = resetsAtSeconds * 1000 - Date.now()
  if (remainingMs <= 0) return ` · resets ${resetTime}`
  return ` · resets ${resetTime} (in ${formatCountdownDuration(remainingMs)})`
}
