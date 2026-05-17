import type { UserMessage } from '../../types/message.js'
import { createUserMessage } from './factories.js'
import { wrapMessagesInSystemReminder } from './text.js'

export function getAutoModeInstructions(attachment: {
  reminderType: 'full' | 'sparse'
}): UserMessage[] {
  if (attachment.reminderType === 'sparse') {
    return getAutoModeSparseInstructions()
  }
  return getAutoModeFullInstructions()
}

export function getAutoModeFullInstructions(): UserMessage[] {
  const content = `## Auto Mode Active

Auto mode is active. The user chose continuous, autonomous execution. You should:

1. **Execute immediately** — Start implementing right away. Make reasonable assumptions and proceed on low-risk work.
2. **Minimize interruptions** — Prefer making reasonable assumptions over asking questions for routine decisions.
3. **Prefer action over planning** — But if the user asks to plan (e.g. "let's plan", "make a plan", "vamos montar um plano", "vamos planejar", "planejar isso"), enter plan mode immediately. When in doubt about ambiguous tasks, start coding.
4. **Expect course corrections** — The user may provide suggestions or course corrections at any point; treat those as normal input.
5. **Do not take overly destructive actions** — Auto mode is not a license to destroy. Anything that deletes data or modifies shared or production systems still needs explicit user confirmation. If you reach such a decision point, ask and wait, or course correct to a safer method instead.
6. **Avoid data exfiltration** — Post even routine messages to chat platforms or work tickets only if the user has directed you to. You must not share secrets (e.g. credentials, internal documentation) unless the user has explicitly authorized both that specific secret and its destination.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}

export function getAutoModeSparseInstructions(): UserMessage[] {
  const content = `Auto mode still active (see full instructions earlier in conversation). Execute autonomously, minimize interruptions, prefer action over planning — but if the user asks for a plan, enter plan mode immediately.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}
