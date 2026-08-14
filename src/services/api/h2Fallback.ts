import { isProviderH1Only, markProviderH1Only } from 'src/utils/proxy.js'

// Errors that indicate HTTP/2 negotiation/protocol failure (not network or
// app-level issues). When we see one of these for a provider's first contact
// on h2, we mark the provider as h1-only and retry once. Patterns are case-
// insensitive and match both error.message and error.code.
//
// Anchored to specific tokens (ERR_HTTP2_*, NGHTTP2_*, stream_refused,
// ALPN protocol mismatch, undici h2 protocol-error codes). Avoids the loose
// `/HTTP\/?2/` form that would match any prose containing "HTTP/2" (e.g. an
// upstream 4xx body echoed into an error message) and mis-mark a provider
// as h1-only for the rest of the session.
//
// Bare `GOAWAY` is intentionally NOT matched on its own: a healthy h2 server
// emits GOAWAY during graceful shutdowns/restarts, and a single rollover
// would otherwise pin the session to h1 for the remainder of the process
// lifetime. We rely on the protocol-error codes (which fire on actual
// negotiation failures) to drive sticky h1-only marking.
const H2_FAILURE_PATTERN =
  /\b(?:ERR_HTTP2_[A-Z_]+|NGHTTP2_[A-Z_]+|ERR_INVALID_HTTP_VERSION|ALPN(?:_[A-Z]+)?|stream[ _]refused|invalid (?:frame|stream)|H2_[A-Z_]+|HTTP_2_PROTOCOL_ERROR|HTTP\/2 (?:stream|frame|protocol|connection|session))\b/i

export function isH2FailureError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'AbortError') return false
  if (H2_FAILURE_PATTERN.test(error.message)) return true
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && H2_FAILURE_PATTERN.test(code)) return true
  return false
}

/**
 * Wrap a fetch call with optimistic HTTP/2 + sticky fallback to h1.
 *
 * Behavior:
 *   1. First attempt uses whatever Agent the dispatcher provides (h2 enabled
 *      by default for known providers — see getProviderDispatcher).
 *   2. If the attempt throws an h2-protocol error AND we haven't already
 *      marked this provider as h1-only, mark it (which invalidates the
 *      cached Agent so the next build uses allowH2:false) and retry once.
 *   3. Any other error, or a second failure on h1, propagates unchanged.
 *
 * The marker is sticky for the process lifetime so subsequent requests skip
 * the h2 attempt entirely.
 */
export async function withH2Fallback<T>(
  provider: string | undefined,
  doFetch: () => Promise<T>,
): Promise<T> {
  try {
    return await doFetch()
  } catch (error) {
    if (
      provider &&
      provider.trim() !== '' &&
      !isProviderH1Only(provider) &&
      isH2FailureError(error)
    ) {
      markProviderH1Only(provider)
      return await doFetch()
    }
    throw error
  }
}
