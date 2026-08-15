/**
 * GitHub OAuth device flow for CLI login (https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).
 * Uses GitHub Copilot's official OAuth app for device authentication.
 */

import { openBrowser } from 'src/shared/browser.js'

export const DEFAULT_GITHUB_DEVICE_FLOW_CLIENT_ID = 'Iv1.b507a08c87ecfe98'

export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
export const GITHUB_DEVICE_ACCESS_TOKEN_URL =
  'https://github.com/login/oauth/access_token'
export const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'

/**
 * Normalize a GitHub Enterprise domain as typed by the user:
 * "https://github.acme.com/" → "github.acme.com". Returns undefined for
 * empty input or plain github.com (treated as the default deployment).
 */
export function normalizeGithubEnterpriseDomain(
  domain: string | undefined,
): string | undefined {
  if (!domain) return undefined
  const trimmed = domain
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
  if (!trimmed || trimmed.toLowerCase() === 'github.com') return undefined
  return trimmed
}

function deviceCodeUrlFor(domain: string | undefined): string {
  return domain ? `https://${domain}/login/device/code` : GITHUB_DEVICE_CODE_URL
}

function accessTokenUrlFor(domain: string | undefined): string {
  return domain
    ? `https://${domain}/login/oauth/access_token`
    : GITHUB_DEVICE_ACCESS_TOKEN_URL
}

function copilotTokenUrlFor(domain: string | undefined): string {
  return domain
    ? `https://api.${domain}/copilot_internal/v2/token`
    : COPILOT_TOKEN_URL
}

/** Only read:user scope — required for Copilot OAuth */
export const DEFAULT_GITHUB_DEVICE_SCOPE = 'read:user'

export const COPILOT_HEADERS: Record<string, string> = {
  'User-Agent': 'GitHubCopilotChat/0.26.7',
  'Editor-Version': 'vscode/1.99.3',
  'Editor-Plugin-Version': 'copilot-chat/0.26.7',
  'Copilot-Integration-Id': 'vscode-chat',
}

export type CopilotTokenResponse = {
  token: string
  expires_at: number
  refresh_in: number
  endpoints: {
    api: string
  }
}

export class GitHubDeviceFlowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitHubDeviceFlowError'
  }
}

