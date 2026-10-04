/**
 * Normalizing the error body a token endpoint returns, so the SDK's own
 * error-class mapping applies to servers that do not follow RFC 6749.
 */

import {
  OAuthErrorResponseSchema,
  OAuthTokensSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { jsonParse, jsonStringify } from 'src/platform/slowOperations.js'

// Vendor spellings (Slack among them) of what RFC 6749 calls invalid_grant.
const VENDOR_INVALID_GRANT_CODES: ReadonlySet<string> = new Set([
  'invalid_refresh_token',
  'expired_refresh_token',
  'token_expired',
])

type StandardErrorBody = {
  error: string
  error_description?: string
  error_uri?: string
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return jsonParse(text)
  } catch {
    return undefined
  }
}

/** The RFC 6749 body to answer with instead, or undefined to pass through. */
function standardErrorFor(text: string): StandardErrorBody | undefined {
  const body = parseJsonOrUndefined(text)
  if (body === undefined) return undefined
  if (OAuthTokensSchema.safeParse(body).success) return undefined
  const parsed = OAuthErrorResponseSchema.safeParse(body)
  if (!parsed.success) return undefined

  const { error, error_description, error_uri } = parsed.data
  if (VENDOR_INVALID_GRANT_CODES.has(error)) {
    return {
      error: 'invalid_grant',
      error_description:
        error_description ??
        `Server returned non-standard error code: ${error}`,
    }
  }
  return { error, error_description, error_uri }
}

export async function normalizeOAuthErrorBody(
  response: Response,
): Promise<Response> {
  if (!response.ok) return response

  // Read a copy, so a pass-through hands back the untouched original.
  const standard = standardErrorFor(await response.clone().text())
  if (!standard) return response

  return new Response(jsonStringify(standard), {
    status: 400,
    statusText: 'Bad Request',
    headers: response.headers,
  })
}
