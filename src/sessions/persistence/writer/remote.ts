/**
 * The pure parts of the remote side: what a CCR v2 event looks like, which
 * agent ids may name a file, and the options handed to the internal writer.
 */
import { isCompactBoundaryMessage } from 'src/agent/messages/messages.js'
import type { TranscriptMessage } from 'src/shared/types/logs.js'

export type InternalEvent = { payload: Record<string, unknown>; agent_id?: string }

export type InternalEventOptions = { isCompaction?: boolean; agentId?: string }

/** The worker's signal that another process owns the session now; it must reach the caller. */
const EPOCH_MISMATCH_MESSAGE = 'CCRClient: Epoch mismatch (409)'

export function isEpochMismatch(error: unknown): boolean {
  return error instanceof Error && error.message === EPOCH_MISMATCH_MESSAGE
}

// Real ids are `a` plus hex. Anything that could climb out of `subagents/`
// or name a different file is refused (finding 9).
const SAFE_AGENT_ID = /^[A-Za-z0-9_@-][A-Za-z0-9_@.-]*$/

export function isSafeAgentId(agentId: string | undefined): agentId is string {
  return agentId !== undefined && agentId.length <= 128 && SAFE_AGENT_ID.test(agentId)
}

/** Subagent payloads per agent, each list in arrival order; unusable ids are dropped. */
export function groupByAgent(events: readonly InternalEvent[]): Map<string, Record<string, unknown>[]> {
  const groups = new Map<string, Record<string, unknown>[]>()
  for (const { payload, agent_id } of events) {
    if (!isSafeAgentId(agent_id)) continue
    const group = groups.get(agent_id)
    if (group) group.push(payload)
    else groups.set(agent_id, [payload])
  }
  return groups
}

export function internalEventOptions(line: TranscriptMessage): InternalEventOptions {
  const options: InternalEventOptions = {}
  if (isCompactBoundaryMessage(line)) options.isCompaction = true
  if (line.agentId) options.agentId = line.agentId
  return options
}
