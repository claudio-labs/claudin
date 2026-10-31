import { isAbortError, isSdkApiUserAbortError } from 'src/shared/errors.js'

/**
 * Whether a request error is the user cancelling it (Esc), as opposed to a
 * failure worth reporting.
 *
 * The Anthropic SDK raises `APIUserAbortError`. The openai shim calls `fetch`
 * itself and rethrows fetch's own `DOMException` named `AbortError`, which the
 * SDK check misses — so an Esc on an OpenAI-compatible request rendered as
 * "API Error: The operation was aborted." above the "Interrupted" line. That
 * shape only counts while the request's signal is aborted: the same exception
 * with a live signal is a timeout or a dropped socket, and stays an error.
 */
export function isUserAbort(error: unknown, signal: AbortSignal): boolean {
  return isSdkApiUserAbortError(error) || (signal.aborted && isAbortError(error))
}
