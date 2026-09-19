/**
 * The OAuth redirect coming back from the browser: reading a query parameter
 * that may have been sent more than once, validating state before anything
 * else, and redacting the sensitive parameters out of a URL before it reaches
 * a log.
 */
/**
 * OAuth query parameters that should be redacted from logs.
 * These contain sensitive values that could enable CSRF or session fixation attacks.
 */
const SENSITIVE_OAUTH_PARAMS = [
  'state',
  'nonce',
  'code_challenge',
  'code_verifier',
  'code',
]

/**
 * Redacts sensitive OAuth query parameters from a URL for safe logging.
 * Prevents exposure of state, nonce, code_challenge, code_verifier, and authorization codes.
 */
export function redactSensitiveUrlParams(url: string): string {
  try {
    const parsedUrl = new URL(url)
    for (const param of SENSITIVE_OAUTH_PARAMS) {
      if (parsedUrl.searchParams.has(param)) {
        parsedUrl.searchParams.set(param, '[REDACTED]')
      }
    }
    return parsedUrl.toString()
  } catch {
    // Return as-is if not a valid URL
    return url
  }
}

type OAuthCallbackParamValue = string | string[] | null | undefined

type OAuthCallbackValidationResult =
  | { type: 'code'; code: string }
  | {
      type: 'error'
      error: string
      errorDescription: string
      errorUri: string
      message: string
    }
  | { type: 'missing_result' }
  | { type: 'state_mismatch' }

export function getFirstOAuthCallbackParam(
  value: OAuthCallbackParamValue,
): string | undefined {
  if (Array.isArray(value)) {
    return value.find(item => item.length > 0)
  }
  return value && value.length > 0 ? value : undefined
}

export function validateOAuthCallbackParams(
  params: {
    code?: OAuthCallbackParamValue
    state?: OAuthCallbackParamValue
    error?: OAuthCallbackParamValue
    error_description?: OAuthCallbackParamValue
    error_uri?: OAuthCallbackParamValue
  },
  oauthState: string,
): OAuthCallbackValidationResult {
  const code = getFirstOAuthCallbackParam(params.code)
  const state = getFirstOAuthCallbackParam(params.state)
  const error = getFirstOAuthCallbackParam(params.error)
  const errorDescription =
    getFirstOAuthCallbackParam(params.error_description) ?? ''
  const errorUri = getFirstOAuthCallbackParam(params.error_uri) ?? ''

  if (state !== oauthState) {
    return { type: 'state_mismatch' }
  }

  if (error) {
    let message = `OAuth error: ${error}`
    if (errorDescription) {
      message += ` - ${errorDescription}`
    }
    if (errorUri) {
      message += ` (See: ${errorUri})`
    }
    return {
      type: 'error',
      error,
      errorDescription,
      errorUri,
      message,
    }
  }

  if (code) {
    return { type: 'code', code }
  }

  return { type: 'missing_result' }
}
