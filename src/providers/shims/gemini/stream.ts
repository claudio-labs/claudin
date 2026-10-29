/**
 * A Gemini `streamGenerateContent?alt=sse` stream → Anthropic stream events,
 * and the non-streaming `generateContent` body → an Anthropic message.
 *
 * Each SSE event is a whole GenerateContentResponse (`data:` lines only, no
 * `event:` field). Parts map one to one:
 * - `thought: true` text → a thinking block; a `thoughtSignature` on a thought
 *   part, or on the text part that closes it, becomes the block's signature.
 * - text → a text block.
 * - `functionCall` → a complete tool_use (Gemini sends the arguments whole),
 *   with the part's `thoughtSignature` as `signature`, which the next request
 *   replays (request.ts).
 *
 * Usage maps to the Anthropic shape: `promptTokenCount` includes the cached
 * tokens, and Gemini bills thought tokens as output, so output is
 * `candidatesTokenCount + thoughtsTokenCount`.
 *
 * A reply that ends on MALFORMED_FUNCTION_CALL, UNEXPECTED_TOOL_CALL or OTHER
 * with nothing in it is an error here, so streaming.ts retries it the way
 * gemini-cli does (InvalidStreamError); a reply that only thought is caught
 * there for every provider (streamEnd.ts).
 */
import { APIError } from '@anthropic-ai/sdk'
import { buildAnthropicUsageFromRawUsage } from 'src/providers/cache/cacheMetrics.js'
import type { AnthropicStreamEvent } from 'src/providers/shims/codexShim.js'
import { makeMessageId } from 'src/providers/shims/openaiShim/helpers.js'

type Json = Record<string, any>

const REFUSAL_REASONS: ReadonlySet<string> = new Set([
  'SAFETY',
  'RECITATION',
  'LANGUAGE',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
])
const RETRYABLE_EMPTY_REASONS: ReadonlySet<string> = new Set([
  'MALFORMED_FUNCTION_CALL',
  'UNEXPECTED_TOOL_CALL',
  'OTHER',
])

function geminiStopReason(
  finishReason: string | undefined,
  sawToolUse: boolean,
): 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' {
  if (sawToolUse) return 'tool_use'
  if (finishReason === 'MAX_TOKENS') return 'max_tokens'
  if (finishReason && REFUSAL_REASONS.has(finishReason)) return 'refusal'
  return 'end_turn'
}

function geminiUsage(usageMetadata: Json | undefined): ReturnType<typeof buildAnthropicUsageFromRawUsage> {
  const u = usageMetadata ?? {}
  return buildAnthropicUsageFromRawUsage({
    prompt_tokens: u.promptTokenCount ?? 0,
    completion_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    prompt_tokens_details: { cached_tokens: u.cachedContentTokenCount ?? 0 },
  })
}

function blockedPromptError(data: Json): APIError | undefined {
  const reason = data.promptFeedback?.blockReason
  if (!reason) return undefined
  return APIError.generate(
    400,
    { error: { message: `Gemini blocked the prompt (${reason})` } },
    `Gemini blocked the prompt (${reason})`,
    new Headers(),
  )
}

function emptyReplyError(finishReason: string): APIError {
  const message = `Gemini ended the reply with ${finishReason} and no content`
  return APIError.generate(500, { error: { message } }, message, new Headers())
}

let toolUseCounter = 0
function toolUseId(call: Json): string {
  return typeof call.id === 'string' && call.id
    ? call.id
    : `toolu_gemini_${Date.now().toString(36)}_${(toolUseCounter++).toString(36)}`
}

async function* readGeminiSse(response: Response): AsyncGenerator<Json> {
  const reader = response.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (value) buffer += decoder.decode(value, { stream: !done })
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = done ? '' : (events.pop() ?? '')
      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n')
        if (!data || data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          if (parsed && typeof parsed === 'object') yield parsed as Json
        } catch {
          // A malformed event is skipped, as gemini-cli does.
        }
      }
      if (done) return
    }
  } finally {
    reader.releaseLock()
  }
}

