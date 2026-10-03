/**
 * Subagent transcript loading + extraction.
 *
 * Extracted in Wave 2 of the 11c sessionStorage split. The `getAgentTranscript`
 * reader and the `loadSubagentTranscripts` fan-out both delegate to
 * `loadTranscriptFile` (resume/transcriptLoad.ts) but are conceptually a
 * separate concern: agent-scoped vs session-scoped chain reconstruction.
 */
import type { Dirent } from 'fs'
import { readdir } from 'fs/promises'
import { join } from 'path'

import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
} from 'src/platform/bootstrap/state.js'
import { type AgentId, asAgentId } from 'src/shared/types/ids.js'
import type { Message } from 'src/shared/types/message.js'
import { uniq } from 'src/shared/data/array.js'
import { isENOENT } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import {
  buildConversationChain,
  findLatestMessage,
} from 'src/sessions/resume/chain.js'
import { loadTranscriptFile } from 'src/sessions/resume/transcriptLoad.js'
import { getAgentTranscriptPath, getProjectDir } from 'src/sessions/pure/paths.js'
import { removeExtraFields } from 'src/sessions/pure/logging.js'

const AGENT_TRANSCRIPT_NAME = /^agent-(.+)\.jsonl$/
const PROGRESS_FROM_AGENTS: ReadonlySet<unknown> = new Set(['agent_progress', 'skill_progress'])

/**
 * Get the transcript for a specific agent
 */
export async function getAgentTranscript(agentId: AgentId): Promise<{
  messages: Message[]
} | null> {
  const { messages } = await loadTranscriptFile(getAgentTranscriptPath(agentId))
  const ownEntries = [...messages.values()].filter(entry => entry.isSidechain && entry.agentId === agentId)
  const parentsWithin = new Set(ownEntries.map(entry => entry.parentUuid))
  const tip = findLatestMessage(ownEntries, entry => !parentsWithin.has(entry.uuid))
  if (!tip) return null
  const ownChain = buildConversationChain(messages, tip).filter(entry => entry.agentId === agentId)
  return { messages: removeExtraFields(ownChain) }
}

export function extractAgentIdsFromMessages(messages: Message[]): string[] {
  const found: string[] = []
  for (const message of messages) {
    if (message.type !== 'progress') continue
    const data: unknown = message.data
    if (typeof data !== 'object' || data === null) continue
    const { type, agentId } = data as { type?: unknown; agentId?: unknown }
    if (PROGRESS_FROM_AGENTS.has(type) && typeof agentId === 'string') found.push(agentId)
  }
  return uniq(found)
}

export function extractTeammateTranscriptsFromTasks(tasks: {
  [taskId: string]: {
    type: string
    identity?: { agentId: string }
    messages?: Message[]
  }
}): { [agentId: string]: Message[] } {
  const byAgent: { [agentId: string]: Message[] } = {}
  for (const task of Object.values(tasks)) {
    const agentId = task.identity?.agentId
    if (task.type !== 'in_process_teammate' || !agentId || !task.messages?.length) continue
    byAgent[agentId] = task.messages
  }
  return byAgent
}

export async function loadSubagentTranscripts(
  agentIds: string[],
): Promise<{ [agentId: string]: Message[] }> {
  const loaded = await Promise.all(
    agentIds.map(async agentId => [agentId, await getAgentTranscript(asAgentId(agentId))] as const),
  )
  const byAgent: { [agentId: string]: Message[] } = {}
  for (const [agentId, transcript] of loaded) {
    if (transcript && transcript.messages.length > 0) byAgent[agentId] = transcript.messages
  }
  return byAgent
}

export async function loadAllSubagentTranscriptsFromDisk(): Promise<{
  [agentId: string]: Message[]
}> {
  const sessionDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  const subagentsDir = join(sessionDir, getSessionId(), 'subagents')
  let entries: Dirent[]
  try {
    entries = await readdir(subagentsDir, { withFileTypes: true })
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return {}
  }
  const agentIds = entries.flatMap(entry => {
    const id = entry.isFile() ? AGENT_TRANSCRIPT_NAME.exec(entry.name)?.[1] : undefined
    return id ? [id] : []
  })
  return loadSubagentTranscripts(agentIds)
}
