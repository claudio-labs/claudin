import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'
import type { Message } from 'src/shared/types/message.js'
import { logForDebugging } from 'src/shared/debug.js'
import { isSdkApiUserAbortError } from 'src/shared/errors.js'
import {
  createUserMessage,
  getAssistantMessageText,
} from 'src/agent/messages/messages.js'
import { getSmallFastModel } from 'src/providers/model/model.js'
import { asSystemPrompt } from 'src/agent/systemPromptType.js'
import { queryModelWithoutStreaming } from 'src/providers/shims/claude.js'
import { stripThinkTags } from 'src/providers/shims/thinkTagSanitizer.js'
import { getSessionMemoryContent } from 'src/memory/session/sessionMemoryUtils.js'

// Recap only needs recent context — truncate to avoid "prompt too long" on
// large sessions. 30 messages ≈ ~15 exchanges, plenty for "where we left off."
const RECENT_MESSAGE_WINDOW = 30

function buildAwaySummaryPrompt(memory: string | null): string {
  const memoryBlock = memory
    ? `Session memory (broader context):\n${memory}\n\n`
    : ''
  return `${memoryBlock}The user stepped away and is coming back. Write exactly 1-3 short sentences. Start by stating the high-level task — what they are building or debugging, not implementation details. Next: the concrete next step. Skip status reports and commit recaps.`
}

/**
 * Strip inline chain-of-thought from the recap text.
 *
 * `thinkingConfig: { type: 'disabled' }` only turns off the provider's separate
 * reasoning channel — a model is still free to write `<thinking>…</thinking>`
 * into the text body, and several do. The away card renders whatever comes back
 * verbatim and dimmed, so an unstripped leak is displayed as if it were the
 * recap. Returning null when nothing but reasoning came back matches what the
 * caller already does with a null summary: show no card.
 */
export function sanitizeAwaySummary(text: string | null): string | null {
  if (text === null) return null
  const stripped = stripThinkTags(text).trim()
  return stripped.length > 0 ? stripped : null
}

/**
 * Generates a short session recap for the "while you were away" card.
 * Returns null on abort, empty transcript, or error.
 */
export async function generateAwaySummary(
  messages: readonly Message[],
  signal: AbortSignal,
): Promise<string | null> {
  if (messages.length === 0) {
    return null
  }

  try {
    const memory = await getSessionMemoryContent()
    const recent = messages.slice(-RECENT_MESSAGE_WINDOW)
    recent.push(createUserMessage({ content: buildAwaySummaryPrompt(memory) }))
    const response = await queryModelWithoutStreaming({
      messages: recent,
      systemPrompt: asSystemPrompt([]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model: getSmallFastModel(),
        toolChoice: undefined,
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        agents: [],
        querySource: 'away_summary',
        mcpTools: [],
        skipCacheWrite: true,
      },
    })

    if (response.isApiErrorMessage) {
      logForDebugging(
        `[awaySummary] API error: ${getAssistantMessageText(response)}`,
      )
      return null
    }
    return sanitizeAwaySummary(getAssistantMessageText(response))
  } catch (err) {
    if (isSdkApiUserAbortError(err) || signal.aborted) {
      return null
    }
    logForDebugging(`[awaySummary] generation failed: ${err}`)
    return null
  }
}
