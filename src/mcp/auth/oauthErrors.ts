/**
 * Normalizing the error body a token endpoint returns, so the SDK's own
 * error-class mapping applies to servers that do not follow RFC 6749.
 */

import {
  OAuthErrorResponseSchema,
  OAuthTokensSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { jsonParse, jsonStringify } from 'src/platform/slowOperations.js'

/**
 * Some OAuth servers (notably Slack) return HTTP 200 for all responses,
 * signaling errors via the JSON body instead. The SDK's executeTokenRequest
 * only calls parseErrorResponse when !response.ok, so a 200 with
 * {"error":"invalid_grant"} gets fed to OAuthTokensSchema.parse() and
 * surfaces as a ZodError — which the refresh retry/invalidation logic
 * treats as opaque request_failed instead of invalid_grant.
 *
 * This wrapper peeks at 2xx POST response bodies and rewrites ones that
 * match OAuthErrorResponseSchema (but not OAuthTokensSchema) to a 400
 * Response, so the SDK's normal error-class mapping applies. The same
 * fetchFn is also used for DCR POSTs, but DCR success responses have no
 * {error: string} field so they don't match the rewrite condition.
 *
 * Slack uses non-standard error codes (invalid_refresh_token observed live
 * at oauth.v2.user.access; expired_refresh_token/token_expired per Slack's
 * token rotation docs) where RFC 6749 specifies invalid_grant. We normalize
 * those so OAUTH_ERRORS['invalid_grant'] → InvalidGrantError matches and
 * token invalidation fires correctly.
 */
const NONSTANDARD_INVALID_GRANT_ALIASES = new Set([
  'invalid_refresh_token',
  'expired_refresh_token',
  'token_expired',
])

/* eslint-disable eslint-plugin-n/no-unsupported-features/node-builtins --
 * Response has been stable in Node since 18; the rule flags it as
 * experimental-until-21 which is incorrect. Pattern matches existing
 * createAuthFetch suppressions in this file. */
export async function normalizeOAuthErrorBody(
  response: Response,
): Promise<Response> {
  if (!response.ok) {
    return response
  }
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = jsonParse(text)
  } catch {
    return new Response(text, response)
  }
  if (OAuthTokensSchema.safeParse(parsed).success) {
    return new Response(text, response)
  }
  const result = OAuthErrorResponseSchema.safeParse(parsed)
  if (!result.success) {
    return new Response(text, response)
  }
  const normalized = NONSTANDARD_INVALID_GRANT_ALIASES.has(result.data.error)
    ? {
        error: 'invalid_grant',
        error_description:
          result.data.error_description ??
          `Server returned non-standard error code: ${result.data.error}`,
      }
    : result.data
  return new Response(jsonStringify(normalized), {
    status: 400,
    statusText: 'Bad Request',
    headers: response.headers,
  })
}
/* eslint-enable eslint-plugin-n/no-unsupported-features/node-builtins */
