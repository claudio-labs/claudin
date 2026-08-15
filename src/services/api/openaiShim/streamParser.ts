/**
 * SSE stream translation: OpenAI Chat Completions → Anthropic BetaRawMessageStreamEvent.
 *
 * `openaiStreamToAnthropic` is the async generator that drives the stream:
 *  - emits `message_start` / `content_block_*` / `message_delta` / `message_stop`
 *  - splits reasoning_content (thinking blocks) from content (text blocks)
 *  - reassembles fragmented tool_call.arguments JSON, applies normalization
 *    (`normalizeToolArguments`) and best-effort repair (`repairPossiblyTruncatedObjectJson`)
 *    on finish_reason
 *  - applies an idle timeout (`STREAM_IDLE_TIMEOUT_MS`) so dead connections
 *    surface as a retryable error
 *  - falls back to estimating usage from accumulated character count when the
 *    provider ignores `stream_options.include_usage`
 *
 * `OpenAIShimStream` is the wrapper class the shim returns to claude.ts; it
 * exposes the AsyncIterator surface and an `AbortController` to mark itself
 * as a stream (not an error) to upstream consumers.
 *
 * Helpers: `convertChunkUsage`, `repairPossiblyTruncatedObjectJson` and
 * `JSON_REPAIR_SUFFIXES` live here because they're only used from inside the
 * stream loop and its tool-argument finalization path.
 */

import { logForDebugging } from 'src/shared/debug.js'
import {
  createStreamState,
  processStreamChunk,
  getStreamStats,
} from 'src/utils/streamingOptimizer.js'
import { buildAnthropicUsageFromRawUsage } from 'src/services/api/cacheMetrics.js'
import type {
  AnthropicStreamEvent,
  AnthropicUsage,
} from 'src/services/api/codexShim.js'
import { createThinkTagFilter } from 'src/services/api/thinkTagSanitizer.js'
import {
  hasToolFieldMapping,
  normalizeToolArguments,
} from 'src/services/api/toolArgumentNormalization.js'
import {
  getBytesPerTokenForModel,
} from 'src/services/tokenEstimation.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { makeMessageId } from 'src/services/api/openaiShim/helpers.js'
import { extractReasoningDelta } from 'src/services/api/openaiShim/reasoningNormalizer.js'
import type { OpenAIStreamChunk } from 'src/services/api/openaiShim/types.js'
import {
  findXmlToolCallOpener,
  isHy3Model,
  recoverXmlToolCallsFromText,
  trailingXmlOpenerPrefixLen,
} from 'src/services/api/openaiShim/xmlToolCallParser.js'

export function convertChunkUsage(
  usage: OpenAIStreamChunk['usage'] | undefined,
): Partial<AnthropicUsage> | undefined {
  if (!usage) return undefined
  // Delegates to the shared helper so this path, codexShim.makeUsage,
  // the non-streaming response below, and the integration tests all
  // produce byte-identical output for the same raw input.
  return buildAnthropicUsageFromRawUsage(
    usage as unknown as Record<string, unknown>,
  )
}

const JSON_REPAIR_SUFFIXES = [
  '}', '"}', ']}', '"]}', '}}', '"}}', ']}}', '"]}}', '"]}]}', '}]}'
]

export function repairPossiblyTruncatedObjectJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? raw
      : null
  } catch {
    for (const combo of JSON_REPAIR_SUFFIXES) {
      try {
        const repaired = raw + combo
        const parsed = JSON.parse(repaired)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return repaired
        }
      } catch {}
    }
    return null
  }
}

/**
 * Async generator that transforms an OpenAI SSE stream into
 * Anthropic-format BetaRawMessageStreamEvent objects.
 */