export type DeviceCodeResult = {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function getGithubDeviceFlowClientId(): string {
  return (
    process.env.GITHUB_DEVICE_FLOW_CLIENT_ID?.trim() ||
    DEFAULT_GITHUB_DEVICE_FLOW_CLIENT_ID
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function requestDeviceCode(options?: {
  clientId?: string
  scope?: string
  /** GitHub Enterprise domain (e.g. "github.acme.com"); github.com when unset. */
  domain?: string
  fetchImpl?: FetchLike
}): Promise<DeviceCodeResult> {
  const clientId = options?.clientId ?? getGithubDeviceFlowClientId()
  if (!clientId) {
    throw new GitHubDeviceFlowError(
      'No OAuth client ID: set GITHUB_DEVICE_FLOW_CLIENT_ID.',
    )
  }
  const fetchFn = options?.fetchImpl ?? fetch
  const requestedScope =
    options?.scope?.trim() || DEFAULT_GITHUB_DEVICE_SCOPE
  const scopesToTry =
    requestedScope === DEFAULT_GITHUB_DEVICE_SCOPE
      ? [requestedScope]
      : [requestedScope, DEFAULT_GITHUB_DEVICE_SCOPE]

  let lastError = 'Device code request failed.'
  const deviceCodeUrl = deviceCodeUrlFor(
    normalizeGithubEnterpriseDomain(options?.domain),
  )

  for (const scope of scopesToTry) {
    const res = await fetchFn(deviceCodeUrl, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: clientId,
        scope,
      }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      lastError = `Device code request failed: ${res.status} ${text}`
      const isInvalidScope = /invalid_scope/i.test(text)
      const canRetryWithFallback =
        scope !== DEFAULT_GITHUB_DEVICE_SCOPE && isInvalidScope
      if (canRetryWithFallback) {
        continue
      }
      throw new GitHubDeviceFlowError(lastError)
    }

    const data = (await res.json()) as Record<string, unknown>
    const device_code = data.device_code
    const user_code = data.user_code
    const verification_uri = data.verification_uri
    if (
      typeof device_code !== 'string' ||
      typeof user_code !== 'string' ||
      typeof verification_uri !== 'string'
    ) {
      throw new GitHubDeviceFlowError(
        'Malformed device code response from GitHub',
      )
    }

    return {
      device_code,
      user_code,
      verification_uri,
      expires_in: typeof data.expires_in === 'number' ? data.expires_in : 900,
      interval: typeof data.interval === 'number' ? data.interval : 5,
    }
  }

  throw new GitHubDeviceFlowError(lastError)
}

export type PollOptions = {
  clientId?: string
  initialInterval?: number
  timeoutSeconds?: number
  /** GitHub Enterprise domain (e.g. "github.acme.com"); github.com when unset. */
  domain?: string
  fetchImpl?: FetchLike
}

export async function pollAccessToken(
  deviceCode: string,
  options?: PollOptions,
): Promise<string> {
  const clientId = options?.clientId ?? getGithubDeviceFlowClientId()
  if (!clientId) {
    throw new GitHubDeviceFlowError('client_id required for polling')
  }
  let interval = Math.max(1, options?.initialInterval ?? 5)
  const timeoutSeconds = options?.timeoutSeconds ?? 900
  const fetchFn = options?.fetchImpl ?? fetch
  const accessTokenUrl = accessTokenUrlFor(
    normalizeGithubEnterpriseDomain(options?.domain),
  )
  const start = Date.now()

  while ((Date.now() - start) / 1000 < timeoutSeconds) {
    const res = await fetchFn(accessTokenUrl, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new GitHubDeviceFlowError(
        `Token request failed: ${res.status} ${text}`,
      )
    }
    const data = (await res.json()) as Record<string, unknown>
    const err = data.error as string | undefined
    if (err == null) {
      const token = data.access_token
      if (typeof token === 'string' && token) {
        return token
      }
      throw new GitHubDeviceFlowError('No access_token in response')
    }
    if (err === 'authorization_pending') {
      await sleep(interval * 1000)
      continue
    }
    if (err === 'slow_down') {
      interval =
        typeof data.interval === 'number' ? data.interval : interval + 5
      await sleep(interval * 1000)
      continue
    }
    if (err === 'expired_token') {
      throw new GitHubDeviceFlowError(
        'Device code expired. Start the login flow again.',
      )
    }
    if (err === 'access_denied') {
      throw new GitHubDeviceFlowError('Authorization was denied or cancelled.')
    }
    throw new GitHubDeviceFlowError(`GitHub OAuth error: ${err}`)
  }
  throw new GitHubDeviceFlowError('Timed out waiting for authorization.')
}

/**
 * Best-effort open browser / OS handler for the verification URL.
 * Delegates to the central openBrowser helper so $BROWSER, settings.oauthBrowser,
 * and Linux default-browser detection are honored uniformly across OAuth flows.
 */
export async function openVerificationUri(uri: string): Promise<void> {
  await openBrowser(uri)
}

/**
 * Exchange an OAuth access token for a Copilot API token.
 * The OAuth token alone cannot be used with the Copilot API endpoint.
 *
 * The response's `endpoints.api` is the Copilot inference base URL for the
 * account — on GitHub Enterprise deployments it differs from
 * api.githubcopilot.com, so callers should persist it as the profile baseUrl.
 *
 * Second argument accepts either a bare fetch (legacy call sites/tests) or
 * an options object with the GHE `domain`.
 */
export async function exchangeForCopilotToken(
  oauthToken: string,
  fetchImplOrOptions?: FetchLike | { domain?: string; fetchImpl?: FetchLike },
): Promise<CopilotTokenResponse> {
  const options =
    typeof fetchImplOrOptions === 'function'
      ? { fetchImpl: fetchImplOrOptions }
      : (fetchImplOrOptions ?? {})
  const fetchFn = options.fetchImpl ?? fetch
  const tokenUrl = copilotTokenUrlFor(
    normalizeGithubEnterpriseDomain(options.domain),
  )
  const res = await fetchFn(tokenUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${oauthToken}`,
      ...COPILOT_HEADERS,
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new GitHubDeviceFlowError(
      `Copilot token exchange failed: ${res.status} ${text}`,
    )
  }
  const data = (await res.json()) as Record<string, unknown>
  const token = data.token
  const expires_at = data.expires_at
  const refresh_in = data.refresh_in
  const endpoints = data.endpoints
  if (
    typeof token !== 'string' ||
    typeof expires_at !== 'number' ||
    typeof refresh_in !== 'number' ||
    !endpoints ||
    typeof endpoints !== 'object' ||
    typeof (endpoints as Record<string, unknown>).api !== 'string'
  ) {
    throw new GitHubDeviceFlowError('Malformed Copilot token response')
  }
  return {
    token,
    expires_at,
    refresh_in,
    endpoints: endpoints as { api: string },
  }
}