export async function* geminiStreamToAnthropic(
  response: Response,
  model: string,
): AsyncGenerator<AnthropicStreamEvent> {
  yield {
    type: 'message_start',
    message: {
      id: makeMessageId(),
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: geminiUsage(undefined),
    },
  }

  let index = 0
  let open: 'thinking' | 'text' | undefined
  let sawContent = false
  let sawToolUse = false
  let finishReason: string | undefined
  let usageMetadata: Json | undefined

  function* close(): Generator<AnthropicStreamEvent> {
    if (!open) return
    yield { type: 'content_block_stop', index }
    index++
    open = undefined
  }

  function* openBlock(type: 'thinking' | 'text'): Generator<AnthropicStreamEvent> {
    if (open === type) return
    yield* close()
    yield {
      type: 'content_block_start',
      index,
      content_block: type === 'thinking'
        ? { type: 'thinking', thinking: '', signature: '' }
        : { type: 'text', text: '' },
    }
    open = type
  }

  for await (const chunk of readGeminiSse(response)) {
    const blocked = blockedPromptError(chunk)
    if (blocked) throw blocked
    if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata
    const candidate = chunk.candidates?.[0]
    if (!candidate) continue
    if (candidate.finishReason) finishReason = candidate.finishReason

    for (const part of (candidate.content?.parts ?? []) as Json[]) {
      const signature = typeof part.thoughtSignature === 'string' ? part.thoughtSignature : undefined

      if (part.functionCall) {
        yield* close()
        yield {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: toolUseId(part.functionCall),
            name: part.functionCall.name,
            input: {},
            ...(signature && { signature }),
          },
        }
        yield {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(part.functionCall.args ?? {}) },
        }
        yield { type: 'content_block_stop', index }
        index++
        sawContent = true
        sawToolUse = true
        continue
      }

      if (typeof part.text !== 'string') continue

      if (part.thought) {
        yield* openBlock('thinking')
        if (part.text) {
          yield { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: part.text } }
        }
        if (signature) {
          yield { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } }
        }
        sawContent = true
        continue
      }

      // The signature of a turn that thought arrives on the part after the
      // thoughts; it belongs to the thinking block still open.
      if (signature && open === 'thinking') {
        yield { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } }
      }
      if (!part.text) continue
      yield* openBlock('text')
      yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: part.text } }
      sawContent = true
    }
  }

  yield* close()
  if (!sawContent && finishReason && RETRYABLE_EMPTY_REASONS.has(finishReason)) {
    throw emptyReplyError(finishReason)
  }

  yield {
    type: 'message_delta',
    delta: { stop_reason: geminiStopReason(finishReason, sawToolUse), stop_sequence: null },
    usage: geminiUsage(usageMetadata),
  }
  yield { type: 'message_stop' }
}

/** The non-streaming body (the fallback after a failed stream) as an Anthropic message. */
export function convertGeminiResponseToAnthropicMessage(
  data: Json,
  model: string,
): Record<string, unknown> {
  const blocked = blockedPromptError(data)
  if (blocked) throw blocked
  const candidate = data.candidates?.[0]
  const finishReason: string | undefined = candidate?.finishReason
  const content: Json[] = []
  let thinking: Json | undefined

  for (const part of (candidate?.content?.parts ?? []) as Json[]) {
    const signature = typeof part.thoughtSignature === 'string' ? part.thoughtSignature : undefined
    if (part.functionCall) {
      content.push({
        type: 'tool_use',
        id: toolUseId(part.functionCall),
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
        ...(signature && { signature }),
      })
      thinking = undefined
      continue
    }
    if (typeof part.text !== 'string') continue
    if (part.thought) {
      if (!thinking) {
        thinking = { type: 'thinking', thinking: '', signature: '' }
        content.push(thinking)
      }
      thinking.thinking += part.text
      if (signature) thinking.signature = signature
      continue
    }
    if (signature && thinking) thinking.signature = signature
    thinking = undefined
    if (part.text) content.push({ type: 'text', text: part.text })
  }

  if (content.length === 0 && finishReason && RETRYABLE_EMPTY_REASONS.has(finishReason)) {
    throw emptyReplyError(finishReason)
  }
  const sawToolUse = content.some(block => block.type === 'tool_use')
  return {
    id: typeof data.responseId === 'string' ? data.responseId : makeMessageId(),
    type: 'message',
    role: 'assistant',
    content,
    model: data.modelVersion ?? model,
    stop_reason: geminiStopReason(finishReason, sawToolUse),
    stop_sequence: null,
    usage: geminiUsage(data.usageMetadata),
  }
}