export async function* openaiStreamToAnthropic(
  response: Response,
  model: string,
  signal?: AbortSignal,
  estimatedInputTokens?: number,
  toolNames?: Set<string>,
): AsyncGenerator<AnthropicStreamEvent> {
  const messageId = makeMessageId()
  let contentBlockIndex = 0
  const activeToolCalls = new Map<
    number,
    {
      id: string
      name: string
      index: number
      jsonBuffer: string
      normalizeAtStop: boolean
    }
  >()
  let hasEmittedContentStart = false
  let hasEmittedThinkingStart = false
  let hasClosedThinking = false
  const thinkFilter = createThinkTagFilter()
  let lastStopReason: 'tool_use' | 'max_tokens' | 'end_turn' | null = null
  let hasEmittedFinalUsage = false
  let hasProcessedFinishReason = false
  let estimatedOutputChars = 0
  const streamState = createStreamState()

  // XML-embedded tool-call recovery (GLM/Qwen/Hermes/HY3 emit `<tool_call>…` as
  // text instead of structured tool_calls). Only active when the request
  // advertises tools and the kill-switch is off; otherwise this whole layer is a
  // no-op and content streams unchanged. See xmlToolCallParser.ts.
  const xmlEnabled =
    !!toolNames &&
    toolNames.size > 0 &&
    !isEnvTruthy(process.env.CLAUDIN_DISABLE_XML_TOOL_CALLS)
  const allowHy3 = isHy3Model(model)
  // Everything from a `<tool_call>` opener onward is buffered here (never shown)
  // and converted to tool_use blocks at finalize.
  let xmlToolCallText: string | null = null
  // A trailing partial opener split across SSE deltas, held back until it either
  // completes (→ xmlToolCallText) or is proven not to be an opener (→ emitted).
  let xmlHoldback = ''
  // Set by finalizeXmlBuffer when it recovers ≥1 tool call, so the caller can
  // rewrite the stop reason to tool_use.
  let xmlRecoveredStopReason: 'tool_use' | null = null

  // Emit message_start
  yield {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }

  const maybeReader = response.body?.getReader()
  if (!maybeReader) return
  // Re-bind after the guard: the narrowing does not reach inside the hoisted
  // readWithTimeout declaration below.
  const reader = maybeReader

  const decoder = new TextDecoder()
  let buffer = ''
  const STREAM_IDLE_TIMEOUT_MS = 120_000 // 2 minutes without data = connection likely dead
  let lastDataTime = Date.now()

  /**
   * Read from the stream with an idle timeout. If no data arrives within
   * STREAM_IDLE_TIMEOUT_MS, assume the connection is dead and throw so
   * withRetry can reconnect. This prevents indefinite hangs on stale
   * SSE connections from OpenAI/Gemini during long-running sessions.
   * Respects the caller's AbortSignal — clears the idle timer on abort
   * so the rejection reason is AbortError, not a spurious idle timeout.
   */
  async function readWithTimeout(): Promise<
    Awaited<ReturnType<typeof reader.read>>
  > {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const elapsed = Math.round((Date.now() - lastDataTime) / 1000)
        reject(new Error(
          `OpenAI/Gemini SSE stream idle for ${elapsed}s (limit: ${STREAM_IDLE_TIMEOUT_MS / 1000}s). Connection likely dropped.`,
        ))
      }, STREAM_IDLE_TIMEOUT_MS)

      // If the caller aborts, clear the timer so the AbortError surfaces
      // cleanly instead of being masked by a spurious idle timeout.
      let abortCleanup: (() => void) | undefined
      if (signal) {
        abortCleanup = () => {
          clearTimeout(timeoutId)
        }
        signal.addEventListener('abort', abortCleanup, { once: true })
      }

      reader.read().then(
        result => {
          clearTimeout(timeoutId)
          if (signal && abortCleanup) signal.removeEventListener('abort', abortCleanup)
          if (result.value) lastDataTime = Date.now()
          resolve(result)
        },
        err => {
          clearTimeout(timeoutId)
          if (signal && abortCleanup) signal.removeEventListener('abort', abortCleanup)
          reject(err)
        },
      )
    })
  }

  const closeActiveContentBlock = async function* () {
    if (!hasEmittedContentStart) return

    const tail = thinkFilter.flush()
    if (tail) {
      yield {
        type: 'content_block_delta',
        index: contentBlockIndex,
        delta: { type: 'text_delta', text: tail },
      }
    }

    yield {
      type: 'content_block_stop',
      index: contentBlockIndex,
    }
    contentBlockIndex++
    hasEmittedContentStart = false
  }

  // Emit visible text, lazily closing an open thinking block and opening a text
  // content block on first use. Used by both the content branch and the XML
  // finalize path so a text block is only opened when there is something to show.
  const emitVisibleText = async function* (text: string) {
    if (!text) return
    if (hasEmittedThinkingStart && !hasClosedThinking) {
      yield { type: 'content_block_stop', index: contentBlockIndex }
      contentBlockIndex++
      hasClosedThinking = true
    }
    if (!hasEmittedContentStart) {
      yield {
        type: 'content_block_start',
        index: contentBlockIndex,
        content_block: { type: 'text', text: '' },
      }
      hasEmittedContentStart = true
    }
    estimatedOutputChars += text.length
    yield {
      type: 'content_block_delta',
      index: contentBlockIndex,
      delta: { type: 'text_delta', text },
    }
  }

  // Feed think-filtered visible text through the XML tool-call hold-back. Prose
  // before a `<tool_call>` opener streams normally (minus a trailing partial
  // opener held for the next delta); everything from the opener on is buffered
  // silently into xmlToolCallText for the finalize path to parse.
  const feedXmlLayer = async function* (visible: string) {
    if (!visible) return
    if (xmlToolCallText !== null) {
      // Already inside a tool-call region — buffer, emit nothing visible.
      xmlToolCallText += visible
      return
    }
    const combined = xmlHoldback + visible
    const openIdx = findXmlToolCallOpener(combined, allowHy3)
    if (openIdx !== -1) {
      const before = combined.slice(0, openIdx)
      if (before) yield* emitVisibleText(before)
      xmlHoldback = ''
      xmlToolCallText = combined.slice(openIdx)
    } else {
      const keep = trailingXmlOpenerPrefixLen(combined, allowHy3)
      const emit = keep > 0 ? combined.slice(0, combined.length - keep) : combined
      xmlHoldback = keep > 0 ? combined.slice(combined.length - keep) : ''
      if (emit) yield* emitVisibleText(emit)
    }
  }

  // Convert any buffered `<tool_call>` region to tool_use blocks. Shared by the
  // finish_reason finalize and the post-loop path (a stream that ends via
  // `[DONE]` with no finish_reason must not silently drop the buffer). Sets
  // xmlRecoveredStopReason when ≥1 call is recovered.
  const finalizeXmlBuffer = async function* () {
    if (xmlEnabled) {
      // Route the think-filter tail through the hold-back first so a tool call
      // that ended the stream is still captured.
      const tail = thinkFilter.flush()
      if (tail) yield* feedXmlLayer(tail)
    }
    if (xmlToolCallText !== null) {
      const buffered = xmlToolCallText
      xmlToolCallText = null
      // Only emit calls for tools the request actually advertised — an unknown
      // name means the `<tool_call>` was prose the model wrote about, not an
      // invocation. Fail open: emit the buffer verbatim.
      const recovered = recoverXmlToolCallsFromText(buffered, { allowHy3, toolNames })
      if (recovered) {
        // Any prose outside the tool XML (and outside think tags) is real text.
        if (recovered.visibleText) yield* emitVisibleText(recovered.visibleText)
        if (hasEmittedContentStart) yield* closeActiveContentBlock()
        for (const tc of recovered.calls) {
          const toolBlockIndex = contentBlockIndex
          yield {
            type: 'content_block_start',
            index: toolBlockIndex,
            content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} },
          }
          contentBlockIndex++
          yield {
            type: 'content_block_delta',
            index: toolBlockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify(
                normalizeToolArguments(tc.name, JSON.stringify(tc.arguments)),
              ),
            },
          }
          yield { type: 'content_block_stop', index: toolBlockIndex }
        }
        xmlRecoveredStopReason = 'tool_use'
      } else {
        // No valid call parsed — false positive; emit verbatim so nothing lost.
        yield* emitVisibleText(buffered)
      }
    } else if (xmlHoldback) {
      // A trailing partial opener that never completed is just text.
      yield* emitVisibleText(xmlHoldback)
      xmlHoldback = ''
    }
  }

  try {
    while (true) {
      const { done, value } = await readWithTimeout()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed === 'data: [DONE]') continue
      if (!trimmed.startsWith('data: ')) continue

      let chunk: OpenAIStreamChunk
      try {
        chunk = JSON.parse(trimmed.slice(6))
      } catch {
        continue
      }

      const chunkUsage = convertChunkUsage(chunk.usage)

      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta

        // Reasoning models (e.g. GLM-5, DeepSeek) may stream chain-of-thought
        // in a reasoning field before the actual reply appears in `content`.
        // Different providers use different aliases (`reasoning_content`,
        // `reasoning`, `reasoning_text`, `thinking`) — normalize via
        // extractReasoningDelta so they all surface as a thinking block
        // instead of leaking into visible text.
        const reasoningDelta = extractReasoningDelta(
          delta as unknown as Record<string, unknown>,
        )
        if (reasoningDelta != null) {
          if (!hasEmittedThinkingStart) {
            yield {
              type: 'content_block_start',
              index: contentBlockIndex,
              content_block: { type: 'thinking', thinking: '' },
            }
            hasEmittedThinkingStart = true
          }
          yield {
            type: 'content_block_delta',
            index: contentBlockIndex,
            delta: { type: 'thinking_delta', thinking: reasoningDelta },
          }
        }

        // Text content — use != null to distinguish absent field from empty string,
        // some providers send "" as first delta to signal streaming start
        if (delta.content != null && delta.content !== '') {
          const visible = thinkFilter.feed(delta.content)
          processStreamChunk(streamState, delta.content)
          if (visible) {
            // When XML tool-call recovery is active, route visible text through
            // the hold-back layer (which lazily opens the text block); otherwise
            // emit it directly.
            if (xmlEnabled) {
              yield* feedXmlLayer(visible)
            } else {
              yield* emitVisibleText(visible)
            }
          }
        }

        // Tool calls
        if (delta.tool_calls) {
          // Structured tool calls arrived — any held-back XML was a false
          // positive (the model uses one mechanism or the other). Flush it as
          // text so nothing is lost.
          if (xmlToolCallText !== null) {
            yield* emitVisibleText(xmlToolCallText)
            xmlToolCallText = null
          }
          if (xmlHoldback) {
            yield* emitVisibleText(xmlHoldback)
            xmlHoldback = ''
          }
          for (const tc of delta.tool_calls) {
            if (tc.id && tc.function?.name) {
              // New tool call starting — close any open thinking block first
              if (hasEmittedThinkingStart && !hasClosedThinking) {
                yield { type: 'content_block_stop', index: contentBlockIndex }
                contentBlockIndex++
                hasClosedThinking = true
              }
              if (hasEmittedContentStart) {
                yield* closeActiveContentBlock()
              }

              const toolBlockIndex = contentBlockIndex
              const initialArguments = tc.function.arguments ?? ''
              const normalizeAtStop = hasToolFieldMapping(tc.function.name)
              processStreamChunk(streamState, tc.function.arguments ?? '')
              activeToolCalls.set(tc.index, {
                id: tc.id,
                name: tc.function.name,
                index: toolBlockIndex,
                jsonBuffer: initialArguments,
                normalizeAtStop,
              })

              yield {
                type: 'content_block_start',
                index: toolBlockIndex,
                content_block: {
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.function.name,
                  input: {},
                  ...(tc.extra_content ? { extra_content: tc.extra_content } : {}),
                  // Extract Gemini signature from extra_content
                  ...((tc.extra_content?.google as any)?.thought_signature
                    ? {
                        signature: (tc.extra_content?.google as any)
                          .thought_signature,
                      }
                    : {}),
                },
              }
              contentBlockIndex++

              // Emit any initial arguments
              if (tc.function.arguments && !normalizeAtStop) {
                estimatedOutputChars += tc.function.arguments.length
                yield {
                  type: 'content_block_delta',
                  index: toolBlockIndex,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: tc.function.arguments,
                  },
                }
              }
            } else if (tc.function?.arguments) {
              // Continuation of existing tool call
              const active = activeToolCalls.get(tc.index)
              if (active) {
                if (tc.function.arguments) {
                  estimatedOutputChars += tc.function.arguments.length
                  active.jsonBuffer += tc.function.arguments
                }

                if (active.normalizeAtStop) {
                  continue
                }

                yield {
                  type: 'content_block_delta',
                  index: active.index,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: tc.function.arguments,
                  },
                }
              }
            }
          }
        }

        // Finish — guard ensures we only process finish_reason once even if
        // multiple chunks arrive with finish_reason set (some providers do this)
        if (choice.finish_reason && !hasProcessedFinishReason) {
          hasProcessedFinishReason = true

          // Close any open thinking block that wasn't closed by content transition
          if (hasEmittedThinkingStart && !hasClosedThinking) {
            yield { type: 'content_block_stop', index: contentBlockIndex }
            contentBlockIndex++
            hasClosedThinking = true
          }

          // XML tool-call finalize: convert any buffered `<tool_call>` region to
          // tool_use blocks and, on recovery, rewrite the stop reason (even from
          // `length`) so the agent loop runs the tool instead of ending the turn.
          yield* finalizeXmlBuffer()
          if (xmlRecoveredStopReason) {
            choice.finish_reason = 'tool_calls'
          }

          // Close any open content blocks
          if (hasEmittedContentStart) {
            yield* closeActiveContentBlock()
          }
          // Close active tool calls
          for (const [, tc] of activeToolCalls) {
            if (tc.normalizeAtStop) {
              let partialJson: string
              if (choice.finish_reason === 'length') {
                // Truncated by max tokens — preserve raw buffer to avoid
                // turning an incomplete tool call into an executable command
                partialJson = tc.jsonBuffer
              } else {
                const repairedStructuredJson = repairPossiblyTruncatedObjectJson(
                  tc.jsonBuffer,
                )
                if (repairedStructuredJson) {
                  partialJson = repairedStructuredJson
                } else {
                  partialJson = JSON.stringify(
                    normalizeToolArguments(tc.name, tc.jsonBuffer),
                  )
                }
              }

              yield {
                type: 'content_block_delta',
                index: tc.index,
                delta: {
                  type: 'input_json_delta',
                  partial_json: partialJson,
                },
              }
              yield { type: 'content_block_stop', index: tc.index }
              continue
            }

            let suffixToAdd = ''
            if (tc.jsonBuffer) {
              try {
                JSON.parse(tc.jsonBuffer)
              } catch {
                const str = tc.jsonBuffer.trimEnd()
                for (const combo of JSON_REPAIR_SUFFIXES) {
                  try {
                    JSON.parse(str + combo)
                    suffixToAdd = combo
                    break
                  } catch {}
                }
              }
            }

            if (suffixToAdd) {
              yield {
                type: 'content_block_delta',
                index: tc.index,
                delta: {
                  type: 'input_json_delta',
                  partial_json: suffixToAdd,
                },
              }
            }

            yield { type: 'content_block_stop', index: tc.index }
          }

          const stopReason =
            choice.finish_reason === 'tool_calls'
              ? 'tool_use'
              : choice.finish_reason === 'length'
                ? 'max_tokens'
                : 'end_turn'
          if (choice.finish_reason === 'content_filter' || choice.finish_reason === 'safety') {
            // Gemini/Azure content safety filter blocked the response.
            // Emit a visible text block so the user knows why output was truncated.
            if (!hasEmittedContentStart) {
              yield {
                type: 'content_block_start',
                index: contentBlockIndex,
                content_block: { type: 'text', text: '' },
              }
              hasEmittedContentStart = true
            }
            yield {
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'text_delta', text: '\n\n[Content blocked by provider safety filter]' },
            }
          }
          lastStopReason = stopReason

          yield {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            ...(chunkUsage ? { usage: chunkUsage } : {}),
          }
          if (chunkUsage) {
            hasEmittedFinalUsage = true
          }
        }
      }

      if (
        !hasEmittedFinalUsage &&
        chunkUsage &&
        (chunk.choices?.length ?? 0) === 0 &&
        lastStopReason !== null
      ) {
        yield {
          type: 'message_delta',
          delta: { stop_reason: lastStopReason, stop_sequence: null },
          usage: chunkUsage,
        }
        hasEmittedFinalUsage = true
      }
    }
    }
  } finally {
    reader.releaseLock()
  }

  // Stream ended without any finish_reason (e.g. a provider that closes the
  // connection after `data: [DONE]`) while XML tool-call text was still buffered.
  // Recover it here so the turn is not silently dropped. Gated on buffered XML so
  // the plain-text no-finish_reason path is unchanged.
  if (!hasProcessedFinishReason && (xmlToolCallText !== null || xmlHoldback)) {
    if (hasEmittedThinkingStart && !hasClosedThinking) {
      yield { type: 'content_block_stop', index: contentBlockIndex }
      contentBlockIndex++
      hasClosedThinking = true
    }
    yield* finalizeXmlBuffer()
    if (hasEmittedContentStart) {
      yield* closeActiveContentBlock()
    }
    lastStopReason = xmlRecoveredStopReason ?? 'end_turn'
    yield {
      type: 'message_delta',
      delta: { stop_reason: lastStopReason, stop_sequence: null },
    }
  }

  const stats = getStreamStats(streamState)
  if (stats.totalChunks > 0) {
    logForDebugging(
      JSON.stringify({
        type: 'stream_stats',
        model,
        total_chunks: stats.totalChunks,
        first_token_ms: stats.firstTokenMs,
        duration_ms: stats.durationMs,
      }),
      { level: 'debug' },
    )
  }

  // Fallback for providers that ignore stream_options.include_usage (e.g. NovitaAI/Kimi).
  // Estimate output tokens from accumulated streamed characters and input tokens from
  // the pre-computed estimate passed by the caller so the UI shows non-zero data.
  if (!hasEmittedFinalUsage && lastStopReason !== null && (estimatedOutputChars > 0 || (estimatedInputTokens ?? 0) > 0)) {
    const bytesPerToken = getBytesPerTokenForModel(model)
    yield {
      type: 'message_delta',
      delta: { stop_reason: lastStopReason, stop_sequence: null },
      usage: {
        input_tokens: estimatedInputTokens ?? 0,
        output_tokens: Math.ceil(estimatedOutputChars / bytesPerToken),
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }
  }

  yield { type: 'message_stop' }
}

export class OpenAIShimStream {
  private generator: AsyncGenerator<AnthropicStreamEvent>
  // The controller property is checked by claude.ts to distinguish streams from error messages
  controller = new AbortController()

  constructor(generator: AsyncGenerator<AnthropicStreamEvent>) {
    this.generator = generator
  }

  async *[Symbol.asyncIterator]() {
    yield* this.generator
  }
}
