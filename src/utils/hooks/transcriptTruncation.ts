/**
 * Transcript truncation for LLM hook evaluators (prompt/agent "judge" hooks).
 *
 * The Stop-condition judge (see execPromptHook.ts) receives the conversation
 * transcript as context. Long sessions can exceed the evaluator model's
 * context window, so we cap the transcript at a fraction of that window by
 * dropping the oldest messages and prepending a synthetic notice telling the
 * judge that evidence may have been omitted.
 */
import { roughTokenCountEstimation } from 'src/services/tokenEstimation.js'
import type { Message } from 'src/types/message.js'
import { getContextWindowForModel } from 'src/utils/context.js'
import { logError } from 'src/utils/log.js'
import { createUserMessage } from 'src/utils/messages.js'
import { jsonStringify } from 'src/utils/slowOperations.js'

/** Fraction of the evaluator model's context window the transcript may use. */
const TRANSCRIPT_BUDGET_FRACTION = 0.5

/**
 * Synthetic user message prepended to a truncated transcript so the judge
 * knows evidence may live in the omitted prefix.
 */
export function buildTruncationNotice(omittedCount: number): string {
  return `[Earlier conversation truncated to fit the hook evaluator's context window — ${omittedCount} earlier messages omitted. Evaluate the condition against the recent transcript below; if the required evidence may be in the omitted prefix, return {"ok": false, "reason": "insufficient evidence in transcript"}.]`
}

/** True for user messages that carry tool_result blocks. */
function isToolResultUserMessage(message: Message): boolean {
  if (message.type !== 'user') {
    return false
  }
  const content = message.message.content
  if (!Array.isArray(content)) {
    return false
  }
  return content.some(
    block =>
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      block.type === 'tool_result',
  )
}

/**
 * Drop the oldest messages until the transcript fits within
 * TRANSCRIPT_BUDGET_FRACTION of `model`'s context window (token-estimated).
 * When messages are dropped, a synthetic user notice is prepended.
 *
 * The cut point is advanced past any leading tool_result user messages so the
 * kept slice never starts with an orphaned tool_result (its tool_use lives in
 * the dropped prefix). The most recent message is always kept.
 *
 * Fallback pattern: any unexpected failure returns the transcript unchanged.
 */
export function truncateTranscriptForHookEvaluator(
  messages: Message[],
  model: string,
): { messages: Message[]; omittedCount: number } {
  try {
    if (messages.length === 0) {
      return { messages, omittedCount: 0 }
    }

    const budget = Math.floor(
      getContextWindowForModel(model) * TRANSCRIPT_BUDGET_FRACTION,
    )
    const tokenCounts = messages.map(m =>
      roughTokenCountEstimation(jsonStringify(m)),
    )
    let totalTokens = 0
    for (const count of tokenCounts) {
      totalTokens += count
    }
    if (totalTokens <= budget) {
      return { messages, omittedCount: 0 }
    }

    // Drop oldest messages until within budget (always keep the last one)
    let cut = 0
    let remaining = totalTokens
    while (cut < messages.length - 1 && remaining > budget) {
      remaining -= tokenCounts[cut]!
      cut++
    }
    // Keep logical turn boundaries: don't start the kept slice on a
    // tool_result whose tool_use was dropped.
    while (
      cut < messages.length - 1 &&
      isToolResultUserMessage(messages[cut]!)
    ) {
      cut++
    }

    if (cut === 0) {
      return { messages, omittedCount: 0 }
    }

    return {
      messages: [
        createUserMessage({ content: buildTruncationNotice(cut) }),
        ...messages.slice(cut),
      ],
      omittedCount: cut,
    }
  } catch (error) {
    // Never block hook evaluation on truncation issues — fall back to the
    // raw transcript and let the provider surface any context overflow.
    logError(error)
    return { messages, omittedCount: 0 }
  }
}
