/**
 * How long the openai shim waits on a silent connection.
 *
 * A local model server (Ollama, llama.cpp, LM Studio) sends nothing — not even
 * the response headers — until it has processed the whole prompt, and a long
 * prompt on a consumer GPU takes minutes. Both runtimes cut that short at
 * 300 s: Bun's fetch has a 5-minute idle timeout (`timeout` in the init turns
 * it off or changes it), and Node's undici Agent a 300 s `headersTimeout`. The
 * request then failed as a retryable 503 and started over, ten times.
 *
 * `API_TIMEOUT_MS` sets it everywhere, as it does for the Anthropic SDK path
 * (which the shim used to ignore). Unset, a local server gets 30 minutes and a
 * hosted endpoint the SDK path's 600 s. Esc still cancels at any point.
 */
import type * as undici from 'undici'
import { isLocalProviderUrl } from 'src/providers/presets/providerConfig.js'

export const LOCAL_SHIM_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const HOSTED_SHIM_IDLE_TIMEOUT_MS = 600 * 1000

export function resolveShimIdleTimeoutMs(
  baseUrl: string | undefined,
  env: Record<string, string | undefined> = process.env,
): number {
  const explicit = Number.parseInt(env.API_TIMEOUT_MS ?? '', 10)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return isLocalProviderUrl(baseUrl) ? LOCAL_SHIM_IDLE_TIMEOUT_MS : HOSTED_SHIM_IDLE_TIMEOUT_MS
}

const localDispatchers = new Map<number, undici.Dispatcher>()

/**
 * The undici Agent for a local model server under Node, with the idle timeout
 * as its `headersTimeout` and `bodyTimeout`. One per timeout value; the
 * per-provider Agents in proxy.ts keep undici's defaults for everything else.
 */
export function localModelServerDispatcher(timeoutMs: number): undici.Dispatcher {
  const cached = localDispatchers.get(timeoutMs)
  if (cached) return cached
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const undiciMod = require('undici') as typeof undici
  const dispatcher = new undiciMod.Agent({
    connections: 12,
    keepAliveTimeout: 30_000,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  })
  localDispatchers.set(timeoutMs, dispatcher)
  return dispatcher
}
