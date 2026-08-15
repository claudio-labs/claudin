import { feature } from 'bun:bundle'
import type Anthropic from '@anthropic-ai/sdk'
import { type APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import type { QuerySource } from 'src/agent/prompts/querySource.js'
import type { SystemAPIErrorMessage } from 'src/shared/types/message.js'
import { isAwsCredentialsProviderError } from 'src/providers/oauth/aws.js'
import { logForDebugging } from 'src/shared/debug.js'
import { logError } from 'src/shared/log.js'
import { createSystemAPIErrorMessage } from 'src/agent/messages/messages.js'
import { getAPIProvider, getAPIProviderForStatsig } from 'src/utils/model/providers.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
  isClaudeAISubscriber,
  isEnterpriseSubscriber,
} from 'src/providers/auth/auth.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import { invalidateClientCache } from 'src/providers/transport/clientCache.js'
import { refreshGithubModelsTokenIfNeeded } from 'src/providers/oauth/githubModelsCredentials.js'
import { refreshCodexAccessTokenIfNeeded } from 'src/providers/oauth/codexCredentials.js'
import { forceRefreshOAuthWebTokenOn401 } from 'src/providers/shims/openaiShim/oauthProviderAuth.js'
import {
  errorMessage,
  isSdkApiConnectionError,
  isSdkApiError,
} from 'src/shared/errors.js'
import {
  type CooldownReason,
  handleFastModeOverageRejection,
  handleFastModeRejectedByAPI,
  isFastModeCooldown,
  isFastModeEnabled,
  triggerFastModeCooldown,
} from 'src/providers/fastMode.js'
import { extractOpenAICategoryMarker } from 'src/providers/shims/openaiErrorClassification.js'
import { isNonCustomOpusModel } from 'src/utils/model/model.js'
import { disableKeepAlive } from 'src/providers/transport/proxy.js'
import { sleep } from 'src/shared/sleep.js'
import type { ThinkingConfig } from 'src/agent/context/thinking.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/platform/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/platform/analytics/index.js'
import { isMockRateLimitError } from 'src/providers/rateLimitMocking.js'
import { REPEATED_529_ERROR_MESSAGE } from 'src/providers/transport/errors.js'
import { extractConnectionErrorDetails } from 'src/providers/transport/errorUtils.js'

const abortError = () => new APIUserAbortError()

const DEFAULT_MAX_RETRIES = 10
const FLOOR_OUTPUT_TOKENS = 3000
const MAX_529_RETRIES = 3
export const BASE_DELAY_MS = 500
// OpenAI-compat providers can return transient 404s (model loading, routing blip).
// Retry these a limited number of times before treating as permanent.
const MAX_OPENAI_COMPAT_404_RETRIES = 2

// Numeric seconds/ms value used by Retry-After headers. Module-level so we
// don't recompile on every retry parse.
const NUMERIC_RETRY_AFTER_RE = /^\d+(?:\.\d+)?$/

// Foreground query sources where the user IS blocking on the result — these
// retry on 529. Everything else (summaries, titles, suggestions, classifiers)
// bails immediately: during a capacity cascade each retry is 3-10× gateway
// amplification, and the user never sees those fail anyway. New sources
// default to no-retry — add here only if the user is waiting on the result.
const FOREGROUND_529_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread',
  'repl_main_thread:outputStyle:custom',
  'repl_main_thread:outputStyle:Explanatory',
  'repl_main_thread:outputStyle:Learning',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'hook_agent',
  'hook_prompt',
  'side_question',
  // Security classifiers — must complete for auto-mode correctness.
  // yoloClassifier.ts uses 'auto_mode' (not 'yolo_classifier' — that's
  // type-only). bash_classifier is internal-only; feature-gate so the string
  // tree-shakes out of external builds (excluded-strings.txt).
  'auto_mode',
  ...(feature('BASH_CLASSIFIER') ? (['bash_classifier'] as const) : []),
])

function shouldRetry529(querySource: QuerySource | undefined): boolean {
  // undefined → retry (conservative for untagged call paths)
  return (
    querySource === undefined || FOREGROUND_529_RETRY_SOURCES.has(querySource)
  )
}

// CLAUDE_CODE_UNATTENDED_RETRY: for unattended sessions (internal-only). Retries 429/529
// indefinitely with higher backoff and periodic keep-alive yields so the host
// environment does not mark the session idle mid-wait.
// TODO(ANT-344): the keep-alive via SystemAPIErrorMessage yields is a stopgap
// until there's a dedicated keep-alive channel.
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 30_000

