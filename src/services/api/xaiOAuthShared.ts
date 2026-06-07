/**
 * Shared constants and helpers for the xAI / Grok OAuth device flow.
 *
 * Ported from opencode's `packages/opencode/src/plugin/xai.ts`. We use the
 * OAuth 2.0 Device Authorization Grant (RFC 8628) — no loopback HTTP server,
 * no callback URL, no PKCE. The user copies a short `user_code` into a web
 * page, and we poll the token endpoint until they approve.
 *
 * Client_id is the same one opencode/Grok-CLI uses; xAI has not published
 * a separate Claudin client registration yet.
 */

export const XAI_OAUTH_TOKEN_URL = 'https://auth.x.ai/oauth2/token'
export const XAI_OAUTH_DEVICE_CODE_URL =
  'https://auth.x.ai/oauth2/device/code'
export const XAI_OAUTH_DEVICE_CODE_GRANT_TYPE =
  'urn:ietf:params:oauth:grant-type:device_code'
export const DEFAULT_XAI_OAUTH_CLIENT_ID =
  'b1a00492-073a-47ea-816f-4c329264a828'
export const XAI_OAUTH_SCOPE =
  'openid profile email offline_access grok-cli:access api:access'

export function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

export function getXaiOAuthClientId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    asTrimmedString(env.XAI_OAUTH_CLIENT_ID) ?? DEFAULT_XAI_OAUTH_CLIENT_ID
  )
}

export function decodeJwtPayload(
  token: string,
): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined

  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const json = Buffer.from(padded, 'base64').toString('utf8')
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
