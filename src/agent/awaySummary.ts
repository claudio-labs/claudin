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
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'

/**
 * Whether the "while you were away" recap runs (useAwaySummary, which also
 * sits behind `feature('AWAY_SUMMARY')`). On by default in this fork; upstream
 * shipped it off. CLAUDIN_AWAY_SUMMARY=0 is the killswitch.
 */
export function isAwaySummaryEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_AWAY_SUMMARY)
}

// Recap only needs recent context — truncate to avoid "prompt too long" on
// large sessions. 30 messages ≈ ~15 exchanges, plenty for "where we left off."
const RECENT_MESSAGE_WINDOW = 30

// Claude Code 2.1.323's prompt and cap.
const AWAY_SUMMARY_PROMPT = `The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.`
export const MAX_RECAP_CHARS = 400

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

export type AwaySummaryResult =
  | { kind: 'ok'; text: string; capped: boolean }
  | { kind: 'no-turn' }
  | { kind: 'aborted' }
  | { kind: 'api-error'; text: string }
  | { kind: 'failed' }

/** Something to recap: a reply from the model, or a compacted conversation. */
function hasTurn(messages: readonly Message[]): boolean {
  return messages.some(
    m =>
      (m.type === 'assistant' && !m.isApiErrorMessage) ||
      (m.type === 'user' && m.isCompactSummary === true),
  )
}

/** What the away card shows: a recap, and nothing for any other outcome. */
export function awayCardText(result: AwaySummaryResult): string | null {
  return result.kind === 'ok' ? result.text : null
}

/**
 * Generates a short session recap, for the "while you were away" card and for
 * /recap.
 */
export async function generateAwaySummary(
  messages: readonly Message[],
  signal: AbortSignal,
  query: typeof queryModelWithoutStreaming = queryModelWithoutStreaming,
): Promise<AwaySummaryResult> {
  if (!hasTurn(messages)) return { kind: 'no-turn' }

  try {
    const recent = messages.slice(-RECENT_MESSAGE_WINDOW)
    recent.push(createUserMessage({ content: AWAY_SUMMARY_PROMPT }))
    const response = await query({
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

    if (signal.aborted) return { kind: 'aborted' }
    if (response.isApiErrorMessage) {
      const text = getAssistantMessageText(response) ?? ''
      logForDebugging(`[awaySummary] API error: ${text}`)
      return { kind: 'api-error', text }
    }
    const text = sanitizeAwaySummary(getAssistantMessageText(response))
    if (text === null) return { kind: 'failed' }
    // Counted in code points, so the cut never splits an emoji's surrogate pair.
    const chars = Array.from(text)
    if (chars.length <= MAX_RECAP_CHARS) return { kind: 'ok', text, capped: false }
    logForDebugging(`[awaySummary] recap capped from ${chars.length} to ${MAX_RECAP_CHARS} chars`)
    return { kind: 'ok', text: `${chars.slice(0, MAX_RECAP_CHARS - 1).join('')}…`, capped: true }
  } catch (err) {
    if (isSdkApiUserAbortError(err) || signal.aborted) {
      return { kind: 'aborted' }
    }
    logForDebugging(`[awaySummary] generation failed: ${err}`)
    return { kind: 'failed' }
  }
}