function isPersistentRetryEnabled(): boolean {
  return feature('UNATTENDED_RETRY')
    ? isEnvTruthy(process.env.CLAUDE_CODE_UNATTENDED_RETRY)
    : false
}

function isQuotaExhausted(error: any): boolean {
  const msg = (error?.message || '').toLowerCase()

  return (
    error?.status === 429 &&
    (msg.includes('limit: 0') || msg.includes('exceeded your current quota'))
  )
}

function isTransientCapacityError(error: unknown): boolean {
  return (
    is529Error(error) || (isSdkApiError(error) && error.status === 429)
  )
}

function isStaleConnectionError(error: unknown): boolean {
  if (!isSdkApiConnectionError(error)) {
    return false
  }
  const details = extractConnectionErrorDetails(error)
  return details?.code === 'ECONNRESET' || details?.code === 'EPIPE'
}

export interface RetryContext {
  maxTokensOverride?: number
  model: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
  /**
   * Set when the API rejects a request because the latest assistant message's
   * thinking blocks were "modified" — this happens when the user changes the
   * thinking config (e.g. adaptive ↔ budget via /effort) mid-session. The
   * streaming layer reads this flag and strips all thinking blocks from history
   * before retrying. One-shot: once set, we don't try a second strip.
   */
  stripThinkingFromHistory?: boolean
}

export function isThinkingBlockMismatchError(error: unknown): boolean {
  if (!isSdkApiError(error) || error.status !== 400 || !error.message) {
    return false
  }
  // Two shapes of the same recoverable problem — a prior assistant thinking
  // block is incompatible with the current request:
  //   1. "cannot be modified" — thinking config changed mid-session
  //      (adaptive ↔ budget via /effort).
  //   2. "Invalid `signature` in `thinking` block" — the history carries a
  //      thinking block signed by a DIFFERENT provider (e.g. switching from
  //      Moonshot/Kimi back to Anthropic); Anthropic can't validate a foreign
  //      signature. Both recover by stripping thinking from history and retrying.
  if (!error.message.includes('thinking')) {
    return false
  }
  return (
    error.message.includes('cannot be modified') ||
    error.message.includes('signature')
  )
}

interface RetryOptions {
  maxRetries?: number
  model: string
  fallbackModel?: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
  signal?: AbortSignal
  querySource?: QuerySource
  /**
   * Pre-seed the consecutive 529 counter. Used when this retry loop is a
   * non-streaming fallback after a streaming 529 — the streaming 529 should
   * count toward MAX_529_RETRIES so total 529s-before-fallback is consistent
   * regardless of which request mode hit the overload.
   */
  initialConsecutive529Errors?: number
}

export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly retryContext: RetryContext,
  ) {
    const message = errorMessage(originalError)
    super(message)
    this.name = 'RetryError'

    // Preserve the original stack trace if available
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`Model fallback triggered: ${originalModel} -> ${fallbackModel}`)
    this.name = 'FallbackTriggeredError'
  }
}

// Thrown internally when a 401 force-refresh for an OAuth-web provider
// (xAI / Kimi Code) comes back failed — the stored refresh token is dead, so
// retrying would just resend the same invalid access token. Caught in the
// loop's catch block below and converted straight to a CannotRetryError,
// skipping shouldRetry()'s blanket "401 is always retryable" path.
class OAuthWebSessionExpiredError extends Error {
  constructor(public readonly providerBaseUrl: string | undefined) {
    super(
      'OAuth session expired and the automatic token refresh failed. Run /provider to reauthenticate.',
    )
    this.name = 'OAuthWebSessionExpiredError'
  }
}

