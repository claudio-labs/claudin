import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
} from 'src/providers/auth/auth.js'

export const MCP_REQUEST_TIMEOUT_MS = 60000

const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000
const DEFAULT_LOCAL_BATCH_SIZE = 3
const DEFAULT_REMOTE_BATCH_SIZE = 20

/** What a Streamable HTTP server must be told the client can read back. */
const STREAMABLE_HTTP_ACCEPT = 'application/json, text/event-stream'

/** A positive integer from the environment, or the fallback. */
function positiveIntFromEnv(variable: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[variable] ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function getConnectionTimeoutMs(): number {
  return positiveIntFromEnv('MCP_TIMEOUT', DEFAULT_CONNECTION_TIMEOUT_MS)
}

export function getMcpServerConnectionBatchSize(): number {
  return positiveIntFromEnv('MCP_SERVER_CONNECTION_BATCH_SIZE', DEFAULT_LOCAL_BATCH_SIZE)
}

export function getRemoteMcpServerConnectionBatchSize(): number {
  return positiveIntFromEnv('MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE', DEFAULT_REMOTE_BATCH_SIZE)
}

/**
 * A signal that aborts after MCP_REQUEST_TIMEOUT_MS or when the caller's does.
 * `settle` stops the clock once the response has arrived; the caller's signal
 * keeps reaching the body afterwards.
 */
function requestSignal(callerSignal: AbortSignal | null | undefined): {
  signal: AbortSignal
  settle: () => void
} {
  const clock = new AbortController()
  const timer = setTimeout(() => {
    clock.abort(
      new DOMException(`MCP request timed out after ${MCP_REQUEST_TIMEOUT_MS}ms`, 'TimeoutError'),
    )
  }, MCP_REQUEST_TIMEOUT_MS)
  timer.unref?.()
  const signal = callerSignal ? AbortSignal.any([callerSignal, clock.signal]) : clock.signal
  return { signal, settle: () => clearTimeout(timer) }
}

/**
 * GETs are the long-lived event streams, so they pass through as they are.
 * Every other request gets its own timeout and, when it names none, the
 * Accept value Streamable HTTP servers require.
 */
export function wrapFetchWithTimeout(baseFetch: FetchLike): FetchLike {
  return async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'GET') return baseFetch(url, init)

    const headers = new Headers(init?.headers)
    if (!headers.has('accept')) headers.set('accept', STREAMABLE_HTTP_ACCEPT)
    const { signal, settle } = requestSignal(init?.signal)
    try {
      return await baseFetch(url, { ...init, headers, signal })
    } finally {
      settle()
    }
  }
}

function currentClaudeAiToken(): string | undefined {
  return getClaudeAIOAuthTokens()?.accessToken || undefined
}

function withBearer(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return { ...init, headers }
}

/**
 * Fetch for the claude.ai MCP proxy: the login token is the bearer. A 401 is
 * retried once, and only with a token different from the one refused, so a
 * stale token can never loop.
 */
export function createClaudeAiProxyFetch(innerFetch: FetchLike): FetchLike {
  return async (url, init) => {
    await checkAndRefreshOAuthTokenIfNeeded()
    const sent = currentClaudeAiToken()
    if (!sent) throw new Error('No claude.ai OAuth token available')

    const refused = await innerFetch(url, withBearer(init, sent))
    if (refused.status !== 401) return refused

    // Its answer is ignored: a token rotated by another process, with no
    // refresh token here, counts as well.
    await handleOAuth401Error(sent)
    const next = currentClaudeAiToken()
    if (!next || next === sent) return refused
    try {
      return await innerFetch(url, withBearer(init, next))
    } catch {
      return refused
    }
  }
}
