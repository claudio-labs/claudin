/**
 * Header helpers used by the openaiShim request builder.
 *
 * `filterAnthropicHeaders` strips Anthropic-canonical headers from any
 * caller-provided default header bag so they never leak to OpenAI-compatible
 * providers (they reject `anthropic-*`/`x-api-key` and friends).
 *
 * `formatRetryAfterHint` formats the `Retry-After` response header for
 * inclusion in user-facing diagnostics.
 */

export function filterAnthropicHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {}

  const filtered: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (
      lower.startsWith('x-anthropic') ||
      lower.startsWith('anthropic-') ||
      lower.startsWith('x-claude') ||
      lower === 'x-app' ||
      lower === 'x-client-app' ||
      lower === 'authorization' ||
      lower === 'x-api-key' ||
      lower === 'api-key'
    ) {
      continue
    }
    filtered[key] = value
  }

  return filtered
}

export function formatRetryAfterHint(response: Response): string {
  const ra = response.headers.get('retry-after')
  return ra ? ` (Retry-After: ${ra})` : ''
}