export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (
    client: Anthropic,
    attempt: number,
    context: RetryContext,
  ) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = getMaxRetries(options)
  // Resolve provider/transport once — they don't change during a retry loop.
  const transport = tryGetActiveProvider()?.transport
  const retryContext: RetryContext = {
    model: options.model,
    thinkingConfig: options.thinkingConfig,
    ...(isFastModeEnabled() && { fastMode: options.fastMode }),
  }
  let client: Anthropic | null = null
  let consecutive529Errors = options.initialConsecutive529Errors ?? 0
  let lastError: unknown
  let persistentAttempt = 0
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new APIUserAbortError()
    }

    // Capture whether fast mode is active before this attempt
    // (fallback may change the state mid-loop)
    const wasFastModeActive = isFastModeEnabled()
      ? retryContext.fastMode && !isFastModeCooldown()
      : false

    try {

      // Get a fresh client instance on first attempt or after authentication errors
      // - 401 for first-party API authentication failures
      // - 403 "OAuth token has been revoked" (another process refreshed the token)
      // - Bedrock-specific auth errors (403 or CredentialsProviderError)
      // - Vertex-specific auth errors (credential refresh failures, 401)
      // - ECONNRESET/EPIPE: stale keep-alive socket; disable pooling and reconnect
      const isStaleConnection = isStaleConnectionError(lastError)
      if (
        isStaleConnection &&
        getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_disable_keepalive_on_econnreset',
          false,
        )
      ) {
        logForDebugging(
          'Stale connection (ECONNRESET/EPIPE) — disabling keep-alive for retry',
        )
        disableKeepAlive(getAPIProvider())
      }

      if (
        client === null ||
        (isSdkApiError(lastError) && lastError.status === 401) ||
        isOAuthTokenRevokedError(lastError) ||
        isBedrockAuthError(lastError, transport) ||
        isVertexAuthError(lastError, transport) ||
        isStaleConnection
      ) {
        // On 401 "token expired" or 403 "token revoked", force a token refresh
        if (
          (isSdkApiError(lastError) && lastError.status === 401) ||
          isOAuthTokenRevokedError(lastError)
        ) {
          const failedAccessToken = getClaudeAIOAuthTokens()?.accessToken
          if (failedAccessToken) {
            await handleOAuth401Error(failedAccessToken)
          }
          // For GitHub Copilot, refresh the short-lived Copilot token using the
          // stored OAuth token so the next getClient() picks up the fresh token.
          if (transport === 'github_copilot') {
            await refreshGithubModelsTokenIfNeeded()
          }
          // For Codex OAuth, force-refresh on 401 even if the JWT clock says the
          // token is still valid — server-side revocation won't match the clock.
          if (transport === 'codex_responses') {
            await refreshCodexAccessTokenIfNeeded({ force: true }).catch(e => {
              logForDebugging(
                `[codex] force-refresh on 401 failed: ${e instanceof Error ? e.message : String(e)}`,
                { level: 'warn' },
              )
            })
          }
          // xAI / Grok and Kimi Code OAuth both use the openai_compat transport;
          // dispatch by the active profile's baseUrl via the OAuth-web registry.
          if (transport === 'openai_compat') {
            const oauthWebBaseUrl = tryGetActiveProvider()?.baseUrl
            const refreshResult =
              await forceRefreshOAuthWebTokenOn401(oauthWebBaseUrl)
            if (refreshResult === 'failed') {
              throw new OAuthWebSessionExpiredError(oauthWebBaseUrl)
            }
          }
        }
        // Invalidate the client cache before getClient() so it creates a fresh
        // client with the refreshed credentials, not a stale cached one.
        invalidateClientCache()
        client = await getClient()
      }

      return await operation(client, attempt, retryContext)
    } catch (error) {
      lastError = error
      logForDebugging(
        `API error (attempt ${attempt}/${maxRetries + 1}): ${isSdkApiError(error) ? `${error.status} ${error.message}` : errorMessage(error)}`,
        { level: 'error' },
      )
        if (error instanceof OAuthWebSessionExpiredError) {
          throw new CannotRetryError(error, retryContext)
        }
        if (isQuotaExhausted(error)) {
          throw new CannotRetryError(
            new Error(
              'API quota exhausted or not enabled.\n' +
              'Fix:\n' +
              '- Enable billing for your provider\n' +
              '- Or switch provider via /provider',
            ),
            retryContext,
          );
      }
      // Fast mode fallback: on 429/529, either wait and retry (short delays)
      // or fall back to standard speed (long delays) to avoid cache thrashing.
      // Skip in persistent mode: the short-retry path below loops with fast
      // mode still active, so its `continue` never reaches the attempt clamp
      // and the for-loop terminates. Persistent sessions want the chunked
      // keep-alive path instead of fast-mode cache-preservation anyway.
      if (
        wasFastModeActive &&
        !isPersistentRetryEnabled() &&
        isSdkApiError(error) &&
        (error.status === 429 || is529Error(error))
      ) {
        // If the 429 is specifically because extra usage (overage) is not
        // available, permanently disable fast mode with a specific message.
        const overageReason = error.headers?.get(
          'anthropic-ratelimit-unified-overage-disabled-reason',
        )
        if (overageReason !== null && overageReason !== undefined) {
          handleFastModeOverageRejection(overageReason)
          retryContext.fastMode = false
          continue
        }

        const retryAfterMs = getRetryAfterMs(error)
        if (retryAfterMs !== null && retryAfterMs < SHORT_RETRY_THRESHOLD_MS) {
          // Short retry-after: wait and retry with fast mode still active
          // to preserve prompt cache (same model name on retry).
          await sleep(retryAfterMs, options.signal, { abortError })
          continue
        }
        // Long or unknown retry-after: enter cooldown (switches to standard
        // speed model), with a minimum floor to avoid flip-flopping.
        const cooldownMs = Math.max(
          retryAfterMs ?? DEFAULT_FAST_MODE_FALLBACK_HOLD_MS,
          MIN_COOLDOWN_MS,
        )
        const cooldownReason: CooldownReason = is529Error(error)
          ? 'overloaded'
          : 'rate_limit'
        triggerFastModeCooldown(Date.now() + cooldownMs, cooldownReason)
        if (isFastModeEnabled()) {
          retryContext.fastMode = false
        }
        continue
      }

      // Fast mode fallback: if the API rejects the fast mode parameter
      // (e.g., org doesn't have fast mode enabled), permanently disable fast
      // mode and retry at standard speed.
      if (wasFastModeActive && isFastModeNotEnabledError(error)) {
        handleFastModeRejectedByAPI()
        retryContext.fastMode = false
        continue
      }

      // Non-foreground sources bail immediately on 529 — no retry amplification
      // during capacity cascades. User never sees these fail.
      if (is529Error(error) && !shouldRetry529(options.querySource)) {
        logEvent('tengu_api_529_background_dropped', {
          query_source:
            options.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw new CannotRetryError(error, retryContext)
      }

      // Track consecutive 529 errors
      if (
        is529Error(error) &&
        // If FALLBACK_FOR_ALL_PRIMARY_MODELS is not set, fall through only if the primary model is a non-custom Opus model.
        // TODO: Revisit if the isNonCustomOpusModel check should still exist, or if isNonCustomOpusModel is a stale artifact of when Claude Code was hardcoded on Opus.
        (process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS ||
          (!isClaudeAISubscriber() && isNonCustomOpusModel(options.model)))
      ) {
        consecutive529Errors++
        if (consecutive529Errors >= MAX_529_RETRIES) {
          // Check if fallback model is specified
          if (options.fallbackModel) {
            logEvent('tengu_api_opus_fallback_triggered', {
              original_model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                options.fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              provider: getAPIProviderForStatsig(),
            })

            // Throw special error to indicate fallback was triggered
            throw new FallbackTriggeredError(
              options.model,
              options.fallbackModel,
            )
          }

          if (!process.env.IS_SANDBOX && !isPersistentRetryEnabled()) {
            logEvent('tengu_api_custom_529_overloaded_error', {})
            throw new CannotRetryError(
              new Error(REPEATED_529_ERROR_MESSAGE),
              retryContext,
            )
          }
        }
      }

      // Only retry if the error indicates we should
      const persistent =
        isPersistentRetryEnabled() && isTransientCapacityError(error)
      if (attempt > maxRetries && !persistent) {
        throw new CannotRetryError(error, retryContext)
      }

      // AWS/GCP errors aren't always APIError, but can be retried
      const handledCloudAuthError =
        handleAwsCredentialError(error) || handleGcpCredentialError(error)
      if (
        !handledCloudAuthError &&
        (!isSdkApiError(error) || !shouldRetry(error, attempt))
      ) {
        throw new CannotRetryError(error, retryContext)
      }

      // Handle thinking-block mismatch (400) by stripping thinking from history
      // and retrying once. Happens when thinking config changes mid-session
      // (adaptive ↔ budget via /effort) — the prior assistant message's
      // thinking blocks become incompatible with the new request shape.
      if (
        isThinkingBlockMismatchError(error) &&
        !retryContext.stripThinkingFromHistory
      ) {
        retryContext.stripThinkingFromHistory = true
        logEvent('tengu_api_thinking_mismatch_recovery', {})
        continue
      }

      // Handle max tokens context overflow errors by adjusting max_tokens for the next attempt
      // NOTE: With extended-context-window beta, this 400 error should not occur.
      // The API now returns 'model_context_window_exceeded' stop_reason instead.
      // Keeping for backward compatibility.
      if (isSdkApiError(error)) {
        const overflowData = parseMaxTokensContextOverflowError(error)
        if (overflowData) {
          const { inputTokens, contextLimit } = overflowData

          const safetyBuffer = 1000
          const availableContext = Math.max(
            0,
            contextLimit - inputTokens - safetyBuffer,
          )
          if (availableContext < FLOOR_OUTPUT_TOKENS) {
            logError(
              new Error(
                `availableContext ${availableContext} is less than FLOOR_OUTPUT_TOKENS ${FLOOR_OUTPUT_TOKENS}`,
              ),
            )
            throw error
          }
          // Ensure we have enough tokens for thinking + at least 1 output token
          const minRequired =
            (retryContext.thinkingConfig.type === 'enabled'
              ? retryContext.thinkingConfig.budgetTokens
              : 0) + 1
          const adjustedMaxTokens = Math.max(
            FLOOR_OUTPUT_TOKENS,
            availableContext,
            minRequired,
          )
          retryContext.maxTokensOverride = adjustedMaxTokens

          logEvent('tengu_max_tokens_context_overflow_adjustment', {
            inputTokens,
            contextLimit,
            adjustedMaxTokens,
            attempt,
          })

          continue
        }
      }

      // For other errors, proceed with normal retry logic
      // Get retry-after hint (ms) if available
      const retryAfterMs = getRetryAfterMs(error)
      let delayMs: number
      if (persistent && isSdkApiError(error) && error.status === 429) {
        persistentAttempt++
        // Window-based limits (e.g. 5hr Max/Pro) include a reset timestamp.
        // Wait until reset rather than polling every 5 min uselessly.
        const resetDelay = getRateLimitResetDelayMs(error)
        delayMs =
          resetDelay ??
          Math.min(
            getRetryDelay(
              persistentAttempt,
              retryAfterMs,
              PERSISTENT_MAX_BACKOFF_MS,
            ),
            PERSISTENT_RESET_CAP_MS,
          )
      } else if (persistent) {
        persistentAttempt++
        // Retry-After is a server directive and bypasses maxDelayMs inside
        // getRetryDelay (intentional — honoring it is correct). Cap at the
        // 6hr reset-cap here so a pathological header can't wait unbounded.
        delayMs = Math.min(
          getRetryDelay(
            persistentAttempt,
            retryAfterMs,
            PERSISTENT_MAX_BACKOFF_MS,
          ),
          PERSISTENT_RESET_CAP_MS,
        )
      } else {
        delayMs = getRetryDelay(attempt, retryAfterMs)
      }

      // In persistent mode the for-loop `attempt` is clamped at maxRetries+1;
      // use persistentAttempt for telemetry/yields so they show the true count.
      const reportedAttempt = persistent ? persistentAttempt : attempt
      logEvent('tengu_api_retry', {
        attempt: reportedAttempt,
        delayMs: delayMs,
        error: (error as APIError)
          .message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        status: (error as APIError).status,
        provider: getAPIProviderForStatsig(),
      })

      if (persistent) {
        if (delayMs > 60_000) {
          logEvent('tengu_api_persistent_retry_wait', {
            status: (error as APIError).status,
            delayMs,
            attempt: reportedAttempt,
            provider: getAPIProviderForStatsig(),
          })
        }
        // Chunk long sleeps so the host sees periodic stdout activity and
        // does not mark the session idle. Each yield surfaces as
        // {type:'system', subtype:'api_retry'} on stdout via QueryEngine.
        let remaining = delayMs
        while (remaining > 0) {
          if (options.signal?.aborted) throw new APIUserAbortError()
          if (isSdkApiError(error)) {
            yield createSystemAPIErrorMessage(
              error,
              remaining,
              reportedAttempt,
              maxRetries,
            )
          }
          const chunk = Math.min(remaining, HEARTBEAT_INTERVAL_MS)
          await sleep(chunk, options.signal, { abortError })
          remaining -= chunk
        }
        // Clamp so the for-loop never terminates. Backoff uses the separate
        // persistentAttempt counter which keeps growing to the 5-min cap.
        if (attempt >= maxRetries) attempt = maxRetries
      } else {
        if (isSdkApiError(error)) {
          yield createSystemAPIErrorMessage(error, delayMs, attempt, maxRetries)
        }
        await sleep(delayMs, options.signal, { abortError })
      }
    }
  }

  throw new CannotRetryError(lastError, retryContext)
}

