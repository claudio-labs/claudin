/**
 * Diagnostics URL redaction for the openaiShim modules.
 *
 * Distinct from `src/utils/urlRedaction.ts` (which is purely lexical) — this
 * variant also runs the URL through `redactSecretValueForDisplay`, replacing
 * any substring that matches a known environment-stored secret (api keys,
 * OAuth tokens) with `***`. Required because some local providers embed the
 * key in the URL path or query and the shim logs that URL for debugging.
 */

import { redactSecretValueForDisplay } from 'src/services/api/providerProfile.js'
import { SENSITIVE_URL_QUERY_PARAM_NAMES } from './constants.js'
import type { SecretValueSource } from './types.js'

export function shouldRedactUrlQueryParam(name: string): boolean {
  const lower = name.toLowerCase()
  return SENSITIVE_URL_QUERY_PARAM_NAMES.some(token => lower.includes(token))
}

export function redactUrlForDiagnostics(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.username) {
      parsed.username = 'redacted'
    }
    if (parsed.password) {
      parsed.password = 'redacted'
    }

    for (const key of parsed.searchParams.keys()) {
      if (shouldRedactUrlQueryParam(key)) {
        parsed.searchParams.set(key, 'redacted')
      }
    }

    const serialized = parsed.toString()
    return redactSecretValueForDisplay(serialized, process.env as SecretValueSource) ?? serialized
  } catch {
    return redactSecretValueForDisplay(url, process.env as SecretValueSource) ?? url
  }
}
