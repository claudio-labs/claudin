import axios from 'axios'
import { getOauthConfig, OAUTH_BETA_HEADER } from 'src/shared/constants/oauth.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
  hasProfileScope,
} from 'src/providers/auth/auth.js'
import { getClaudeCodeUserAgent } from 'src/providers/transport/userAgent.js'
import {
  isOAuthTokenExpired,
  shouldUseClaudeAIAuth,
} from 'src/providers/oauth/client.js'

type RateLimit = {
  utilization: number | null // a percentage from 0 to 100
  resets_at: string | null // ISO 8601 timestamp
}

export type ExtraUsage = {
  is_enabled: boolean
  monthly_limit: number | null
  used_credits: number | null
  utilization: number | null
}

export type Utilization = {
  five_hour?: RateLimit | null
  seven_day?: RateLimit | null
  seven_day_oauth_apps?: RateLimit | null
  seven_day_opus?: RateLimit | null
  seven_day_sonnet?: RateLimit | null
  extra_usage?: ExtraUsage | null
}

/**
 * The claude.ai login's usage windows, whichever provider is active: /usage
 * shows an Anthropic profile's limits while Codex answers, too. So this reads
 * the stored login itself rather than asking isClaudeAISubscriber(), which is
 * false whenever the active transport is not Anthropic's. `{}` with no
 * claude.ai login that can read the profile endpoints; `null` when the token
 * is expired and could not be refreshed — a login not in use is not kept
 * fresh by the request path.
 */
export async function fetchUtilization(): Promise<Utilization | null> {
  let tokens = getClaudeAIOAuthTokens()
  if (!tokens || !shouldUseClaudeAIAuth(tokens.scopes) || !hasProfileScope()) {
    return {}
  }

  if (isOAuthTokenExpired(tokens.expiresAt)) {
    await checkAndRefreshOAuthTokenIfNeeded()
    tokens = getClaudeAIOAuthTokens()
    // Skip the call with an expired token rather than earn a 401.
    if (!tokens || isOAuthTokenExpired(tokens.expiresAt)) return null
  }

  if (!tokens.accessToken) {
    throw new Error('Auth error: No OAuth token available')
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': getClaudeCodeUserAgent(),
    Authorization: `Bearer ${tokens.accessToken}`,
    'anthropic-beta': OAUTH_BETA_HEADER,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/usage`

  const response = await axios.get<Utilization>(url, {
    headers,
    timeout: 5000, // 5 second timeout
  })

  return response.data
}
