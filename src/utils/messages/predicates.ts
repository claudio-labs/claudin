import { feature } from 'bun:bundle'
import type {
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import type {
  AssistantMessage,
  Message,
  NormalizedAssistantMessage,
  NormalizedMessage,
  NormalizedUserMessage,
  SystemCompactBoundaryMessage,
  SystemLocalCommandMessage,
} from '../../types/message.js'
import {
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  SYNTHETIC_MESSAGES,
} from './constants.js'

export function isSyntheticMessage(message: Message): boolean {
  return (
    message.type !== 'progress' &&
    message.type !== 'attachment' &&
    message.type !== 'system' &&
    Array.isArray(message.message.content) &&
    message.message.content[0]?.type === 'text' &&
    SYNTHETIC_MESSAGES.has(message.message.content[0].text)
  )
}

export function getLastAssistantMessage(
  messages: Message[],
): AssistantMessage | undefined {
  // findLast exits early from the end — much faster than filter + last for
  // large message arrays (called on every REPL render via useFeedbackSurvey).
  return messages.findLast(
    (msg): msg is AssistantMessage => msg.type === 'assistant',
  )
}

export function hasToolCallsInLastAssistantTurn(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && message.type === 'assistant') {
      const assistantMessage = message as AssistantMessage
      const content = assistantMessage.message.content
      if (Array.isArray(content)) {
        return content.some(block => block.type === 'tool_use')
      }
    }
  }
  return false
}

export function isNotEmptyMessage(message: Message): boolean {
  if (
    message.type === 'progress' ||
    message.type === 'attachment' ||
    message.type === 'system'
  ) {
    return true
  }

  if (typeof message.message.content === 'string') {
    return message.message.content.trim().length > 0
  }

  if (message.message.content.length === 0) {
    return false
  }

  // Skip multi-block messages for now
  if (message.message.content.length > 1) {
    return true
  }

  if (message.message.content[0]!.type !== 'text') {
    return true
  }

  return (
    message.message.content[0]!.text.trim().length > 0 &&
    message.message.content[0]!.text !== NO_CONTENT_MESSAGE &&
    message.message.content[0]!.text !== INTERRUPT_MESSAGE_FOR_TOOL_USE
  )
}

export type ToolUseRequestMessage = NormalizedAssistantMessage & {
  message: { content: [ToolUseBlock] }
}

export function isToolUseRequestMessage(
  message: Message,
): message is ToolUseRequestMessage {
  return (
    message.type === 'assistant' &&
    // Note: stop_reason === 'tool_use' is unreliable -- it's not always set correctly
    message.message.content.some(_ => _.type === 'tool_use')
  )
}

export type ToolUseResultMessage = NormalizedUserMessage & {
  message: { content: [ToolResultBlockParam] }
}

export function isToolUseResultMessage(
  message: Message,
): message is ToolUseResultMessage {
  return (
    message.type === 'user' &&
    ((Array.isArray(message.message.content) &&
      message.message.content[0]?.type === 'tool_result') ||
      Boolean(message.toolUseResult))
  )
}

export function isSystemLocalCommandMessage(
  message: Message,
): message is SystemLocalCommandMessage {
  return message.type === 'system' && message.subtype === 'local_command'
}

/**
 * Checks if a message is a compact boundary marker
 */
export function isCompactBoundaryMessage(
  message: Message | NormalizedMessage,
): message is SystemCompactBoundaryMessage {
  return message?.type === 'system' && message.subtype === 'compact_boundary'
}

/**
 * Finds the index of the last compact boundary marker in the messages array
 * @returns The index of the last compact boundary, or -1 if none found
 */
export function findLastCompactBoundaryIndex<
  T extends Message | NormalizedMessage,
>(messages: T[]): number {
  // Scan backwards to find the most recent compact boundary
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && isCompactBoundaryMessage(message)) {
      return i
    }
  }
  return -1 // No boundary found
}

/**
 * Returns messages from the last compact boundary onward (including the boundary).
 * If no boundary exists, returns all messages.
 *
 * Also filters snipped messages by default (when HISTORY_SNIP is enabled) —
 * the REPL keeps full history for UI scrollback, so model-facing paths need
 * both compact-slice AND snip-filter applied. Pass `{ includeSnipped: true }`
 * to opt out (e.g., REPL.tsx fullscreen compact handler which preserves
 * snipped messages in scrollback).
 *
 * Note: The boundary itself is a system message and will be filtered by normalizeMessagesForAPI.
 */
export function getMessagesAfterCompactBoundary<
  T extends Message | NormalizedMessage,
>(messages: T[], options?: { includeSnipped?: boolean }): T[] {
  const boundaryIndex = findLastCompactBoundaryIndex(messages)
  const sliced = boundaryIndex === -1 ? messages : messages.slice(boundaryIndex)
  if (!options?.includeSnipped && feature('HISTORY_SNIP')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { projectSnippedView } =
      require('../../services/compact/snipProjection.js') as typeof import('../../services/compact/snipProjection.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    return projectSnippedView(sliced as Message[]) as T[]
  }
  return sliced
}

export function shouldShowUserMessage(
  message: NormalizedMessage,
  isTranscriptMode: boolean,
): boolean {
  if (message.type !== 'user') return true
  if (message.isMeta) {
    // Channel messages stay isMeta (for snip-tag/turn-boundary/brief-mode
    // semantics) but render in the default transcript — the keyboard user
    // should see what arrived. The <channel> tag in UserTextMessage handles
    // the actual rendering.
    if (
      (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
      message.origin?.kind === 'channel'
    )
      return true
    return false
  }
  if (message.isVisibleInTranscriptOnly && !isTranscriptMode) return false
  return true
}

export function isThinkingMessage(message: Message): boolean {
  if (message.type !== 'assistant') return false
  if (!Array.isArray(message.message.content)) return false
  return message.message.content.every(
    block => block.type === 'thinking' || block.type === 'redacted_thinking',
  )
}

/**
 * Count total calls to a specific tool in message history
 * Stops early at maxCount for efficiency
 */
export function countToolCalls(
  messages: Message[],
  toolName: string,
  maxCount?: number,
): number {
  let count = 0
  for (const msg of messages) {
    if (!msg) continue
    if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
      const hasToolUse = msg.message.content.some(
        (block): block is ToolUseBlock =>
          block.type === 'tool_use' && block.name === toolName,
      )
      if (hasToolUse) {
        count++
        if (maxCount && count >= maxCount) {
          return count
        }
      }
    }
  }
  return count
}

/**
 * Check if the most recent tool call succeeded (has result without is_error)
 * Searches backwards for efficiency.
 */
export function hasSuccessfulToolCall(
  messages: Message[],
  toolName: string,
): boolean {
  // Search backwards to find most recent tool_use for this tool
  let mostRecentToolUseId: string | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
      const toolUse = msg.message.content.find(
        (block): block is ToolUseBlock =>
          block.type === 'tool_use' && block.name === toolName,
      )
      if (toolUse) {
        mostRecentToolUseId = toolUse.id
        break
      }
    }
  }

  if (!mostRecentToolUseId) return false

  // Find the corresponding tool_result (search backwards)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      const toolResult = msg.message.content.find(
        (block): block is ToolResultBlockParam =>
          block.type === 'tool_result' &&
          block.tool_use_id === mostRecentToolUseId,
      )
      if (toolResult) {
        // Success if is_error is false or undefined
        return toolResult.is_error !== true
      }
    }
  }

  // Tool called but no result yet (shouldn't happen in practice)
  return false
}
