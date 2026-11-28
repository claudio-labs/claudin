/**
 * What the ChatGPT Codex backend gets beyond the plain Responses API, and the
 * one place that decides whether a request, or a whole session, talks to it.
 *
 * From Codex CLI 0.162.1 on the wire (mitmproxy, gpt-5.6-terra, 2026-10-16):
 *   include: ["reasoning.encrypted_content"]  the reasoning comes back, encrypted
 *   reasoning.context: "all_turns"            and the model reads all of it, every turn
 *   text.verbosity: "low"                     the catalog default of every account model
 * and every reasoning item replayed in `input` (items.ts).
 *
 * `parallel_tool_calls` stays true. Codex sends false because its single `exec`
 * tool batches calls inside JavaScript; Claudin's tools are built to run side
 * by side.
 *
 * The gate is the backend, not the provider tag: GitHub Copilot sends its GPT-5+
 * models through the same Responses code.
 *
 * Killswitch: CLAUDIN_CODEX_REASONING_REPLAY=0 sends what Claudin sent before:
 * no include, context or verbosity, no reasoning items, synthetic call ids, and
 * resume and every render strip the Codex item state as for any other
 * provider. The stream-error fix in codexShim.ts stays on either way.
 */
import { isSdkApiError } from 'src/shared/errors.js'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import {
  isCodexBaseUrl,
  resolveProviderRequest,
  type ResolvedProviderRequest,
} from 'src/providers/presets/providerConfig.js'

/** The code the backend answers with when a replayed reasoning payload no longer decrypts. */
export const CODEX_REPLAY_REFUSED_CODE = 'invalid_encrypted_content'

/** Marks a Codex-backend request whose max_tokens goes out as max_output_tokens. */
export const CODEX_HONOR_MAX_TOKENS: unique symbol = Symbol('codexHonorMaxTokens')

/** A request body that may carry the mark. */
export type CodexMarkableParams = Record<string, unknown> & { [CODEX_HONOR_MAX_TOKENS]?: true }

/** The Responses API's lowest max_output_tokens. */
export const CODEX_MIN_OUTPUT_TOKENS = 16

export function isCodexReasoningReplayEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_CODEX_REASONING_REPLAY)
}

/** Whether this request goes to the ChatGPT Codex backend. */
export function isCodexBackendRequest(
  request: Pick<ResolvedProviderRequest, 'transport' | 'baseUrl'>,
): boolean {
  return request.transport === 'codex_responses' && isCodexBaseUrl(request.baseUrl)
}

/** Whether this request goes to the Codex backend with the replay on. */
export function codexReplayActive(
  request: Pick<ResolvedProviderRequest, 'transport' | 'baseUrl'>,
): boolean {
  return isCodexBackendRequest(request) && isCodexReasoningReplayEnabled()
}

/**
 * Whether this request replays Responses items: the Codex backend, or a host
 * the wire table sends to its Responses API (`openai_responses`), which takes
 * the reasoning back encrypted under `store: false` the same way (recorded,
 * cassettes/openai-responses). Message ids and phases stay Codex-only.
 */
export function responsesReplayActive(
  request: Pick<ResolvedProviderRequest, 'transport' | 'baseUrl'>,
): boolean {
  return codexReplayActive(request) || (request.transport === 'openai_responses' && isCodexReasoningReplayEnabled())
}

/**
 * The keep-alive ping for `params` (src/agent/cache/anthropic/keepAlive.ts) on
 * this request's transport. The ping is a read with max_tokens at the floor,
 * which the Responses body drops:
 *  - Chat Completions keeps max_tokens, so the body goes as it is;
 *  - the Codex backend takes it as max_output_tokens when the body is marked
 *    (16 answered `response.incomplete` live, 2026-11-23);
 *  - a Responses API host on `openai_responses` always gets max_output_tokens,
 *    so the body goes as it is;
 *  - any other Responses host gets null, no ping: Copilot bills each request.
 */
export function codexKeepAlivePingParams(
  request: Pick<ResolvedProviderRequest, 'transport' | 'baseUrl'>,
  params: Record<string, unknown>,
): CodexMarkableParams | null {
  if (request.transport !== 'codex_responses') return params
  return isCodexBackendRequest(request) ? { ...params, [CODEX_HONOR_MAX_TOKENS]: true } : null
}

/**
 * Whether the active session's requests go to the Codex backend. Decides what
 * the ChatGPT account offers (its models, context window, effort levels),
 * which the replay killswitch does not change.
 */
export function activeSessionOnCodexBackend(): boolean {
  const provider = tryGetActiveProvider()
  if (!provider) return false
  return isCodexBackendRequest(
    resolveProviderRequest({ model: provider.model, baseUrl: provider.baseUrl }),
  )
}

/**
 * Whether the active session replays Responses items. Decides, for everything
 * that runs before the shim (rendering, resume), whether the item state is
 * kept or redacted.
 */
export function activeSessionReplaysCodexItems(): boolean {
  const provider = tryGetActiveProvider()
  if (!provider) return false
  return responsesReplayActive(resolveProviderRequest({ model: provider.model, baseUrl: provider.baseUrl }))
}

/**
 * The Codex item state to carry over when a block is rebuilt from its standard
 * fields, as normalizeMessagesForAPI rebuilds every tool_use: the call's
 * backend id on a session that replays it, nothing anywhere else.
 */
export function codexStateToKeep(block: unknown): { codex?: unknown } {
  const codex = (block as { codex?: unknown } | null)?.codex
  return codex !== undefined && activeSessionReplaysCodexItems() ? { codex } : {}
}

/** The body fields the Codex CLI adds; `reasoning.context` joins an effort only. */
export function codexBackendBodyFields(
  reasoning: ResolvedProviderRequest['reasoning'],
): Record<string, unknown> {
  return {
    include: ['reasoning.encrypted_content'],
    ...(reasoning && { reasoning: { ...reasoning, context: 'all_turns' } }),
    text: { verbosity: 'low' },
  }
}

/**
 * The backend refused a replayed reasoning item: its payload no longer
 * decrypts, as after a switch to another ChatGPT account. The thinking-strip
 * retry drops every reasoning item and sends the request again.
 */
export function isCodexReplayRejected(error: unknown): boolean {
  return (
    isSdkApiError(error) &&
    error.status === 400 &&
    typeof error.message === 'string' &&
    error.message.includes(CODEX_REPLAY_REFUSED_CODE)
  )
}
