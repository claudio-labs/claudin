import type { OAuthTokens } from 'src/providers/oauth/types.js'
import type { APIProvider } from 'src/providers/model/providers.js'

const MCP_SERVERS_SCOPE = 'user:mcp_servers'

export type ListingFacts = {
  provider: APIProvider
  essentialTrafficOnly: boolean
  /** `ENABLE_CLAUDEAI_MCP_SERVERS` set to a false value. */
  switchedOff: boolean
  /** Read last, and only when every other gate passed: it may touch the keychain. */
  readTokens: () => OAuthTokens | null
}

export type ListingEligibility =
  | { eligible: true; accessToken: string }
  | { eligible: false; reason: 'not-first-party' | 'essential-traffic' | 'switched-off' | 'no-login' | 'missing-scope' }

/** Whether the org's claude.ai connectors may be listed, and why not when they may not. */
export function listingEligibility(facts: ListingFacts): ListingEligibility {
  if (facts.provider !== 'firstParty') return { eligible: false, reason: 'not-first-party' }
  if (facts.essentialTrafficOnly) return { eligible: false, reason: 'essential-traffic' }
  if (facts.switchedOff) return { eligible: false, reason: 'switched-off' }
  const tokens = facts.readTokens()
  if (!tokens?.accessToken) return { eligible: false, reason: 'no-login' }
  if (!tokens.scopes?.includes(MCP_SERVERS_SCOPE)) return { eligible: false, reason: 'missing-scope' }
  return { eligible: true, accessToken: tokens.accessToken }
}