function readHeader(error: unknown, name: string): string | null {
  const headers = (error as { headers?: unknown }).headers
  if (!headers) return null
  // Headers can be either a plain object (some SDK error shapes) or a Fetch
  // Headers instance. Try both forms — same strategy as the legacy reader.
  const plain = (headers as Record<string, string | undefined>)[name]
  if (typeof plain === 'string' && plain !== '') return plain
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const got = (headers as Headers).get?.(name)
  return typeof got === 'string' && got !== '' ? got : null
}

/**
 * Parse a Retry-After header value into milliseconds.
 *
 * Accepts:
 *   - integer seconds: "5" → 5000
 *   - decimal seconds: "0.5" → 500
 *   - HTTP-date (RFC 7231): "Wed, 21 Oct 2099 07:28:00 GMT" → ms until that
 *     instant (clamped at 0 for past dates)
 *
 * Returns null for empty/invalid input. Result is capped at
 * PERSISTENT_RESET_CAP_MS so a pathological server header can't pin us
 * waiting for hours.
 */
export function parseRetryAfterValue(
  value: string | null | undefined,
): number | null {
  if (value == null) return null
  const trimmed = value.trim()
  if (trimmed === '') return null

  // Numeric path covers both integer and decimal seconds. parseFloat tolerates
  // leading whitespace already trimmed; reject if any non-numeric tail.
  if (NUMERIC_RETRY_AFTER_RE.test(trimmed)) {
    const seconds = Number(trimmed)
    if (!Number.isFinite(seconds) || seconds < 0) return null
    return Math.min(Math.round(seconds * 1000), PERSISTENT_RESET_CAP_MS)
  }

  // HTTP-date fallback. Date.parse returns NaN for unrecognized formats.
  const target = Date.parse(trimmed)
  if (!Number.isFinite(target)) return null
  const delta = target - Date.now()
  if (delta <= 0) return 0
  return Math.min(delta, PERSISTENT_RESET_CAP_MS)
}

