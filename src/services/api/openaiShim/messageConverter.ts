/**
 * Message-format conversion: Anthropic SDK → OpenAI Chat Completions.
 *
 * Four exports:
 *  - `convertSystemPrompt` — flattens the system field (string | array | null)
 *    to a plain string.
 *  - `convertToolResultContent` — converts an Anthropic `tool_result` block
 *    body to the OpenAI tool message format. Collapses multipart text into a
 *    single string for DeepSeek compatibility (issue #774).
 *  - `convertContentBlocks` — converts a generic Anthropic content array
 *    to the OpenAI multipart format. Strips `thinking`/`redacted_thinking`
 *    (incompatible with 3P providers).
 *  - `convertMessages` — the heavyweight pass: walks the whole transcript,
 *    pre-scans for tool_use ↔ tool_result pairs, drops orphan tool_results,
 *    emits assistant tool_calls with provider-specific reasoning_content,
 *    handles Gemini thought_signature replay, then performs a final
 *    coalescing pass so OpenAI/vLLM/Ollama see strict role alternation.
 */

import { logForDebugging } from 'src/utils/debug.js'
import { isGeminiMode } from 'src/services/api/openaiShim/providerModes.js'
import type { OpenAIMessage } from 'src/services/api/openaiShim/types.js'

/**
 * Identity caches for the two heavyweight per-block conversions.
 *
 * Why block-level and not message-level: the upstream render pipeline
 * (normalizeMessagesForAPI rebuilds every assistant message; addCacheBreakpoints
 * rebuilds every top-level {role, content} wrapper — see
 * src/services/api/claude/messageConverters.ts:54-103) hands this module FRESH
 * message objects on every request, so a WeakMap keyed on message identity
 * would never hit. Deep content-block objects DO survive by reference across
 * turns for unchanged history (the wrappers spread/copy arrays but keep block
 * refs), so we memoize where the bytes are:
 *  - tool_result content conversion (large tool outputs, copied per turn by
 *    the `Error:` prefix / multipart join paths)
 *  - tool_use `arguments` JSON.stringify (large Write/Edit inputs; the
 *    tool_use BLOCK is rebuilt per turn by normalizeMessagesForAPI, but its
 *    `input` object ref survives normalizeToolInputForAPI for all tools that
 *    don't strip legacy fields)
 *
 * Staleness safety: blocks are immutable by convention — every rewriter
 * (applyStableStubs, pruneOldToolResults, stripOldThinkingBlocks, ...)
 * replaces a changed block with a NEW object (`{ ...block, content: stub }`),
 * so identity keying self-invalidates. Cached values are never mutated
 * downstream: tool messages are excluded from the coalescing merge, and
 * callers only JSON.stringify the result.
 */
const toolResultContentCache = new WeakMap<
  object,
  ReturnType<typeof convertToolResultContent>
>()
const toolUseArgumentsCache = new WeakMap<object, string>()

/** Compute counters so tests can prove cache hits without poking internals. */
export const _conversionCacheStatsForTesting = {
  toolResultComputes: 0,
  toolUseArgumentsComputes: 0,
}

function convertToolResultBlockCached(block: {
  content?: unknown
  is_error?: boolean
}): ReturnType<typeof convertToolResultContent> {
  const cached = toolResultContentCache.get(block)
  if (cached !== undefined) return cached
  _conversionCacheStatsForTesting.toolResultComputes++
  const result = convertToolResultContent(block.content, block.is_error)
  toolResultContentCache.set(block, result)
  return result
}

function stringifyToolUseArguments(input: unknown): string {
  // Mirror the pre-cache expression exactly:
  //   typeof input === 'string' ? input : JSON.stringify(input ?? {})
  if (typeof input === 'string') return input
  if (input === null || input === undefined) return '{}'
  if (typeof input !== 'object') return JSON.stringify(input)
  const cached = toolUseArgumentsCache.get(input)
  if (cached !== undefined) return cached
  _conversionCacheStatsForTesting.toolUseArgumentsComputes++
  const result = JSON.stringify(input)
  toolUseArgumentsCache.set(input, result)
  return result
}

