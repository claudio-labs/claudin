import type { LocalCommandCall } from 'src/types/command.js'
import { clearConversation } from 'src/commands/clear/conversation.js'

export const call: LocalCommandCall = async (_, context) => {
  await clearConversation(context)
  return { type: 'text', value: '' }
}
