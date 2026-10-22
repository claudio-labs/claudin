/**
 * Which providers report a usage limit, and how to read it.
 *
 * One table answers "does this provider have a limit?" for both places that
 * ask: the /usage tab of each registered profile (`fetch`) and the in-REPL
 * warning (`live`). Adding a provider is a row here plus its reader. Every
 * reader takes the profile it is asked about, never the active one, so
 * /usage can show Claude's limits while Codex is active and vice versa.
 */
import {
  getClaudeAIOAuthTokens,
  getSubscriptionType,
} from 'src/providers/auth/auth.js'
import { currentLimits, statusListeners } from 'src/providers/claudeAiLimits.js'
import {
  codexLimitWindows,
  getCodexAnnouncement,
  getCodexLimits,
  subscribeCodexLimits,
} from 'src/providers/codexLimits.js'
import type { APIProvider } from 'src/providers/model/providers.js'
import type { ResolvedProvider } from 'src/providers/presets/activeProvider.js'
import {
  DEFAULT_CODEX_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
} from 'src/providers/presets/providerConfig.js'
import {
  getClaudeReachedWindow,
  getClaudeWarningWindow,
  getRateLimitWarning,
  getUsingOverageText,
} from 'src/providers/rateLimitMessages.js'
import { hasClaudeAiBillingAccess } from 'src/providers/usage/billing.js'
import {
  buildCodexUsageRows,
  fetchCodexUsage,
  formatCodexPlanType,
} from 'src/providers/usage/codexUsage.js'
import {
  buildMiniMaxUsageRows,
  fetchMiniMaxUsage,
} from 'src/providers/usage/minimaxUsage.js'
import { fetchUtilization, type Utilization } from 'src/providers/usage/usage.js'
import {
  CODEX_WARNING_THRESHOLDS,
  formatUsageIndicator,
  formatUsageWarning,
  standingWindow,
} from 'src/providers/usageWarnings.js'

/** One line of a provider's limits, the same shape for every provider. */
export type UsageLimitRow =
  | {
      kind: 'window'
      label: string
      usedPercent: number
      /** ISO 8601. */
      resetsAt?: string
      extraSubtext?: string
    }
  | {
      kind: 'text'
      label: string
      value: string
    }

export type ProviderLimits = {
  plan?: string
  rows: UsageLimitRow[]
  /** What to say instead of rows, when the provider explained their absence. */
  message?: string
}

export const SUBSCRIPTION_LIMITS_UNAVAILABLE =
  'Limits are only available for Claude subscription logins.'

export const SUBSCRIPTION_LOGIN_EXPIRED =
  'The claude.ai login has expired and could not be refreshed. Run /login.'

/** A provider's limits for this profile — active or not. */
export type LimitsFetcher = (profile: ResolvedProvider) => Promise<ProviderLimits>

/** What the active provider's last responses said about its limits, formatted. */
export type LiveLimitsReading = {
  /** The warning to toast; `id` changes once per warning that is due. */
  announcement?: { id: string; text: string }
  /** The footer's standing reminder, while a window stays high. */
  standing?: string
  /** The notice that overage has started (Claude only). */
  overage?: string
}

/** Limits read off the responses themselves, as they arrive. */
export type LiveLimitsSource = {
  subscribe: (listener: () => void) => () => void
  read: (providerLabel: string, nowMs: number) => LiveLimitsReading
}

type LimitsCapability = {
  fetch: LimitsFetcher
  live?: LiveLimitsSource
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value
}

async function fetchClaudeLimits(): Promise<ProviderLimits> {
  const util = await fetchUtilization()
  if (util === null) return { rows: [], message: SUBSCRIPTION_LOGIN_EXPIRED }
  // The stored login's plan: getSubscriptionType() answers null whenever the
  // active provider is not Anthropic.
  const subscriptionType = getClaudeAIOAuthTokens()?.subscriptionType ?? null
  const rows = buildClaudeLimitRows(util, subscriptionType)
  return {
    plan: subscriptionType ? capitalize(subscriptionType) : undefined,
    rows,
    message: rows.length === 0 ? SUBSCRIPTION_LIMITS_UNAVAILABLE : undefined,
  }
}

const TRAILING_SLASH_RE = /\/+$/

/**
 * Where a Codex profile's requests go. A `codexplan` profile left on the
 * OpenAI preset's URL, or on none, talks to the Codex backend
 * (resolveProviderRequest swaps it in), so that is where its limits are.
 */
function codexBackendUrl(baseUrl: string): string {
  const url = baseUrl.trim().replace(TRAILING_SLASH_RE, '')
  return !url || url === DEFAULT_OPENAI_BASE_URL ? DEFAULT_CODEX_BASE_URL : url
}

async function fetchCodexLimits(profile: ResolvedProvider): Promise<ProviderLimits> {
  const usage = await fetchCodexUsage({
    baseUrl: codexBackendUrl(profile.baseUrl),
    profile,
  })
  return {
    plan: formatCodexPlanType(usage.planType),
    rows: buildCodexUsageRows(usage.snapshots),
    message: 'Codex usage data is not available for this account.',
  }
}

