import type { LocalCommandCall } from 'src/shared/types/command.js'
import { clearConversation } from 'src/commands/clear/conversation.js'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import { closeInstanceSession } from 'src/sessions/instanceSessions.js'

// A clear ends the session it leaves: it drops out of this instance's
// "open here" group of the session list (/new asks instead).
export const call: LocalCommandCall = async (_, context) => {
  const previous = getSessionId()
  await clearConversation(context)
  closeInstanceSession(previous)
  return { type: 'text', value: '' }
}
