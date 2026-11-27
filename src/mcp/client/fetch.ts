import type { FetchLike } from '@modelcontextprotocol/client'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
} from 'src/providers/auth/auth.js'
import { getMcpToolTimeoutMs } from 'src/mcp/client/serverOptions.js'

/**
 * Fetch wrapper for claude.ai proxy connections. Attaches the OAuth bearer
 * token and retries once on 401 via handleOAuth401Error (force-refresh).
 *
 * The Anthropic API path has this retry (withRetry.ts, grove.ts) to handle
 * The Anthropic API path has this retry (withRetry.ts) to handle
 * memoize-cache staleness and clock drift. Without the same here, a single
 * stale token mass-401s every claude.ai connector and sticks them all in the
 * 15-min needs-auth cache.
 */
export function createClaudeAiProxyFetch(innerFetch: FetchLike): FetchLike {
  return async (url, init) => {
    const doRequest = async () => {
      await checkAndRefreshOAuthTokenIfNeeded()
      const currentTokens = getClaudeAIOAuthTokens()
      if (!currentTokens) {
        throw new Error('No claude.ai OAuth token available')
      }
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const headers = new Headers(init?.headers)
      headers.set('Authorization', `Bearer ${currentTokens.accessToken}`)
      const response = await innerFetch(url, { ...init, headers })
      // Return the exact token that was sent. Reading getClaudeAIOAuthTokens()
      // again after the request is wrong under concurrent 401s: another
      // connector's handleOAuth401Error clears the memoize cache, so we'd read
      // the NEW token from keychain, pass it to handleOAuth401Error, which
      // finds same-as-keychain → returns false → skips retry. Same pattern as
      // bridgeApi.ts withOAuthRetry (token passed as fn param).
      return { response, sentToken: currentTokens.accessToken }
    }

    const { response, sentToken } = await doRequest()
    if (response.status !== 401) {
      return response
    }
    // handleOAuth401Error returns true only if the token actually changed
    // (keychain had a newer one, or force-refresh succeeded). Gate retry on
    // that — otherwise we double round-trip time for every connector whose
    // downstream service genuinely needs auth (the common case: 30+ servers
    // with "MCP server requires authentication but no OAuth token configured").
    const tokenChanged = await handleOAuth401Error(sentToken).catch(() => false)
    if (!tokenChanged) {
      // ELOCKED contention: another connector may have won the lockfile and refreshed — check if token changed underneath us
      const now = getClaudeAIOAuthTokens()?.accessToken
      if (!now || now === sentToken) {
        return response
      }
    }
    try {
      return (await doRequest()).response
    } catch {
      // Retry itself failed (network error). Return the original 401 so the
      // outer handler can classify it.
      return response
    }
  }
}

/**
 * Default timeout for individual MCP requests (auth, tool calls, etc.)
 */
export const MCP_REQUEST_TIMEOUT_MS = 60000

const TOOLS_CALL_BODY_RE = /"method"\s*:\s*"tools\/call"/

/**
 * The cap on one POST. A tools/call answered as JSON holds its request open
 * until the tool is done, so it gets the tool timeout; a 60 s cap there cut
 * every slow tool of a Streamable HTTP server short of MCP_TOOL_TIMEOUT.
 */
export function requestTimeoutMs(
  init: RequestInit | undefined,
  toolCallTimeoutMs: number = getMcpToolTimeoutMs(),
): number {
  return typeof init?.body === 'string' && TOOLS_CALL_BODY_RE.test(init.body)
    ? toolCallTimeoutMs
    : MCP_REQUEST_TIMEOUT_MS
}

/**
 * MCP Streamable HTTP spec requires clients to advertise acceptance of both
 * JSON and SSE on every POST. Servers that enforce this strictly reject
 * requests without it (HTTP 406).
 * https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#sending-messages-to-the-server
 */
const MCP_STREAMABLE_HTTP_ACCEPT = 'application/json, text/event-stream'

function isEventStream(response: Response): boolean {
  return response.body !== null && (response.headers.get('content-type') ?? '').includes('text/event-stream')
}

