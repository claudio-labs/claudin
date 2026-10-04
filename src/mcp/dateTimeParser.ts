import { queryHaiku } from 'src/providers/shims/claude.js'
import { logError } from 'src/shared/log.js'
import { extractTextContent } from 'src/agent/messages/text.js'
import { asSystemPrompt } from 'src/agent/systemPromptType.js'
import {
  buildDateRequest,
  readClock,
} from 'src/mcp/elicitation/dateRequest.js'
import { isIsoDateOrDateTime } from 'src/mcp/elicitation/isoDate.js'

export type DateTimeParseResult =
  | { success: true; value: string }
  | { success: false; error: string }

const UNREADABLE_REPLY = 'Unable to parse date/time from input'
/** Shown instead of the model call's own error, which may name hosts or keys. */
const MODEL_UNAVAILABLE =
  'Unable to parse date/time. Please enter in ISO 8601 format manually.'

const STARTS_AS_ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T|$)/

async function askModel(
  input: string,
  format: 'date' | 'date-time',
  signal: AbortSignal,
): Promise<string> {
  const request = buildDateRequest(input, format, readClock(new Date()))
  const response = await queryHaiku({
    systemPrompt: asSystemPrompt(request.instructions),
    userPrompt: request.prompt,
    signal,
    options: {
      querySource: 'mcp_datetime_parse',
      agents: [],
      mcpTools: [],
      isNonInteractiveSession: false,
      hasAppendSystemPrompt: false,
    },
  })
  return extractTextContent(response.message.content).trim()
}

export async function parseNaturalLanguageDateTime(
  input: string,
  format: 'date' | 'date-time',
  signal: AbortSignal,
): Promise<DateTimeParseResult> {
  let reply: string
  try {
    reply = await askModel(input, format, signal)
  } catch (error) {
    logError(error)
    return { success: false, error: MODEL_UNAVAILABLE }
  }
  return isIsoDateOrDateTime(reply)
    ? { success: true, value: reply }
    : { success: false, error: UNREADABLE_REPLY }
}

/** Whether the text is already shaped like an ISO date, right or wrong, so the model has nothing to add. */
export function looksLikeISO8601(input: string): boolean {
  return STARTS_AS_ISO_DATE.test(input.trim())
}