/**
 * Parse the millisecond-precision `retry-after-ms` extension. Value is
 * already in ms — no second→ms conversion. Returns null for invalid input.
 */
function parseRetryAfterMsValue(
  value: string | null | undefined,
): number | null {
  if (value == null) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (!NUMERIC_RETRY_AFTER_RE.test(trimmed)) return null
  const ms = Number(trimmed)
  if (!Number.isFinite(ms) || ms < 0) return null
  return Math.min(Math.round(ms), PERSISTENT_RESET_CAP_MS)
}

/**
 * Read Retry-After hint from the error and return milliseconds.
 *
 * Prefers `retry-after-ms` (millisecond-precision extension used by
 * Anthropic and OpenAI) over `retry-after` (RFC 7231) when both are
 * present — the ms variant is more precise.
 */
export function getRetryAfterMs(error: unknown): number | null {
  const ms = parseRetryAfterMsValue(readHeader(error, 'retry-after-ms'))
  if (ms !== null) return ms
  return parseRetryAfterValue(readHeader(error, 'retry-after'))
}

export function getRetryDelay(
  attempt: number,
  retryAfterMs?: number | null,
  maxDelayMs = 32000,
): number {
  if (retryAfterMs != null && retryAfterMs >= 0) {
    return retryAfterMs
  }

  const baseDelay = Math.min(
    BASE_DELAY_MS * Math.pow(2, attempt - 1),
    maxDelayMs,
  )
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}

