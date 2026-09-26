import {
  AGENT_MESSAGE_TAG,
  CROSS_SESSION_MESSAGE_TAG,
  CROSS_SESSION_NOTICE_TAG,
} from 'src/shared/constants/xml.js'
import { parseXmlEnvelope } from 'src/shared/data/xml.js'
import type { MessageOrigin } from 'src/shared/types/message.js'
import { MAIN_ADDRESS } from 'src/tools/SendMessageTool/constants.js'

/** How the transcript shows a message one agent sent another. */
export type InterAgentMessageView = {
  /** A notice is the harness speaking, and is shown as one line. */
  kind: 'message' | 'notice'
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
      kind: 'message',
      sender: agent.attrs.description ?? agent.attrs.from ?? 'agent',
      relation: agent.attrs.from === MAIN_ADDRESS ? 'main conversation' : 'background agent',
      body: agent.body,
    }
  }
  const peer = parseXmlEnvelope(text, CROSS_SESSION_MESSAGE_TAG)
  if (peer) {
    const via = peer.attrs['from-agent']
    return {
      kind: 'message',
      sender: peer.attrs['from-name'] ?? 'another session',
      relation: via ? `another session, from its agent ${via}` : 'another session',
      body: peer.body,
    }
  }
  const notice = parseXmlEnvelope(text, CROSS_SESSION_NOTICE_TAG)
  if (notice) {
    return {
      kind: 'notice',
      sender: notice.attrs.about ?? 'another session',
      relation: 'notice',
      body: notice.body,
    }
  }
  return null
}

export function isInterAgentMessage(text: string): boolean {
  return describeInterAgentMessage(text) !== null
}

/** Whether a queued command's text was written by another agent, not the user. */
export function isAgentAuthored(origin: MessageOrigin | undefined): boolean {
  return (
    origin?.kind === 'agent' ||
    origin?.kind === 'subagent' ||
    origin?.kind === 'peer' ||
    origin?.kind === 'peer-notice'
  )
}

/**
 * Who wrote a message queued for a running agent. SendMessage always delivers
 * one inside an agent-message envelope; anything else was typed by the user
 * into that agent's transcript view.
 */
export function pendingMessageOrigin(text: string): MessageOrigin {
  const envelope = parseXmlEnvelope(text, AGENT_MESSAGE_TAG)
  if (!envelope) return { kind: 'human' }
  return { kind: 'agent', name: envelope.attrs.from ?? 'agent' }
}

/**
 * The line an agent's completion notice carries when messages reached it
 * after its last tool round — otherwise they vanish without anyone knowing.
 * They stay queued on the task, and a resume while it is still listed reads
 * them. Undefined when nothing is unread.
 */
export function describeUnreadMessages(pending: readonly string[]): string | undefined {
  if (pending.length === 0) return undefined
  const senders = [
    ...new Set(
      pending.map(text => {
        const origin = pendingMessageOrigin(text)
        return origin.kind === 'agent' ? origin.name : 'the user'
      }),
    ),
  ]
  const count = pending.length === 1 ? '1 message' : `${pending.length} messages`
  return `${count} reached it after its last tool round and went unread, from: ${senders.join(', ')}. A SendMessage to it resumes it, and it reads them then.`
}
