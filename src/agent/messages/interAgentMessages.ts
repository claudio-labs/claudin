import { AGENT_MESSAGE_TAG } from 'src/shared/constants/xml.js'
import { parseXmlEnvelope } from 'src/shared/data/xml.js'
import type { MessageOrigin } from 'src/shared/types/message.js'

/** How the transcript shows a message one agent sent another. */
export type InterAgentMessageView = {
  /** Who wrote it. */
  sender: string
  /** What the sender is to this conversation, shown dimmed after the line. */
  relation: string
  body: string
}

/**
 * Recognise the envelopes SendMessage delivers and say how to show them. Null
 * for anything else, including prose that merely mentions a tag — the
 * envelope has to open the message.
 */
export function describeInterAgentMessage(
  text: string,
): InterAgentMessageView | null {
  const agent = parseXmlEnvelope(text, AGENT_MESSAGE_TAG)
  if (agent) {
    return {
      sender: agent.attrs.description ?? agent.attrs.from ?? 'agent',
      relation: 'background agent',
      body: agent.body,
    }
  }
  return null
}

export function isInterAgentMessage(text: string): boolean {
  return describeInterAgentMessage(text) !== null
}

/** Whether a queued command's text was written by another agent, not the user. */
export function isAgentAuthored(origin: MessageOrigin | undefined): boolean {
  return origin?.kind === 'subagent'
}
