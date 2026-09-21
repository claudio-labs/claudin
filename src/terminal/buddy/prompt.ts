import type { Message } from 'src/shared/types/message.js'
import type { Attachment } from 'src/agent/attachments/attachments.js'
import type { AgentId } from 'src/shared/types/ids.js'
import { getGlobalConfig } from 'src/platform/config/config.js'
import { getCompanion } from 'src/terminal/buddy/companion.js'
import { isBuddyEnabled } from 'src/terminal/buddy/feature.js'

export function companionIntroText(name: string, species: string): string {
  return `# Companion

A small ${species} named ${name} sits beside the user's input box and occasionally comments in a speech bubble. You're not ${name} — it's a separate watcher.

When the user addresses ${name} directly (by name), its bubble will answer. Your job in that moment is to stay out of the way: respond in ONE line or less, or just answer any part of the message meant for you. Don't explain that you're not ${name} — they know. Don't narrate what ${name} might say — the bubble handles that.`
}

export function getCompanionIntroAttachment(
  messages: Message[] | undefined,
  agentId: AgentId | undefined,
): Attachment[] {
  // Main thread only. Every line of this text is addressed to the REPL — a
  // sprite beside the user's input box, a bubble that answers when the user
  // says the name, and a cap of ONE line on the reply. A sub-agent has no
  // input box and its reply is a report to its parent, so for a child this is
  // a response-length instruction merged into a tool_result turn (#227).
  if (agentId) return []
  if (!isBuddyEnabled()) return []
  const companion = getCompanion()
  if (!companion || getGlobalConfig().companionMuted) return []

  // Skip if already announced for this companion.
  for (const msg of messages ?? []) {
    if (msg.type !== 'attachment') continue
    if (msg.attachment.type !== 'companion_intro') continue
    if (msg.attachment.name === companion.name) return []
  }

  return [
    {
      type: 'companion_intro',
      name: companion.name,
      species: companion.species,
    },
  ]
}
