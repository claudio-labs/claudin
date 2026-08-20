import { logForDebugging } from 'src/shared/debug.js'
import { sleep } from 'src/shared/sleep.js'

/** Exponential-backoff shape for a bounded retry loop. */
export type RetryBackoff = {
  maxAttempts: number
  baseDelayMs: number
  jitterFraction: number
  maxDelayMs: number
}

/**
 * Backoff for POST /v1/sessions. Session creation is the most common way
 * Remote Control dies at connect time — a 5xx or a timed-out request used to
 * surface immediately as "Remote Control failed · Session creation failed"
 * with no retry at all. Five attempts spread over ~7.5s of sleeping ride out
 * a transient server blip while still giving up soon enough that a genuinely
 * broken connect doesn't hang on "connecting…".
 */
export const SESSION_CREATE_BACKOFF: RetryBackoff = {
  maxAttempts: 5,
  baseDelayMs: 500,
  jitterFraction: 0.25,
  maxDelayMs: 4000,
}

/**
 * Delay before the attempt following failed attempt `attempt` (1-based).
 * Exponential from baseDelayMs, ±jitterFraction, clamped to maxDelayMs.
 */
export function retryDelayMs(
  attempt: number,
  backoff: RetryBackoff,
  random: () => number = Math.random,
): number {
  const base = backoff.baseDelayMs * 2 ** (attempt - 1)
  const jitter = base * backoff.jitterFraction * (2 * random() - 1)
  return Math.min(base + jitter, backoff.maxDelayMs)
}

/**
 * Call `fn` until it returns non-null, up to `maxAttempts` times, sleeping
 * with exponential backoff between attempts. Returns null when every attempt
 * failed or when `signal` aborts (teardown) — the callers all treat null as
 * "give up", so the contract is unchanged from a single unretried call.
 *
 * `isRetryable` is consulted after each failed attempt: returning false stops
 * the loop immediately. Without it a permanent server answer — a 4xx the
 * server will repeat verbatim — costs the whole backoff before failing anyway.
 */
export async function retryWhileNull<T>(
  fn: () => Promise<T | null>,
  opts: RetryBackoff & {
    label: string
    logPrefix?: string
    signal?: AbortSignal
    isRetryable?: () => boolean
  },
): Promise<T | null> {
  const { label, logPrefix = '[bridge]', signal, isRetryable } = opts
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const result = await fn()
    if (result !== null) return result
    if (isRetryable && !isRetryable()) {
      logForDebugging(
        `${logPrefix} ${label} failed permanently on attempt ${attempt}/${opts.maxAttempts}, not retrying`,
      )
      return null
    }
    if (signal?.aborted) {
      logForDebugging(
        `${logPrefix} ${label} aborted after attempt ${attempt}/${opts.maxAttempts}`,
      )
      return null
    }
    if (attempt < opts.maxAttempts) {
      const delay = retryDelayMs(attempt, opts)
      logForDebugging(
        `${logPrefix} ${label} failed (attempt ${attempt}/${opts.maxAttempts}), retrying in ${Math.round(delay)}ms`,
      )
      await sleep(delay)
    }
  }
  return null
}
