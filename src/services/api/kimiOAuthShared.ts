/**
 * Shared constants and helpers for the Kimi Code OAuth device flow.
 *
 * Kimi Code (Moonshot AI) authenticates its CLI via the OAuth 2.0 Device
 * Authorization Grant (RFC 8628) — no loopback HTTP server, no callback URL,
 * no PKCE. The user copies a short `user_code` into a web page and we poll the
 * token endpoint until they approve. The resulting Bearer token drives the
 * OpenAI-compatible coding API at `https://api.kimi.com/coding/v1`.
 *
 * Endpoints/client_id captured empirically from the official CLI
 * (`@moonshot-ai/kimi-code`) — see `docs/tech/kimi-code/wire-format.md`.
 */

export const KIMI_OAUTH_DEVICE_CODE_URL =
  'https://auth.kimi.com/api/oauth/device_authorization'
export const KIMI_OAUTH_TOKEN_URL = 'https://auth.kimi.com/api/oauth/token'
export const KIMI_OAUTH_DEVICE_CODE_GRANT_TYPE =
  'urn:ietf:params:oauth:grant-type:device_code'
/** Public client id hardcoded in the official Kimi Code CLI. */
export const DEFAULT_KIMI_OAUTH_CLIENT_ID =
  '17e5f671-d194-4dfb-9706-5516cb48c098'

/**
 * The version string the official CLI advertises via `User-Agent` and
 * `X-Msh-Version`. The coding backend inspects these; keep this bumped to a
 * version the server still accepts. Overridable via `KIMI_CLI_VERSION` env.
 */
export const KIMI_CLI_VERSION_DEFAULT = '0.27.0'
/** `X-Msh-Platform` value the server allowlists (empirically returns 200). */
export const KIMI_MSH_PLATFORM = 'kimi_code_cli'
/**
 * User-Agent the official CLI sends to the *auth* host (`auth.kimi.com`): the
 * bare Node default `node`, not `kimi-code-cli/<ver>` (that UA is used only on
 * the coding host). Matches the empirical capture — see wire-format.md.
 */
export const KIMI_AUTH_HOST_USER_AGENT = 'node'

/**
 * Canonical model list for a Kimi Code OAuth profile (comma-separated, primary
 * first). Source of truth for the profile the login flow persists AND for the
 * startup heal that upgrades profiles created by an earlier build that only
 * shipped `k3`.
 */
export const KIMI_CODE_MODEL_LIST =
  'k3, kimi-for-coding, kimi-for-coding-highspeed'

export function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

export function getKimiOAuthClientId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    asTrimmedString(env.KIMI_OAUTH_CLIENT_ID) ?? DEFAULT_KIMI_OAUTH_CLIENT_ID
  )
}

export function getKimiCliVersion(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return asTrimmedString(env.KIMI_CLI_VERSION) ?? KIMI_CLI_VERSION_DEFAULT
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
