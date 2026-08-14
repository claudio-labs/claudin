/**
 * Registry + helpers for the OAuth-web providers that ride on the OpenAI-compatible
 * transport (xAI / Grok and Kimi Code).
 *
 * These providers keep `transport: 'openai_compat'` but authenticate with a
 * rotated OAuth Bearer token from secure storage (not a static apiKey), keyed off
 * the profile's base URL rather than a transport enum. Kimi Code additionally
 * requires the official CLI's User-Agent + `X-Msh-*` device headers on every
 * coding request. Each provider is one entry in `OAUTH_WEB_PROVIDERS`; the two
 * consumers — the request builder (`resolveOAuthProviderAuth`) and the 401
 * force-refresh path in `withRetry` (`forceRefreshOAuthWebTokenOn401`) — iterate
 * the registry instead of branching per provider, so adding a third OAuth-web
 * provider is a data entry, not new `if`s in two files.
 *
 * Codex/ChatGPT OAuth is intentionally NOT here: it is keyed by transport
 * (`codex_responses`), carries no UA/device headers, and resolves credentials via
 * a different path (`resolveRuntimeCodexCredentials`).
 */

import { logForDebugging } from 'src/utils/debug.js'
import {
  readKimiCredentialsAsync,
  refreshKimiAccessTokenIfNeeded,
} from 'src/utils/kimiCredentials.js'
import { getKimiDeviceHeaders } from 'src/utils/kimiDeviceHeaders.js'
import { getKimiUserAgent } from 'src/utils/kimiUserAgent.js'
import {
  readXaiCredentialsAsync,
  refreshXaiAccessTokenIfNeeded,
} from 'src/utils/xaiCredentials.js'
import { getXaiUserAgent } from 'src/utils/xaiUserAgent.js'
import type { ResolvedProvider } from 'src/services/api/activeProvider.js'
import { isKimiCodeBaseUrl, isXaiOAuthBaseUrl } from 'src/services/api/providerConfig.js'

export type OAuthProviderAuth = {
  /** Rotated OAuth Bearer token, swapped in only when the profile has no static apiKey. */
  accessToken?: string
  /** User-Agent to apply on the request (xAI OAuth, or any Kimi coding-host request). */
  userAgent?: string
  /** `X-Msh-*` device headers to merge onto the request (Kimi coding host only). */
  deviceHeaders?: Record<string, string>
}

type OAuthWebProvider = {
  /** Short id, used in log tags (`[xai]` / `[kimi]`). */
  id: string
  /** Does the active profile's base URL belong to this provider? */
  matches(baseUrl: string | undefined): boolean
  /** Proactive token refresh; `{ force: true }` bypasses the clock on a 401. */
  refresh(opts?: { force?: boolean }): Promise<{
    credentials?: { accessToken?: string } | null
  }>
  /** Read the stored blob without refreshing (fallback when a refresh throws). */
  readCredentials(): Promise<{ accessToken?: string } | null | undefined>
  userAgent(): string
  deviceHeaders?(): Promise<Record<string, string>>
  /**
   * When true, the UA (+ device headers) attach on EVERY request to this
   * provider's host, even a static-key profile with no OAuth token swap. Kimi
   * Code's backend rejects requests without them; xAI only wants the UA when the
   * request actually carries its OAuth token.
   */
  attachHeadersWithoutToken: boolean
}

const OAUTH_WEB_PROVIDERS: readonly OAuthWebProvider[] = [
  {
    id: 'xai',
    matches: isXaiOAuthBaseUrl,
    refresh: refreshXaiAccessTokenIfNeeded,
    readCredentials: readXaiCredentialsAsync,
    userAgent: getXaiUserAgent,
    attachHeadersWithoutToken: false,
  },
  {
    id: 'kimi',
    matches: isKimiCodeBaseUrl,
    refresh: refreshKimiAccessTokenIfNeeded,
    readCredentials: readKimiCredentialsAsync,
    userAgent: getKimiUserAgent,
    deviceHeaders: getKimiDeviceHeaders,
    attachHeadersWithoutToken: true,
  },
]

function findOAuthWebProvider(
  baseUrl: string | undefined,
): OAuthWebProvider | undefined {
  return OAUTH_WEB_PROVIDERS.find(p => p.matches(baseUrl))
}

/**
 * Inspect the active profile and, when it targets an OAuth-web provider, resolve
 * the token + UA/headers to apply. Returns an empty object for every other
 * provider (a static-key OpenAI-compat profile, Gemini, Copilot, etc.).
 *
 * - Swaps in a rotated Bearer token only when there is no static apiKey. A stale
 *   token would 401, force-refresh via withRetry, and retry.
 * - Attaches UA/device headers when the provider produced a token, or whenever
 *   the provider requires them regardless of key source (Kimi coding host).
 */
export async function resolveOAuthProviderAuth(
  profile: ResolvedProvider | null,
): Promise<OAuthProviderAuth> {
  const provider = findOAuthWebProvider(profile?.baseUrl)
  if (!provider) return {}

  let accessToken: string | undefined
  if (!profile?.apiKey) {
    const result = await provider.refresh().catch(async error => {
      logForDebugging(
        `[${provider.id}] access token refresh failed before request: ${error instanceof Error ? error.message : String(error)}`,
        { level: 'warn' },
      )
      return { credentials: await provider.readCredentials() }
    })
    accessToken = result.credentials?.accessToken ?? undefined
  }

  if (accessToken || provider.attachHeadersWithoutToken) {
    return {
      accessToken,
      userAgent: provider.userAgent(),
      deviceHeaders: provider.deviceHeaders
        ? await provider.deviceHeaders()
        : undefined,
    }
  }
  return {}
}

/**
 * Force-refresh the OAuth token for the active openai_compat provider after a
 * 401 (server-side revocation won't match the JWT clock). Callers gate on
 * `transport === 'openai_compat'`.
 *
 * - `'no-match'` — the base URL isn't an OAuth-web provider (static-key
 *   openai_compat profile); the caller's generic 401 handling applies.
 * - `'refreshed'` — the token was rotated; safe to retry with the new client.
 * - `'failed'` — refresh was attempted and failed (e.g. the refresh token
 *   itself is expired/revoked). Retrying would just resend the same dead
 *   token, so the caller should stop and surface a reauth prompt instead.
 */
export async function forceRefreshOAuthWebTokenOn401(
  baseUrl: string | undefined,
): Promise<'no-match' | 'refreshed' | 'failed'> {
  const provider = findOAuthWebProvider(baseUrl)
  if (!provider) return 'no-match'
  const refreshed = await provider.refresh({ force: true }).then(
    () => true,
    error => {
      logForDebugging(
        `[${provider.id}] force-refresh on 401 failed: ${error instanceof Error ? error.message : String(error)}`,
        { level: 'warn' },
      )
      return false
    },
  )
  return refreshed ? 'refreshed' : 'failed'
}
