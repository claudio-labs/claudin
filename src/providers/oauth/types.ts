// Reconstructed from its use sites — the original module was not carried into
// this fork. `OAuthTokens` mirrors the object `OAuthService.formatTokens` and
// `client.ts::refreshTokens` build; the `*Response` shapes mirror the fields
// their consumers read off the axios payload.

/** Anthropic subscription behind the OAuth account. */
export type SubscriptionType = 'pro' | 'max' | 'team' | 'enterprise'

/**
 * Rate-limit bucket the organization sits in. Open-ended: it is a server-side
 * label that consumers only ever compare against known values.
 */
export type RateLimitTier =
  | 'default_claude_max_5x'
  | 'default_claude_max_20x'
  | (string & {})

/** How the subscription is billed. Read from `organization.billing_type`. */
export type BillingType =
  | 'stripe_subscription'
  | 'stripe_subscription_contracted'
  | 'apple_subscription'
  | 'google_play_subscription'
  | (string & {})

/** Raw `/api/oauth/profile` (and `/api/claude_cli_profile`) payload. */
export type OAuthProfileResponse = {
  account?: {
    uuid: string
    email?: string
    email_address?: string
    display_name?: string
    created_at?: string
    has_claude_pro?: boolean
    has_claude_max?: boolean
  }
  organization?: {
    uuid: string
    name?: string
    organization_type?:
      | 'claude_pro'
      | 'claude_max'
      | 'claude_team'
      | 'claude_enterprise'
      | (string & {})
    billing_type?: BillingType | null
    rate_limit_tier?: RateLimitTier | null
    has_extra_usage_enabled?: boolean | null
    subscription_created_at?: string
  }
}

/** Raw token-endpoint payload, before it is normalized into `OAuthTokens`. */
export type OAuthTokenExchangeResponse = {
  access_token: string
  refresh_token: string
  /** Seconds until expiry, relative to the response. */
  expires_in: number
  /** Space-separated; `client.parseScopes` splits it. */
  scope: string
  account?: {
    uuid: string
    email_address: string
  }
  organization?: {
    uuid: string
  }
}

/** Normalized OAuth credentials as they are persisted and consumed. */
export type OAuthTokens = {
  accessToken: string
  /** `null` for inference-only tokens sourced from an env var / fd — refresh is unknown. */
  refreshToken: string | null
  /** Epoch milliseconds. */
  expiresAt: number | null
  scopes: string[]
  subscriptionType: SubscriptionType | null
  rateLimitTier: RateLimitTier | null
  /** Cached profile, so a refresh can skip the extra round-trip. */
  profile?: OAuthProfileResponse
  tokenAccount?: {
    uuid: string
    emailAddress: string
    organizationUuid?: string
  }
}

/** Payload of the roles endpoint, folded into `config.oauthAccount`. */
export type UserRolesResponse = {
  organization_role: string
  workspace_role: string | null
  organization_name: string
}

/** Referral programme a guest pass belongs to. */
export type ReferralCampaign = 'claude_code_guest_pass' | (string & {})

/** Credit a referrer earns, in minor units of `currency`. */
export type ReferrerRewardInfo = {
  amount_minor_units: number
  /** ISO 4217 code; `formatCreditAmount` maps it to a symbol. */
  currency: string
}

export type ReferralEligibilityResponse = {
  eligible: boolean
  referrer_reward?: ReferrerRewardInfo | null
  remaining_passes?: number | null
  referral_code_details?: {
    campaign?: ReferralCampaign
    referral_link?: string
  } | null
}

export type ReferralRedemptionsResponse = {
  redemptions?: Array<{ redeemed_at?: string }> | null
  /** How many passes the campaign grants; defaults to 3 when absent. */
  limit?: number | null
}