export function convertSystemPrompt(
  system: unknown,
): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system
      .map((block: { type?: string; text?: string }) =>
        block.type === 'text' ? block.text ?? '' : '',
      )
      .join('\n\n')
  }
  return String(system)
}

export function convertToolResultContent(
  content: unknown,
  isError?: boolean,
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (typeof content === 'string') {
    return isError ? `Error: ${content}` : content
  }
  if (!Array.isArray(content)) {
    const text = JSON.stringify(content ?? '')
    return isError ? `Error: ${text}` : text
  }

  const parts: Array<{
    type: string
    text?: string
    image_url?: { url: string }
  }> = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text })
      continue
    }

    if (block?.type === 'image') {
      const source = block.source
      if (source?.type === 'url' && source.url) {
        parts.push({ type: 'image_url', image_url: { url: source.url } })
      } else if (source?.type === 'base64' && source.media_type && source.data) {
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${source.media_type};base64,${source.data}`,
          },
        })
      }
      continue
    }

    if (typeof block?.text === 'string') {
      parts.push({ type: 'text', text: block.text })
    }
  }

  if (parts.length === 0) return ''
  if (parts.length === 1 && parts[0].type === 'text') {
    const text = parts[0].text ?? ''
    return isError ? `Error: ${text}` : text
  }

  // Collapse arrays of only text blocks into a single string for DeepSeek
  // compatibility (issue #774). DeepSeek rejects arrays in role: "tool" messages.
  const allText = parts.every(p => p.type === 'text')
  if (allText) {
    const text = parts.map(p => p.text ?? '').join('\n\n')
    return isError ? `Error: ${text}` : text
  }

  if (isError && parts[0]?.type === 'text') {
    parts[0] = { ...parts[0], text: `Error: ${parts[0].text ?? ''}` }
  } else if (isError) {
    parts.unshift({ type: 'text', text: 'Error:' })
  }

  return parts
}

export function convertContentBlocks(
  content: unknown,
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content ?? '')

  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push({ type: 'text', text: block.text ?? '' })
        break
      case 'image': {
        const src = block.source
        if (src?.type === 'base64') {
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:${src.media_type};base64,${src.data}`,
            },
          })
        } else if (src?.type === 'url') {
          parts.push({ type: 'image_url', image_url: { url: src.url } })
        }
        break
      }
      case 'tool_use':
        // handled separately
        break
      case 'tool_result':
        // handled separately
        break
      case 'thinking':
      case 'redacted_thinking':
        // Strip thinking blocks for OpenAI-compatible providers.
        // These are Anthropic-specific content types that 3P providers
        // don't understand. Serializing them as <thinking> text corrupts
        // multi-turn context: the model sees the tags as part of its
        // previous reply and may mimic or misattribute them.
        break
      default:
        if (block.text) {
          parts.push({ type: 'text', text: block.text })
        }
    }
  }

  if (parts.length === 0) return ''
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text ?? ''

  // Collapse arrays of only text blocks into a single string for DeepSeek
  // compatibility (issue #774).
  const allText = parts.every(p => p.type === 'text')
  if (allText) {
    return parts.map(p => p.text ?? '').join('\n\n')
  }

  return parts
}

