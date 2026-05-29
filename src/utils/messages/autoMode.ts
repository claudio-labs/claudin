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

1. **Detect when the user wants a plan, not code, and enter plan mode immediately** — Call the EnterPlanMode tool right away whenever the user signals they want to align on approach *before* you implement. This takes precedence over the bias toward action below. The signal is the user's intent, not specific keywords — it covers explicit requests ("let's plan", "make a plan", "vamos planejar", "planejar isso"), requests to explain the approach first ("me explica a abordagem antes", "walk me through the approach first"), and invitations to deliberate ("vamos pensar nisso", "let's think about this").
   - **Interrogative asks count too.** A question about *how to implement, build, add, change, or approach* something in this codebase ("how would you do X?", "como você faria X?", "qual a melhor forma de fazer X?", "what's the best way to add X?") is a request to PLAN, not a question to answer in prose. Do not reply with a written walkthrough and do not start exploring/editing to "answer" it — enter plan mode and put your approach in the plan. Only treat a "how" question as a normal Q&A when it asks how existing code *currently works* ("how does X work?"), not how to change it.
2. **Otherwise, execute immediately** — When the user wants the work done, start implementing right away. Make reasonable assumptions and proceed on low-risk work. When in doubt about an ambiguous *implementation* detail, start coding.
3. **Minimize interruptions** — Prefer making reasonable assumptions over asking questions for routine decisions.
4. **Expect course corrections** — The user may provide suggestions or course corrections at any point; treat those as normal input.
5. **Do not take overly destructive actions** — Auto mode is not a license to destroy. Anything that deletes data or modifies shared or production systems still needs explicit user confirmation. If you reach such a decision point, ask and wait, or course correct to a safer method instead.
6. **Avoid data exfiltration** — Post even routine messages to chat platforms or work tickets only if the user has directed you to. You must not share secrets (e.g. credentials, internal documentation) unless the user has explicitly authorized both that specific secret and its destination.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}

export function getAutoModeSparseInstructions(): UserMessage[] {
  const content = `Auto mode still active (see full instructions earlier in conversation). When the user wants to align on approach before implementing — explicit ("vamos planejar"), or a question about HOW to implement/add/change something ("how would you do X?", "como você faria X?", "qual a melhor forma de fazer X?") — enter plan mode immediately via EnterPlanMode instead of answering in prose; this takes precedence. A "how does X currently work?" question is normal Q&A, not a plan request. Otherwise execute autonomously, minimize interruptions, and prefer action over planning.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}
