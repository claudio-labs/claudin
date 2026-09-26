import { AGENT_MESSAGE_TAG } from 'src/shared/constants/xml.js'
import { formatXmlEnvelope } from 'src/shared/data/xml.js'
import { MAIN_ADDRESS } from 'src/tools/SendMessageTool/constants.js'

/**
 * What one agent's SendMessage delivers to another of the same conversation:
 * a background agent writing to "main", main writing to one of its agents,
 * or two agents writing to each other. The trailer rides along on every
 * delivery path — the mid-turn attachment, the idle turn, a resume — so the
 * receiving model learns who wrote it and how to answer without a
 * system-prompt section paying for that on every request. `from` is the
 * address to answer to; `description` names an agent that has no name for
 * the transcript row.
 */
export function formatAgentMessage({
  from,
  description,
  body,
  to,
}: {
  from: string
  description?: string
  body: string
  /** The recipient's address; "main" when a background agent writes home. */
  to: string
}): string {
  const envelope = formatXmlEnvelope(AGENT_MESSAGE_TAG, { from, description }, body)
  const sender =
    to === MAIN_ADDRESS
      ? 'your background agent'
      : from === MAIN_ADDRESS
        ? 'the main conversation, which launched you'
        : 'another agent of this conversation'
  return `${envelope}\nFrom ${sender}, not from your user. To answer it, call SendMessage with to: ${JSON.stringify(from)}.`
}
