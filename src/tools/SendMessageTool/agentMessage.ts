import { AGENT_MESSAGE_TAG } from 'src/shared/constants/xml.js'
import { formatXmlEnvelope } from 'src/shared/data/xml.js'

/**
 * What a background agent's `SendMessage({to: "main"})` delivers to the main
 * conversation. The trailer rides along on both delivery paths — the mid-turn
 * attachment and the idle turn — so the receiving model learns who wrote it
 * and how to answer without a system-prompt section paying for that on every
 * request. `from` is the address to answer to; `description` names an agent
 * that has no name for the transcript row.
 */
export function formatAgentMessage({
  from,
  description,
  body,
}: {
  from: string
  description?: string
  body: string
}): string {
  const envelope = formatXmlEnvelope(AGENT_MESSAGE_TAG, { from, description }, body)
  return `${envelope}\nFrom your background agent, not from your user. To answer it, call SendMessage with to: ${JSON.stringify(from)}.`
}