export function parseMaxTokensContextOverflowError(error: APIError):
  | {
      inputTokens: number
      maxTokens: number
      contextLimit: number
    }
  | undefined {
  if (error.status !== 400 || !error.message) {
    return undefined
  }

  if (
    !error.message.includes(
      'input length and `max_tokens` exceed context limit',
    )
  ) {
    return undefined
  }

  // Example format: "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000"
  const regex =
    /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/
  const match = error.message.match(regex)

  if (!match || match.length !== 4) {
    return undefined
  }

  if (!match[1] || !match[2] || !match[3]) {
    logError(
      new Error(
        'Unable to parse max_tokens from max_tokens exceed context limit error message',
      ),
    )
    return undefined
  }
  const inputTokens = parseInt(match[1], 10)
  const maxTokens = parseInt(match[2], 10)
  const contextLimit = parseInt(match[3], 10)

  if (isNaN(inputTokens) || isNaN(maxTokens) || isNaN(contextLimit)) {
    return undefined
  }

  return { inputTokens, maxTokens, contextLimit }
}

// TODO: Replace with a response header check once the API adds a dedicated
// header for fast-mode rejection (e.g., x-fast-mode-rejected). String-matching
// the error message is fragile and will break if the API wording changes.
function isFastModeNotEnabledError(error: unknown): boolean {
  if (!isSdkApiError(error)) {
    return false
  }
  return (
    error.status === 400 &&
    (error.message?.includes('Fast mode is not enabled') ?? false)
  )
}