export function convertMessages(
  messages: Array<{
    role: string
    message?: { role?: string; content?: unknown }
    content?: unknown
  }>,
  system: unknown,
  options?: { preserveReasoningContent?: boolean },
): OpenAIMessage[] {
  const preserveReasoningContent = options?.preserveReasoningContent === true
  const result: OpenAIMessage[] = []
  const knownToolCallIds = new Set<string>()

  // Pre-scan for all tool results in the history to identify valid tool calls
  const toolResultIds = new Set<string>()
  for (const msg of messages) {
    const inner = msg.message ?? msg
    const content = (inner as { content?: unknown }).content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          (block as { type?: string }).type === 'tool_result' &&
          (block as { tool_use_id?: string }).tool_use_id
        ) {
          toolResultIds.add((block as { tool_use_id: string }).tool_use_id)
        }
      }
    }
  }

  // System message first
  const sysText = convertSystemPrompt(system)
  if (sysText) {
    result.push({ role: 'system', content: sysText })
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const isLastInHistory = i === messages.length - 1

    // Claude Code wraps messages in { role, message: { role, content } }
    const inner = msg.message ?? msg
    const role = (inner as { role?: string }).role ?? msg.role
    const content = (inner as { content?: unknown }).content

    if (role === 'user') {
      // Check for tool_result blocks in user messages
      if (Array.isArray(content)) {
        const toolResults = content.filter(
          (b: { type?: string }) => b.type === 'tool_result',
        )
        const otherContent = content.filter(
          (b: { type?: string }) => b.type !== 'tool_result',
        )

        // Emit tool results as tool messages, but ONLY if we have a matching tool_use ID.
        // Mistral/OpenAI strictly require tool messages to follow an assistant message with tool_calls.
        // If the user interrupted (ESC) and a synthetic tool_result was generated without a recorded tool_use,
        // emitting it here would cause a "role must alternate" or "unexpected role" error.
        for (const tr of toolResults) {
          const id = tr.tool_use_id ?? 'unknown'
          if (knownToolCallIds.has(id)) {
            result.push({
              role: 'tool',
              tool_call_id: id,
              content: convertToolResultBlockCached(tr),
            })
          } else {
            logForDebugging(
              `Dropping orphan tool_result for ID: ${id} to prevent API error`,
            )
          }
        }

        // Emit remaining user content
        if (otherContent.length > 0) {
          result.push({
            role: 'user',
            content: convertContentBlocks(otherContent),
          })
        }
      } else {
        result.push({
          role: 'user',
          content: convertContentBlocks(content),
        })
      }
    } else if (role === 'assistant') {
      // Check for tool_use blocks
      if (Array.isArray(content)) {
        const toolUses = content.filter(
          (b: { type?: string }) => b.type === 'tool_use',
        )
        const thinkingBlock = content.find(
          (b: { type?: string }) => b.type === 'thinking',
        )
        const textContent = content.filter(
          (b: { type?: string }) => b.type !== 'tool_use' && b.type !== 'thinking',
        )

        const assistantMsg: OpenAIMessage = {
          role: 'assistant',
          content: (() => {
            const c = convertContentBlocks(textContent)
            return typeof c === 'string'
              ? c
              : Array.isArray(c)
                ? c.map((p: { text?: string }) => p.text ?? '').join('')
                : ''
          })(),
        }

        // Providers that validate reasoning continuity (Moonshot/Kimi Code: "thinking
        // is enabled but reasoning_content is missing in assistant tool call
        // message at index N" 400) need the original chain-of-thought echoed
        // back on each assistant message that carries a tool_call. We kept
        // the thinking block on the Anthropic side; re-attach it here as the
        // `reasoning_content` field on the outgoing OpenAI-shaped message.
        // Gated per-provider because other endpoints either ignore the field
        // (harmless) or strict-reject unknown fields (harmful).
        if (preserveReasoningContent) {
          const thinkingText = (thinkingBlock as { thinking?: string } | undefined)?.thinking
          if (typeof thinkingText === 'string' && thinkingText.trim().length > 0) {
            assistantMsg.reasoning_content = thinkingText
          } else {
            // Thinking block was stripped by stripOldThinkingBlocks — set empty
            // string so Moonshot/DeepSeek don't 400 on missing reasoning_content.
            assistantMsg.reasoning_content = ''
          }
        }

        if (toolUses.length > 0) {
          const mappedToolCalls = toolUses
            .map(
              (tu: {
                id?: string
                name?: string
                input?: unknown
                extra_content?: Record<string, unknown>
                signature?: string
              }) => {
                const id = tu.id ?? `call_${crypto.randomUUID().replace(/-/g, '')}`

                // Only keep tool calls that have a corresponding result in the history,
                // or if it's the last message (prefill scenario).
                // Orphaned tool calls (e.g. from user interruption) cause 400 errors.
                if (!toolResultIds.has(id) && !isLastInHistory) {
                  return null
                }

                knownToolCallIds.add(id)
                const toolCall: NonNullable<
                  OpenAIMessage['tool_calls']
                >[number] = {
                  id,
                  type: 'function' as const,
                  function: {
                    name: tu.name ?? 'unknown',
                    arguments: stringifyToolUseArguments(tu.input),
                  },
                }

                // Preserve existing extra_content if present
                if (tu.extra_content) {
                  toolCall.extra_content = { ...tu.extra_content }
                }

                // Handle Gemini thought_signature
                if (isGeminiMode()) {
                  // If the model provided a signature in the tool_use block itself (e.g. from a previous Turn/Step)
                  // Use thinkingBlock.signature for ALL tool calls in the same assistant turn if available.
                  // The API requires the same signature on every replayed function call part in a parallel set.
                  const signature =
                    tu.signature ?? (thinkingBlock as any)?.signature

                  // Merge into existing google-specific metadata if present
                  const existingGoogle =
                    (toolCall.extra_content?.google as Record<
                      string,
                      unknown
                    >) ?? {}
                  toolCall.extra_content = {
                    ...toolCall.extra_content,
                    google: {
                      ...existingGoogle,
                      thought_signature:
                        signature ?? 'skip_thought_signature_validator',
                    },
                  }
                }

                return toolCall
              },
            )
            .filter((tc): tc is NonNullable<typeof tc> => tc !== null)

          if (mappedToolCalls.length > 0) {
            assistantMsg.tool_calls = mappedToolCalls
          }
        }

        // Only push assistant message if it has content or tool calls.
        // Stripped thinking-only blocks from user interruptions are empty and cause 400s.
        if (assistantMsg.content || assistantMsg.tool_calls?.length) {
          result.push(assistantMsg)
        }
      } else {
        const assistantMsg: OpenAIMessage = {
          role: 'assistant',
          content: (() => {
            const c = convertContentBlocks(content)
            return typeof c === 'string'
              ? c
              : Array.isArray(c)
                ? c.map((p: { text?: string }) => p.text ?? '').join('')
                : ''
          })(),
        }

        if (assistantMsg.content) {
          result.push(assistantMsg)
        }
      }
    }
  }

  // Coalescing pass: merge consecutive messages of the same role.
  // OpenAI/vLLM/Ollama require strict user↔assistant alternation.
  // Multiple consecutive tool messages are allowed (assistant → tool* → user).
  // Consecutive user or assistant messages must be merged to avoid Jinja
  // template errors like "roles must alternate" (Devstral, Mistral models).
  const coalesced: OpenAIMessage[] = []
  for (const msg of result) {
    const prev = coalesced[coalesced.length - 1]

    // Mistral/Devstral: 'tool' message must be followed by an 'assistant' message.
    // If a 'tool' result is followed by a 'user' message, we must inject a semantic
    // assistant response to satisfy the strict role sequence:
    // ... -> assistant (calls) -> tool (results) -> assistant (semantic) -> user (next)
    if (prev && prev.role === 'tool' && msg.role === 'user') {
      coalesced.push({
        role: 'assistant',
        content: '[Tool execution interrupted by user]',
      })
    }

    const lastAfterPossibleInjection = coalesced[coalesced.length - 1]
    if (
      lastAfterPossibleInjection &&
      lastAfterPossibleInjection.role === msg.role &&
      msg.role !== 'tool' &&
      msg.role !== 'system'
    ) {
      const prevContent = lastAfterPossibleInjection.content
      const curContent = msg.content

      if (typeof prevContent === 'string' && typeof curContent === 'string') {
        lastAfterPossibleInjection.content =
          prevContent + (prevContent && curContent ? '\n' : '') + curContent
      } else {
        const toArray = (
          c:
            | string
            | Array<{ type: string; text?: string; image_url?: { url: string } }>
            | undefined,
        ): Array<{
          type: string
          text?: string
          image_url?: { url: string }
        }> => {
          if (!c) return []
          if (typeof c === 'string') return c ? [{ type: 'text', text: c }] : []
          return c
        }
        lastAfterPossibleInjection.content = [
          ...toArray(prevContent),
          ...toArray(curContent),
        ]
      }

      if (msg.tool_calls?.length) {
        lastAfterPossibleInjection.tool_calls = [
          ...(lastAfterPossibleInjection.tool_calls ?? []),
          ...msg.tool_calls,
        ]
      }
    } else {
      coalesced.push(msg)
    }
  }

  return coalesced
}
