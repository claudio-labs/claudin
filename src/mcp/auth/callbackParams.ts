/**
 * The OAuth redirect coming back from the browser: reading a query parameter
 * that may have been sent more than once, validating state before anything
 * else, and redacting the sensitive parameters out of a URL before it reaches
 * a log.
 */

const LOG_REDACTED_QUERY_PARAMS: readonly string[] = [
  'state',
  'nonce',
  'code_challenge',
  'code_verifier',
  'code',
]
const REDACTION = '[REDACTED]'

export function redactSensitiveUrlParams(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  for (const name of LOG_REDACTED_QUERY_PARAMS) {
    // set() also drops any repeat of the name, so one marker stands for all.
    if (parsed.searchParams.has(name)) parsed.searchParams.set(name, REDACTION)
  }
  return parsed.toString()
}

type OAuthCallbackParamValue = string | string[] | null | undefined

export type OAuthCallbackValidationResult =
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
  if (Array.isArray(value)) return value.find(item => item !== '')
  return value ? value : undefined
}

function describeOAuthError(
  error: string,
  description: string,
  uri: string,
): string {
  let message = `OAuth error: ${error}`
  if (description) message += ` - ${description}`
  if (uri) message += ` (See: ${uri})`
  return message
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
  // State first: nothing else in a forged redirect may be acted on. A reduced
  // parameter is never '', so an empty expected state can never match.
  const state = getFirstOAuthCallbackParam(params.state)
  if (state !== oauthState) {
    return { type: 'state_mismatch' }
  }

  const error = getFirstOAuthCallbackParam(params.error)
  if (error !== undefined) {
    const errorDescription =
      getFirstOAuthCallbackParam(params.error_description) ?? ''
    const errorUri = getFirstOAuthCallbackParam(params.error_uri) ?? ''
    return {
      type: 'error',
      error,
      errorDescription,
      errorUri,
      message: describeOAuthError(error, errorDescription, errorUri),
    }
  }

  const code = getFirstOAuthCallbackParam(params.code)
  return code === undefined ? { type: 'missing_result' } : { type: 'code', code }
}