async function fetchMiniMaxLimits(profile: ResolvedProvider): Promise<ProviderLimits> {
  const usage = await fetchMiniMaxUsage({
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
  })
  if (usage.availability !== 'available') {
    return { plan: usage.planType, rows: [], message: usage.message }
  }
  return {
    plan: usage.planType,
    rows: buildMiniMaxUsageRows(usage.snapshots),
    message: 'No MiniMax usage windows were returned for this account.',
  }
}

/** The floor a Claude window has to stay above for the footer to keep it. */
const SUBSCRIPTION_STANDING_FLOOR_PERCENT = 70

/**
 * The subscription's unified-limit headers (claudeAiLimits.ts). The server
 * decides when to warn (`surpassed-threshold`), so one toast per window and
 * threshold; rateLimitMessages.ts applies the user-facing gates.
 */
const claudeLive: LiveLimitsSource = {
  subscribe: listener => {
    const onChange = (): void => listener()
    statusListeners.add(onChange)
    return () => {
      statusListeners.delete(onChange)
    }
  },
  read: (providerLabel, nowMs) => {
    const limits = currentLimits
    const text = getRateLimitWarning(limits, providerLabel)
    const window = getClaudeWarningWindow(limits) ?? getClaudeReachedWindow(limits)
    const standing = window
      ? standingWindow([window], SUBSCRIPTION_STANDING_FLOOR_PERCENT, nowMs)
      : undefined
    const subscriptionType = getSubscriptionType()
    const overageNoticed =
      (subscriptionType !== 'team' && subscriptionType !== 'enterprise') ||
      hasClaudeAiBillingAccess()
    return {
      announcement: text
        ? {
            id: [limits.rateLimitType, limits.resetsAt, limits.surpassedThreshold, limits.overageStatus].join(':'),
            text,
          }
        : undefined,
      standing: standing ? formatUsageIndicator(providerLabel, standing) : undefined,
      overage:
        limits.isUsingOverage && overageNoticed
          ? getUsingOverageText(limits, providerLabel)
          : undefined,
    }
  },
}

/**
 * The plan windows each Codex response reports (codexLimits.ts), warned at
 * the Codex CLI's thresholds.
 */
const codexLive: LiveLimitsSource = {
  subscribe: subscribeCodexLimits,
  read: (providerLabel, nowMs) => {
    const data = getCodexLimits()
    if (!data) return {}
    const announced = getCodexAnnouncement()
    const standing = standingWindow(codexLimitWindows(data), CODEX_WARNING_THRESHOLDS[0]!, nowMs)
    return {
      announcement: announced
        ? { id: String(announced.id), text: formatUsageWarning(providerLabel, announced.window, nowMs) }
        : undefined,
      standing: standing ? formatUsageIndicator(providerLabel, standing) : undefined,
    }
  },
}

const PROVIDER_LIMITS: Partial<Record<APIProvider, LimitsCapability>> = {
  firstParty: { fetch: fetchClaudeLimits, live: claudeLive },
  codex: { fetch: fetchCodexLimits, live: codexLive },
  minimax: { fetch: fetchMiniMaxLimits },
}

/** How to read this kind of provider's limits, or undefined when it reports none. */
export function getLimitsFetcher(kind: APIProvider): LimitsFetcher | undefined {
  return PROVIDER_LIMITS[kind]?.fetch
}

/** The limits this kind of provider reports on its own responses, if any. */
export function getLiveLimits(kind: APIProvider): LiveLimitsSource | undefined {
  return PROVIDER_LIMITS[kind]?.live
}

/** Claude's /api/oauth/usage answer as rows; `null` subscription = unknown plan. */
export function buildClaudeLimitRows(
  util: Utilization,
  subscriptionType: string | null,
): UsageLimitRow[] {
  const showSonnet =
    subscriptionType === 'max' ||
    subscriptionType === 'team' ||
    subscriptionType === null
  const windows: Array<[string, Utilization['five_hour']]> = [
    ['Current session', util.five_hour],
    ['Current week (all models)', util.seven_day],
    ...(showSonnet
      ? [['Current week (Sonnet only)', util.seven_day_sonnet] as [string, Utilization['five_hour']]]
      : []),
  ]
  const rows: UsageLimitRow[] = []
  for (const [label, limit] of windows) {
    if (!limit || limit.utilization === null) continue
    rows.push({
      kind: 'window',
      label,
      usedPercent: limit.utilization,
      resetsAt: limit.resets_at ?? undefined,
    })
  }
  const eu = util.extra_usage
  if (
    eu?.is_enabled &&
    typeof eu.used_credits === 'number' &&
    typeof eu.utilization === 'number' &&
    eu.monthly_limit != null
  ) {
    rows.push({
      kind: 'window',
      label: 'Extra usage',
      usedPercent: eu.utilization,
      extraSubtext: `$${(eu.used_credits / 100).toFixed(2)} / $${(eu.monthly_limit / 100).toFixed(2)} spent`,
    })
  }
  return rows
}
