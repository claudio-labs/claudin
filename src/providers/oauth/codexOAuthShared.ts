// Adapted from opencode (MIT, Copyright (c) 2025 opencode):
// packages/opencode/src/plugin/openai/codex.ts
// packages/core/src/oauth/page.ts
import { logForDebugging } from 'src/shared/debug.js'

export const CODEX_OAUTH_ISSUER = 'https://auth.openai.com'
export const CODEX_REFRESH_URL = `${CODEX_OAUTH_ISSUER}/oauth/token`
export const DEFAULT_CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const DEFAULT_CODEX_OAUTH_CALLBACK_PORT = 1455
export const CODEX_OAUTH_SCOPE =
  'openid profile email offline_access api.connectors.read api.connectors.invoke'
export const CODEX_OAUTH_ORIGINATOR = 'codex_cli_rs'
export const CODEX_API_KEY_TOKEN_NAME = 'openai-api-key'
export const CODEX_ID_TOKEN_SUBJECT_TYPE =
  'urn:ietf:params:oauth:token-type:id_token'
export const CODEX_TOKEN_EXCHANGE_GRANT =
  'urn:ietf:params:oauth:grant-type:token-exchange'

const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth'
const MAX_PORT = 65_535
const LEADING_DIGITS_RE = /^\d+/

export function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function getCodexOAuthClientId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return asTrimmedString(env.CODEX_OAUTH_CLIENT_ID) ?? DEFAULT_CODEX_OAUTH_CLIENT_ID
}

/** `0` is kept: it asks the OS for any free port. */
export function getCodexOAuthCallbackPort(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = asTrimmedString(env.CODEX_OAUTH_CALLBACK_PORT)
  const digits = raw === undefined ? undefined : LEADING_DIGITS_RE.exec(raw)?.[0]
  if (digits === undefined) return DEFAULT_CODEX_OAUTH_CALLBACK_PORT
  const port = Number(digits)
  return port <= MAX_PORT ? port : DEFAULT_CODEX_OAUTH_CALLBACK_PORT
}

/** The claims of a JWT, unverified. Anything that is not a JWT yields undefined. */
export function decodeJwtPayload(
  token: string,
): Record<string, unknown> | undefined {
  const payload = token.split('.')[1]
  if (payload === undefined) return undefined
  // An opaque (non-JWT) token is expected here, so a parse failure is an answer, not an error.
  const claims = parseJson(Buffer.from(payload, 'base64url').toString('utf8'))
  return isRecord(claims) ? claims : undefined
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function firstOrganizationId(
  holder: Record<string, unknown> | undefined,
): unknown {
  const organizations = holder?.organizations
  if (!Array.isArray(organizations)) return undefined
  const first: unknown = organizations[0]
  return isRecord(first) ? first.id : undefined
}

/**
 * The ChatGPT account a token belongs to, sent as `ChatGPT-Account-Id`. The
 * first claim that is present decides: a blank one does not fall through to
 * a lower-priority claim.
 */
export function parseChatgptAccountId(
  token: string | undefined,
): string | undefined {
  if (!token) return undefined
  const claims = decodeJwtPayload(token)
  if (!claims) return undefined
  const authClaim = claims[OPENAI_AUTH_CLAIM]
  const auth = isRecord(authClaim) ? authClaim : undefined
  const candidates: unknown[] = [
    auth?.chatgpt_account_id,
    claims[`${OPENAI_AUTH_CLAIM}.chatgpt_account_id`],
    claims.chatgpt_account_id,
    firstOrganizationId(auth) ?? firstOrganizationId(claims),
  ]
  return asTrimmedString(candidates.find(claim => claim !== undefined && claim !== null))
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Every grant (code, refresh, token exchange) is a form POST to the same endpoint. */
export function postCodexTokenForm(
  form: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(CODEX_REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal,
  })
}

/** Trades an id token for a platform API key (RFC 8693 token exchange). */
export async function exchangeCodexIdTokenForApiKey(
  idToken: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const response = await postCodexTokenForm(
    {
      grant_type: CODEX_TOKEN_EXCHANGE_GRANT,
      client_id: getCodexOAuthClientId(),
      requested_token: CODEX_API_KEY_TOKEN_NAME,
      subject_token: idToken,
      subject_token_type: CODEX_ID_TOKEN_SUBJECT_TYPE,
    },
    options.signal,
  )
  const text = await response.text()
  if (!response.ok) {
    const detail = text.trim()
    throw new Error(
      detail
        ? `Codex API key exchange failed (${response.status}): ${detail}`
        : `Codex API key exchange failed with status ${response.status}.`,
    )
  }
  const body = parseJson(text)
  const apiKey = isRecord(body) ? asTrimmedString(body.access_token) : undefined
  if (!apiKey) {
    throw new Error(
      'Codex API key exchange completed, but no API key token was returned.',
    )
  }
  return apiKey
}

/**
 * The API key is an optimisation: without it the access token is sent
 * instead, so a failed exchange is logged and the login or refresh goes on.
 */
export async function mintCodexApiKey(
  idToken: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    return await exchangeCodexIdTokenForApiKey(idToken, { signal })
  } catch (error) {
    logForDebugging(
      `[codex] API key exchange failed, falling back to the access token: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'warn' },
    )
    return undefined
  }
}
