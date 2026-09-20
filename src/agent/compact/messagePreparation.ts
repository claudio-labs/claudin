import type { AssistantMessage, Message } from 'src/shared/types/message.js'
import { createUserMessage } from 'src/agent/messages/messages.js'
import { getPromptTooLongTokenGap } from 'src/providers/transport/errors.js'
import { roughTokenCountEstimationForMessages } from 'src/shared/tokenEstimation.js'
import { groupMessagesByApiRound } from 'src/agent/compact/grouping.js'

/**
 * Strip image blocks from user messages before sending for compaction.
 * Images are not needed for generating a conversation summary and can
 * cause the compaction API call itself to hit the prompt-too-long limit,
 * especially in CCD sessions where users frequently attach images.
 * Replaces image blocks with a text marker so the summary still notes
 * that an image was shared.
 *
 * Note: Only user messages contain images (either directly attached or within
 * tool_result content from tools). Assistant messages contain text, tool_use,
 * and thinking blocks but not images.
 */
export function stripImagesFromMessages(messages: Message[]): Message[] {
  return messages.map(message => {
    if (message.type !== 'user') {
      return message
    }

    const content = message.message.content
    if (!Array.isArray(content)) {
      return message
    }

    let hasMediaBlock = false
    const newContent = content.flatMap(block => {
      if (block.type === 'image') {
        hasMediaBlock = true
        return [{ type: 'text' as const, text: '[image]' }]
      }
      if (block.type === 'document') {
        hasMediaBlock = true
        return [{ type: 'text' as const, text: '[document]' }]
      }
      // Also strip images/documents nested inside tool_result content arrays
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        let toolHasMedia = false
        const newToolContent = block.content.map(item => {
          if (item.type === 'image') {
            toolHasMedia = true
            return { type: 'text' as const, text: '[image]' }
          }
          if (item.type === 'document') {
            toolHasMedia = true
            return { type: 'text' as const, text: '[document]' }
          }
          return item
        })
        if (toolHasMedia) {
          hasMediaBlock = true
          return [{ ...block, content: newToolContent }]
        }
      }
      return [block]
    })

    if (!hasMediaBlock) {
      return message
    }

    return {
      ...message,
      message: {
        ...message.message,
        content: newContent,
      },
    } as typeof message
  })
}

/**
 * Strip attachment types that are re-injected post-compaction anyway.
 * skill_discovery/skill_listing are re-surfaced by resetSentSkillNames()
 * + the next turn's discovery signal, so feeding them to the summarizer
 * wastes tokens and pollutes the summary with stale skill suggestions.
 *
 * bash_git_instructions follows the same pattern: re-emitted fresh on the
 * next turn after resetSentBashGitInstructions() runs in
 * runPostCompactCleanup. Always-on (no feature gate) since the attachment
 * type exists in every build.
 */
export function stripReinjectedAttachments(messages: Message[]): Message[] {
  return messages.filter(
    m =>
      !(
        m.type === 'attachment' &&
        m.attachment.type === 'bash_git_instructions'
      ),
  )
}

export const MAX_PTL_RETRIES = 3
const PTL_RETRY_MARKER = '[earlier conversation truncated for compaction retry]'

/**
 * Drops the oldest API-round groups from messages until tokenGap is covered.
 * Falls back to dropping 20% of groups when the gap is unparseable (some
 * Vertex/Bedrock error formats). Returns null when nothing can be dropped
 * without leaving an empty summarize set.
 *
 * This is the last-resort escape hatch for CC-1180 — when the compact request
 * itself hits prompt-too-long, the user is otherwise stuck. Dropping the
 * oldest context is lossy but unblocks them. The reactive-compact path
 * (compactMessages.ts) has the proper retry loop that peels from the tail;
 * this helper is the dumb-but-safe fallback for the proactive/manual path
 * that wasn't migrated in bfdb472f's unification.
 */
export function truncateHeadForPTLRetry(
  messages: Message[],
  ptlResponse: AssistantMessage,
): Message[] | null {
  // Strip our own synthetic marker from a previous retry before grouping.
  // Otherwise it becomes its own group 0 and the 20% fallback stalls
  // (drops only the marker, re-adds it, zero progress on retry 2+).
  const input =
    messages[0]?.type === 'user' &&
    messages[0].isMeta &&
    messages[0].message.content === PTL_RETRY_MARKER
      ? messages.slice(1)
      : messages

  const groups = groupMessagesByApiRound(input)
  if (groups.length < 2) return null

  const tokenGap = getPromptTooLongTokenGap(ptlResponse)
  let dropCount: number
  if (tokenGap !== undefined) {
    let acc = 0
    dropCount = 0
    for (const g of groups) {
      acc += roughTokenCountEstimationForMessages(g)
      dropCount++
      if (acc >= tokenGap) break
    }
  } else {
    dropCount = Math.max(1, Math.floor(groups.length * 0.2))
  }

  // Keep at least one group so there's something to summarize.
  dropCount = Math.min(dropCount, groups.length - 1)
  if (dropCount < 1) return null

  const sliced = groups.slice(dropCount).flat()
  // groupMessagesByApiRound puts the preamble in group 0 and starts every
  // subsequent group with an assistant message. Dropping group 0 leaves an
  // assistant-first sequence which the API rejects (first message must be
  // role=user). Prepend a synthetic user marker — ensureToolResultPairing
  // already handles any orphaned tool_results this creates.
  if (sliced[0]?.type === 'assistant') {
    return [
      createUserMessage({ content: PTL_RETRY_MARKER, isMeta: true }),
      ...sliced,
    ]
  }
  return sliced
}