export function is529Error(error: unknown): boolean {
  if (!isSdkApiError(error)) {
    return false
  }

  // Check for 529 status code or overloaded error in message
  return (
    error.status === 529 ||
    // See below: the SDK sometimes fails to properly pass the 529 status code during streaming
    (error.message?.includes('"type":"overloaded_error"') ?? false)
  )
}

function isOAuthTokenRevokedError(error: unknown): boolean {
  return (
    isSdkApiError(error) &&
    error.status === 403 &&
    (error.message?.includes('OAuth token has been revoked') ?? false)
  )
}

function isBedrockAuthError(error: unknown, transport?: string): boolean {
  if ((transport ?? tryGetActiveProvider()?.transport) === 'bedrock') {
    // AWS libs reject without an API call if .aws holds a past Expiration value
    // otherwise, API calls that receive expired tokens give generic 403
    // "The security token included in the request is invalid"
    if (
      isAwsCredentialsProviderError(error) ||
      (isSdkApiError(error) && error.status === 403)
    ) {
      return true
    }
  }
  return false
}

/**
 * Clear AWS auth caches if appropriate.
 * @returns true if action was taken.
 */
function handleAwsCredentialError(error: unknown): boolean {
  if (isBedrockAuthError(error)) {
    clearAwsCredentialsCache()
    return true
  }
  return false
}

// google-auth-library throws plain Error (no typed name like AWS's
// CredentialsProviderError). Match common SDK-level credential-failure messages.
function isGoogleAuthLibraryCredentialError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message
  return (
    msg.includes('Could not load the default credentials') ||
    msg.includes('Could not refresh access token') ||
    msg.includes('invalid_grant')
  )
}

function isVertexAuthError(error: unknown, transport?: string): boolean {
  if ((transport ?? tryGetActiveProvider()?.transport) === 'vertex') {
    // SDK-level: google-auth-library fails in prepareOptions() before the HTTP call
    if (isGoogleAuthLibraryCredentialError(error)) {
      return true
    }
    // Server-side: Vertex returns 401 for expired/invalid tokens
    if (isSdkApiError(error) && error.status === 401) {
      return true
    }
  }
  return false
}

/**
 * Clear GCP auth caches if appropriate.
 * @returns true if action was taken.
 */
function handleGcpCredentialError(error: unknown): boolean {
  if (isVertexAuthError(error)) {
    clearGcpCredentialsCache()
    return true
  }
  return false
}

export function shouldRetry(error: APIError, attempt = 1): boolean {
  // Never retry mock errors - they're from /mock-limits command for testing
  if (isMockRateLimitError(error)) {
    return false
  }

  // Persistent mode: 429/529 always retryable, bypass subscriber gates and
  // x-should-retry header.
  if (isPersistentRetryEnabled() && isTransientCapacityError(error)) {
    return true
  }

  // CCR mode: auth is via infrastructure-provided JWTs, so a 401/403 is a
  // transient blip (auth service flap, network hiccup) rather than bad
  // credentials. Bypass x-should-retry:false — the server assumes we'd retry
  // the same bad key, but our key is fine.
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
    (error.status === 401 || error.status === 403)
  ) {
    return true
  }

  // Check for overloaded errors first by examining the message content
  // The SDK sometimes fails to properly pass the 529 status code during streaming,
  // so we need to check the error message directly
  if (error.message?.includes('"type":"overloaded_error"')) {
    return true
  }

  // Check for max tokens context overflow errors that we can handle
  if (parseMaxTokensContextOverflowError(error)) {
    return true
  }

  // Thinking-block mismatch: we recover by stripping thinking from history.
  if (isThinkingBlockMismatchError(error)) {
    return true
  }

  // Note this is not a standard header.
  const shouldRetryHeader = error.headers?.get('x-should-retry')

  // If the server explicitly says whether or not to retry, obey.
  // For Max and Pro users, should-retry is true, but in several hours, so we shouldn't.
  // Enterprise users can retry because they typically use PAYG instead of rate limits.
  if (
    shouldRetryHeader === 'true' &&
    (!isClaudeAISubscriber() || isEnterpriseSubscriber())
  ) {
    return true
  }

  if (shouldRetryHeader === 'false') {
    return false
  }

  if (isSdkApiConnectionError(error)) {
    return true
  }

  if (!error.status) return false

  // Retry on request timeouts.
  if (error.status === 408) return true

  // Retry on lock timeouts.
  if (error.status === 409) return true

  // Retry on rate limits, but not for ClaudeAI Subscription users
  // Enterprise users can retry because they typically use PAYG instead of rate limits
  if (error.status === 429) {
    if (isQuotaExhausted(error)) return false
    return !isClaudeAISubscriber() || isEnterpriseSubscriber()
  }

  // Clear API key cache on 401 and allow retry.
  // OAuth token handling is done in the main retry loop via handleOAuth401Error.
  if (error.status === 401) {
    clearApiKeyHelperCache()
    return true
  }

  // Retry on 403 "token revoked" (same refresh logic as 401, see above)
  if (isOAuthTokenRevokedError(error)) {
    return true
  }

  // Retry internal errors.
  if (error.status && error.status >= 500) return true

  // OpenAI-compat providers sometimes return transient 404s (model loading,
  // routing blip). Detect via the [openai_category=...] marker embedded by
  // openaiShim.ts and retry a limited number of times before surfacing the error.
  // Exclude model_not_found: the model genuinely doesn't exist, retrying won't help.
  if (error.status === 404) {
    const category = extractOpenAICategoryMarker(error.message ?? '')
    if (category && category !== 'model_not_found' && attempt <= MAX_OPENAI_COMPAT_404_RETRIES) {
      return true
    }
  }

  return false
}