/** `response` with a body that calls `release` once it ends, fails or is cancelled. */
function untilBodyEnds(response: Response, release: () => void): Response {
  const reader = response.body!.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          release()
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch (error) {
        release()
        controller.error(error)
      }
    },
    cancel(reason) {
      release()
      return reader.cancel(reason)
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

/**
 * Wraps a fetch function to apply a fresh timeout signal to each request.
 * This avoids the bug where a single AbortSignal.timeout() created at connection
 * time becomes stale after 60 seconds, causing all subsequent requests to fail
 * immediately with "The operation timed out." Uses a 60-second timeout, or the
 * tool timeout for a tools/call (requestTimeoutMs).
 *
 * Also ensures the Accept header required by the MCP Streamable HTTP spec is
 * present on POSTs. The MCP SDK sets this inside StreamableHTTPClientTransport.send(),
 * but it is attached to a Headers instance that passes through an object spread here,
 * and some runtimes/agents have been observed dropping it before it reaches the wire.
 * See https://github.com/anthropics/claude-agent-sdk-typescript/issues/202.
 * Normalizing here (the last wrapper before fetch()) guarantees it is sent.
 *
 * GET requests are excluded from the timeout since, for MCP transports, they are
 * long-lived SSE streams meant to stay open indefinitely. (Auth-related GETs use
 * a separate fetch wrapper with its own timeout in auth.ts.)
 *
 * @param baseFetch - The fetch function to wrap
 */
export function wrapFetchWithTimeout(
  baseFetch: FetchLike,
  options: { toolCallTimeoutMs?: number } = {},
): FetchLike {
  return async (url: string | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()

    // Skip timeout for GET requests - in MCP transports, these are long-lived SSE streams.
    // (OAuth discovery GETs in auth.ts use a separate createAuthFetch() with its own timeout.)
    if (method === 'GET') {
      return baseFetch(url, init)
    }

    // Normalize headers and guarantee the Streamable-HTTP Accept value. new Headers()
    // accepts HeadersInit | undefined and copies from plain objects, tuple arrays,
    // and existing Headers instances — so whatever shape the SDK handed us, the
    // Accept value survives the spread below as an own property of a concrete object.
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    if (!headers.has('accept')) {
      headers.set('accept', MCP_STREAMABLE_HTTP_ACCEPT)
    }

    // Use setTimeout instead of AbortSignal.timeout() so we can clearTimeout on
    // completion. AbortSignal.timeout's internal timer is only released when the
    // signal is GC'd, which in Bun is lazy — ~2.4KB of native memory per request
    // lingers for the full 60s even when the request completes in milliseconds.
    const controller = new AbortController()
    const timer = setTimeout(
      c =>
        c.abort(new DOMException('The operation timed out.', 'TimeoutError')),
      requestTimeoutMs(init, options.toolCallTimeoutMs),
      controller,
    )
    timer.unref?.()

    const parentSignal = init?.signal
    const abort = () => controller.abort(parentSignal?.reason)
    parentSignal?.addEventListener('abort', abort)
    if (parentSignal?.aborted) {
      controller.abort(parentSignal.reason)
    }

    const cleanup = () => {
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', abort)
    }

    try {
      const response = await baseFetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!parentSignal || !isEventStream(response)) {
        cleanup()
        return response
      }
      // A streamed answer stays tied to the caller's signal until its body
      // ends. On 2026-07-28 aborting a request's stream IS its cancellation
      // (the SDK sends no notifications/cancelled), and it is how an
      // events/stream or subscriptions/listen is closed: released at the
      // headers, the abort never reached the server, and the SDK went on
      // reading a stream it had given up.
      return untilBodyEnds(response, cleanup)
    } catch (error) {
      cleanup()
      throw error
    }
  }
}

/**
 * Sends a server's configured Authorization header in place of the one the
 * SDK's auth provider sets. SDK 1.x merged `requestInit` headers after the
 * provider's, so a static header beat stored OAuth tokens; 2.x merges them
 * first, and the provider's token won.
 */
export function wrapFetchWithConfiguredAuthorization(
  baseFetch: FetchLike,
  authorization: string,
): FetchLike {
  return (url: string | URL, init?: RequestInit) => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    headers.set('authorization', authorization)
    return baseFetch(url, { ...init, headers })
  }
}

const EVENTS_BODY_RE = /"method"\s*:\s*"events\//

/** The event name an `events/*` request POSTs, or undefined for any other body. */
export function eventNameOfBody(body: unknown): string | undefined {
  if (typeof body !== 'string' || !EVENTS_BODY_RE.test(body)) return undefined
  try {
    // Only an object or an array can hold the text the regex matched.
    const message = JSON.parse(body) as { method?: unknown; params?: { name?: unknown } }
    if (typeof message.method !== 'string' || !message.method.startsWith('events/')) return undefined
    return typeof message.params?.name === 'string' ? message.params.name : undefined
  } catch {
    return undefined
  }
}

/**
 * Sets `Mcp-Name: <event name>` on the `events/*` POSTs, as SEP-3415 asks of
 * Streamable HTTP. The SDK adds the header for the core methods it knows
 * and refuses to take any `mcp-*` header from request options, so the
 * extension's has to be set here.
 */
export function wrapFetchWithEventName(baseFetch: FetchLike): FetchLike {
  return (url: string | URL, init?: RequestInit) => {
    const name = eventNameOfBody(init?.body)
    if (name === undefined) return baseFetch(url, init)
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    headers.set('mcp-name', name)
    return baseFetch(url, { ...init, headers })
  }
}

export function getMcpServerConnectionBatchSize(): number {
  return parseInt(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE || '', 10) || 3
}

export function getRemoteMcpServerConnectionBatchSize(): number {
  return (
    parseInt(process.env.MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE || '', 10) ||
    20
  )
}
