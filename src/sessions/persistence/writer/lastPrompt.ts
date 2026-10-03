import { getFirstMeaningfulUserMessageTextContent } from 'src/sessions/pure/firstPrompt.js'
import type { Message } from 'src/shared/types/message.js'

const MAX_LAST_PROMPT_CHARS = 200
const ELLIPSIS = '\u2026'

/** One display line: every line break, CR included (finding 8), becomes a space. */
export function flattenPrompt(text: string): string {
  const flat = text.replace(/\r\n|[\r\n]/g, ' ').trim()
  if (flat.length <= MAX_LAST_PROMPT_CHARS) return flat
  return `${flat.slice(0, MAX_LAST_PROMPT_CHARS).trim()}${ELLIPSIS}`
}

/** The prompt a turn should be listed by, or `undefined` when it has no user text. */
export function lastPromptOf(messages: readonly Message[]): string | undefined {
  const text = getFirstMeaningfulUserMessageTextContent([...messages])
  if (text === undefined) return undefined
  return flattenPrompt(text) || undefined
}
