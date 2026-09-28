/**
 * A short title for the session, from the small fast model.
 */
import { asSystemPrompt } from 'src/agent/systemPromptType.js'
import { getIsNonInteractiveSession } from 'src/platform/bootstrap/state.js'
import { queryHaiku } from 'src/providers/shims/claude.js'
import { textBlocks } from 'src/sessions/lifecycle/title/textBlocks.js'
import { TITLE_INSTRUCTIONS } from 'src/sessions/lifecycle/title/titlePrompt.js'
import { parseTitleReply } from 'src/sessions/lifecycle/title/titleReply.js'
import { TITLE_OUTPUT_FORMAT } from 'src/sessions/lifecycle/title/titleSchema.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import type { AssistantMessage } from 'src/shared/types/message.js'

/**
 * What a failed request gives, an abort included. Callers cannot tell it from
 * a real title, but they retry after null on every query, which on a provider
 * without structured output would mean one failing call per turn.
 */
const FAILED_REQUEST_TITLE = 'Claudin'

export async function generateSessionTitle(
  description: string,
  signal: AbortSignal,
): Promise<string | null> {
  const userPrompt = description.trim()
  if (!userPrompt) return null
  let reply: AssistantMessage
  try {
    reply = await queryHaiku({
      systemPrompt: asSystemPrompt([TITLE_INSTRUCTIONS]),
      userPrompt,
      outputFormat: TITLE_OUTPUT_FORMAT,
      signal,
      options: {
        querySource: 'generate_session_title',
        agents: [],
        mcpTools: [],
        hasAppendSystemPrompt: false,
        isNonInteractiveSession: getIsNonInteractiveSession(),
      },
    })
  } catch (error) {
    logForDebugging(`The session title request failed: ${errorMessage(error)}`)
    return FAILED_REQUEST_TITLE
  }
  // The structured reply may come split across several text blocks.
  const title = parseTitleReply(textBlocks(reply.message.content).join(''))
  if (title === null) logForDebugging('The session title reply held no title')
  return title
}
