/**
 * The part of a conversation a title is made from: what the human and the
 * model said to each other, most recent last.
 */
import { textBlocks } from 'src/sessions/lifecycle/title/textBlocks.js'
import type { AssistantMessage, Message, UserMessage } from 'src/shared/types/message.js'

/** The title model only needs the gist, and the end of a conversation says most about it. */
const MAX_CHARS = 1000

export function extractConversationText(messages: readonly Message[]): string {
  const text = messages.filter(isConversationTurn).flatMap(turn => textBlocks(turn.message.content)).join('\n')
  return text.length > MAX_CHARS ? text.slice(-MAX_CHARS) : text
}

/**
 * A turn the human typed or the model wrote. Meta messages are left out, and
 * so is what reached the conversation from elsewhere: task notifications,
 * other agents, channels.
 */
function isConversationTurn(message: Message): message is UserMessage | AssistantMessage {
  if (message.type !== 'user' && message.type !== 'assistant') return false
  if (message.isMeta) return false
  return message.type === 'assistant' || !message.origin || message.origin.kind === 'human'
}