export function getDefaultMaxRetries(): number {
  if (process.env.CLAUDE_CODE_MAX_RETRIES) {
    return parseInt(process.env.CLAUDE_CODE_MAX_RETRIES, 10)
  }
  return DEFAULT_MAX_RETRIES
}
function getMaxRetries(options: RetryOptions): number {
  return options.maxRetries ?? getDefaultMaxRetries()
}

const DEFAULT_FAST_MODE_FALLBACK_HOLD_MS = 30 * 60 * 1000 // 30 minutes
const SHORT_RETRY_THRESHOLD_MS = 20 * 1000 // 20 seconds
const MIN_COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes

/**
 * Parse OpenAI-style relative duration strings into milliseconds.
 * Formats: "1s", "6m0s", "1h30m0s", "500ms", "2m"
 * Returns null for unrecognized formats.
 */
export function parseOpenAIDuration(s: string): number | null {
  if (!s) return null
  // Try matching hours/minutes/seconds/milliseconds components
  const re = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+)s)?(?:(\d+)ms)?$/
  const m = re.exec(s)
  if (!m || m[0] === '') return null
  const h = parseInt(m[1] ?? '0', 10)
  const min = parseInt(m[2] ?? '0', 10)
  const sec = parseInt(m[3] ?? '0', 10)
  const ms = parseInt(m[4] ?? '0', 10)
  const total = h * 3_600_000 + min * 60_000 + sec * 1_000 + ms
  return total > 0 ? total : null
}

export function getRateLimitResetDelayMs(error: APIError): number | null {
  const provider = getAPIProvider()

  if (provider === 'firstParty') {
    const resetHeader = error.headers?.get?.('anthropic-ratelimit-unified-reset')
    if (!resetHeader) return null
    const resetUnixSec = Number(resetHeader)
    if (!Number.isFinite(resetUnixSec)) return null
    const delayMs = resetUnixSec * 1000 - Date.now()
    if (delayMs <= 0) return null
    return Math.min(delayMs, PERSISTENT_RESET_CAP_MS)
  }

  if (provider === 'openai' || provider === 'codex' || provider === 'github') {
    const reqHeader = error.headers?.get?.('x-ratelimit-reset-requests')
    const tokHeader = error.headers?.get?.('x-ratelimit-reset-tokens')
    const reqMs = reqHeader ? parseOpenAIDuration(reqHeader) : null
    const tokMs = tokHeader ? parseOpenAIDuration(tokHeader) : null
    if (reqMs === null && tokMs === null) return null
    // Use the larger delay so we don't retry before both limits reset
    const delayMs = Math.max(reqMs ?? 0, tokMs ?? 0)
    return Math.min(delayMs, PERSISTENT_RESET_CAP_MS)
  }

  // bedrock, vertex, foundry, gemini — no standard reset header
  return null
}
