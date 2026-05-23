import type {
  BetaContentBlockParam,
  BetaImageBlockParam,
  BetaRequestDocumentBlock,
  BetaToolResultBlockParam,
  BetaMessageParam as MessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { feature } from 'bun:bundle'
import type { QuerySource } from 'src/constants/querySource.js'
import { isConnectorTextBlock } from 'src/types/connectorText.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from 'src/types/message.js'
import { getCacheControl } from './cacheControl.js'

export function userMessageToMessageParam(
  message: UserMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): MessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl({ querySource }),
            }),
          },
        ],
      }
    } else {
      return {
        role: 'user',
        content: message.message.content.map((_, i) => ({
          ..._,
          ...(i === message.message.content.length - 1
            ? enablePromptCaching
              ? { cache_control: getCacheControl({ querySource }) }
              : {}
            : {}),
        })),
      }
    }
  }
  // Clone array content to prevent in-place mutations from contaminating the
  // original message across multiple calls to addCacheBreakpoints.
  return {
    role: 'user',
    content: Array.isArray(message.message.content)
      ? [...message.message.content]
      : message.message.content,
  }
}

export function assistantMessageToMessageParam(
  message: AssistantMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): MessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl({ querySource }),
            }),
          },
        ],
      }
    } else {
      return {
        role: 'assistant',
        content: message.message.content.map((_, i) => ({
          ..._,
          ...(i === message.message.content.length - 1 &&
          _.type !== 'thinking' &&
          _.type !== 'redacted_thinking' &&
          (feature('CONNECTOR_TEXT') ? !isConnectorTextBlock(_) : true)
            ? enablePromptCaching
              ? { cache_control: getCacheControl({ querySource }) }
              : {}
            : {}),
        })),
      }
    }
  }
  return {
    role: 'assistant',
    content: message.message.content,
  }
}

/**
 * Extracts the request ID from the most recent assistant message in the
 * conversation. Used to link consecutive API requests in analytics so we can
 * join them for cache-hit-rate analysis and incremental token tracking.
 *
 * Deriving this from the message array (rather than global state) ensures each
 * query chain (main thread, subagent, teammate) tracks its own request chain
 * independently, and rollback/undo naturally updates the value.
 */
export function getPreviousRequestIdFromMessages(
  messages: Message[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type === 'assistant' && msg.requestId) {
      return msg.requestId
    }
  }
  return undefined
}

function isMedia(
  block: BetaContentBlockParam,
): block is BetaImageBlockParam | BetaRequestDocumentBlock {
  return block.type === 'image' || block.type === 'document'
}

function isToolResult(
  block: BetaContentBlockParam,
): block is BetaToolResultBlockParam {
  return block.type === 'tool_result'
}

/**
 * Ensures messages contain at most `limit` media items (images + documents).
 * Strips oldest media first to preserve the most recent.
 */
export function stripExcessMediaItems(
  messages: (UserMessage | AssistantMessage)[],
  limit: number,
): (UserMessage | AssistantMessage)[] {
  let toRemove = 0
  for (const msg of messages) {
    if (!Array.isArray(msg.message.content)) continue
    for (const block of msg.message.content) {
      if (isMedia(block)) toRemove++
      if (isToolResult(block) && Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (isMedia(nested)) toRemove++
        }
      }
    }
  }
  toRemove -= limit
  if (toRemove <= 0) return messages

  return messages.map(msg => {
    if (toRemove <= 0) return msg
    const content = msg.message.content
    if (!Array.isArray(content)) return msg

    const before = toRemove
    const stripped = content
      .map(block => {
        if (
          toRemove <= 0 ||
          !isToolResult(block) ||
          !Array.isArray(block.content)
        )
          return block
        const filtered = block.content.filter(n => {
          if (toRemove > 0 && isMedia(n)) {
            toRemove--
            return false
          }
          return true
        })
        return filtered.length === block.content.length
          ? block
          : { ...block, content: filtered }
      })
      .filter(block => {
        if (toRemove > 0 && isMedia(block)) {
          toRemove--
          return false
        }
        return true
      })

    return before === toRemove
      ? msg
      : {
          ...msg,
          message: { ...msg.message, content: stripped },
        }
  }) as (UserMessage | AssistantMessage)[]
}
