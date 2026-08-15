import { disableKeepAlive, getProxyFetchOptions } from 'src/providers/transport/proxy.js'
import { withH2Fallback } from 'src/providers/transport/h2Fallback.js'
import { pickFetch } from 'src/providers/transport/pickFetch.js'

const RETRYABLE_FETCH_ERROR_PATTERN =
  /socket connection was closed unexpectedly|ECONNRESET|EPIPE|socket hang up|Connection reset by peer|fetch failed/i

export function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  if (error.name === 'AbortError') {
    return false
  }
  return RETRYABLE_FETCH_ERROR_PATTERN.test(error.message)
}

export async function fetchWithProxyRetry(
  input: string | URL | Request,
  init?: RequestInit,
  options?: { forAnthropicAPI?: boolean; maxAttempts?: number; provider?: string },
): Promise<Response> {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? 2)
  let lastError: unknown
  // Per-call keep-alive override for provider-less callers (WebSearch, etc.).
  // Avoids the previous shared 'unknown' bucket that would leak a single
  // ECONNRESET into every subsequent provider-less request for the process
  // lifetime. With a provider, we still mark the per-provider bucket so the
  // tuned dispatcher is rebuilt and subsequent requests benefit too.
  let localKeepAliveDisabled = false

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // withH2Fallback wraps each attempt so h2 protocol failures get a
      // single sticky h1-only retry BEFORE we consider keep-alive eviction.
      // Order matters: h2 fallback is per-provider sticky, keep-alive retry
      // is per-attempt. getProxyFetchOptions is re-evaluated inside the
      // closure so the second call after markProviderH1Only picks up the
      // freshly rebuilt allowH2:false dispatcher.
      return await withH2Fallback(options?.provider, () => {
        const mergedInit = {
          ...init,
          ...getProxyFetchOptions({
            forAnthropicAPI: options?.forAnthropicAPI,
            provider: options?.provider,
          }),
          ...(localKeepAliveDisabled ? { keepalive: false as const } : {}),
        }
        // pickFetch routes to undici.fetch when a dispatcher is attached,
        // avoiding the Node-embedded-undici/installed-undici handler mismatch
        // that crashes globalThis.fetch with UND_ERR_INVALID_ARG.
        // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
        return pickFetch(mergedInit, fetch)(input, mergedInit)
      })
    } catch (error) {
      lastError = error
      if (attempt >= maxAttempts || !isRetryableFetchError(error)) {
        throw error
      }
      if (options?.provider) {
        disableKeepAlive(options.provider)
      } else {
        localKeepAliveDisabled = true
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Fetch failed without an error object')
}
