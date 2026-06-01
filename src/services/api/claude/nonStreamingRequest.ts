import type {
  BetaMessage,
  BetaMessageStreamParams,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { APIUserAbortError } from '@anthropic-ai/sdk/error'
import type { QuerySource } from 'src/constants/querySource.js'
import type { SystemAPIErrorMessage } from 'src/types/message.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'
import { isFastModeEnabled } from 'src/utils/fastMode.js'
import { normalizeModelStringForAPI } from 'src/utils/model/model.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../analytics/index.js'
import { getAnthropicClient } from '../client.js'
import { getCachedAnthropicClient } from '../clientCache.js'
import { type RetryContext, withRetry } from '../withRetry.js'
import {
  MAX_NON_STREAMING_TOKENS,
  adjustParamsForNonStreaming,
} from './paramBuilders.js'
import type { Options } from './types.js'

/**
 * Per-attempt timeout for non-streaming fallback requests, in milliseconds.
 * Reads API_TIMEOUT_MS when set so slow backends and the streaming path
 * share the same ceiling.
 *
 * Remote sessions default to 120s to stay under CCR's container idle-kill
 * (~5min) so a hung fallback to a wedged backend surfaces a clean
 * APIConnectionTimeoutError instead of stalling past SIGKILL.
 *
 * Otherwise defaults to 300s — long enough for slow backends without
 * approaching the API's 10-minute non-streaming boundary.
 */
function getNonstreamingFallbackTimeoutMs(): number {
  const override = parseInt(process.env.API_TIMEOUT_MS || '', 10)
  if (override) return override
  return isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ? 120_000 : 300_000
}

/**
 * Helper generator for non-streaming API requests.
 * Encapsulates the common pattern of creating a withRetry generator,
 * iterating to yield system messages, and returning the final BetaMessage.
 */
export async function* executeNonStreamingRequest(
  clientOptions: {
    model: string
    fetchOverride?: Options['fetchOverride']
    source: string
  },
  retryOptions: {
    model: string
    fallbackModel?: string
    thinkingConfig: ThinkingConfig
    fastMode?: boolean
    signal: AbortSignal
    initialConsecutive529Errors?: number
    querySource?: QuerySource
  },
  paramsFromContext: (context: RetryContext) => BetaMessageStreamParams,
  onAttempt: (attempt: number, start: number, maxOutputTokens: number) => void,
  captureRequest: (params: BetaMessageStreamParams) => void,
  /**
   * Request ID of the failed streaming attempt this fallback is recovering
   * from. Emitted in tengu_nonstreaming_fallback_error for funnel correlation.
   */
  originatingRequestId?: string | null,
): AsyncGenerator<SystemAPIErrorMessage, BetaMessage> {
  const fallbackTimeoutMs = getNonstreamingFallbackTimeoutMs()
  const generator = withRetry(
    () =>
      getCachedAnthropicClient(getAnthropicClient, {
        maxRetries: 0,
        model: clientOptions.model,
        fetchOverride: clientOptions.fetchOverride,
        source: clientOptions.source,
      }),
    async (anthropic, attempt, context) => {
      const start = Date.now()
      const retryParams = paramsFromContext(context)
      captureRequest(retryParams)
      onAttempt(attempt, start, retryParams.max_tokens)

      const adjustedParams = adjustParamsForNonStreaming(
        retryParams,
        MAX_NON_STREAMING_TOKENS,
      )

      try {
        return await anthropic.beta.messages.create(
          {
            ...adjustedParams,
            model: normalizeModelStringForAPI(adjustedParams.model),
          },
          {
            signal: retryOptions.signal,
            timeout: fallbackTimeoutMs,
          },
        )
      } catch (err) {
        // User aborts are not errors — re-throw immediately without logging
        if (err instanceof APIUserAbortError) throw err

        // Instrumentation: record when the non-streaming request errors (including
        // timeouts). Lets us distinguish "fallback hung past container kill"
        // (no event) from "fallback hit the bounded timeout" (this event).
        logForDiagnosticsNoPII('error', 'cli_nonstreaming_fallback_error')
        logEvent('tengu_nonstreaming_fallback_error', {
          model:
            clientOptions.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error:
            err instanceof Error
              ? (err.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : ('unknown' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          attempt,
          timeout_ms: fallbackTimeoutMs,
          request_id: (originatingRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw err
      }
    },
    {
      model: retryOptions.model,
      fallbackModel: retryOptions.fallbackModel,
      thinkingConfig: retryOptions.thinkingConfig,
      ...(isFastModeEnabled() && { fastMode: retryOptions.fastMode }),
      signal: retryOptions.signal,
      initialConsecutive529Errors: retryOptions.initialConsecutive529Errors,
      querySource: retryOptions.querySource,
    },
  )

  let e: Awaited<ReturnType<typeof generator.next>>
  do {
    e = await generator.next()
    if (!e.done && e.value.type === 'system') {
      yield e.value
    }
  } while (!e.done)

  return e.value as BetaMessage
}
