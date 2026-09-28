/**
 * The resume's coordinator-mode effects. They exist only in builds with
 * COORDINATOR_MODE; in the others each one does nothing.
 */
import { feature } from 'bun:bundle'

import { createSystemMessage } from 'src/agent/messages/messages.js'
import type {
  ResumeContext,
  ResumedConversation,
  SessionMode,
  SessionModeApi,
} from 'src/sessions/lifecycle/restore/types.js'
import { saveMode } from 'src/sessions/sessionStorage.js'
import {
  type AgentDefinition,
  type AgentDefinitionsResult,
  getActiveAgentsFromList,
  getAgentDefinitionsWithOverrides,
} from 'src/tools/AgentTool/loadAgentsDir.js'

/**
 * Put the process in the resumed session's mode. True when that switched the
 * mode, in which case the warning saying so joins the conversation.
 */
export function enterSessionMode(
  conversation: Pick<ResumedConversation, 'messages' | 'mode'>,
  modeApi: SessionModeApi | null,
): boolean {
  if (!feature('COORDINATOR_MODE')) return false
  const warning = modeApi?.matchSessionMode(conversation.mode)
  if (!warning) return false
  conversation.messages.push(createSystemMessage(warning, 'warning'))
  return true
}

export function recordSessionMode(modeApi: SessionModeApi | null): void {
  if (!feature('COORDINATOR_MODE')) return
  saveMode(currentMode(modeApi))
}

export function currentMode(modeApi: SessionModeApi | null): SessionMode {
  return modeApi?.isCoordinatorMode() ? 'coordinator' : 'normal'
}

/**
 * The agent definitions the resumed session starts with. A mode switch
 * changes which agents exist, so they are loaded again past the loader's memo.
 */
export async function agentDefinitionsForMode(
  modeSwitched: boolean,
  context: Pick<ResumeContext, 'agentDefinitions' | 'currentCwd' | 'cliAgents'>,
): Promise<AgentDefinitionsResult> {
  if (!modeSwitched) return context.agentDefinitions
  getAgentDefinitionsWithOverrides.cache.clear?.()
  const reloaded = await getAgentDefinitionsWithOverrides(context.currentCwd)
  return withCliAgents(reloaded, context.cliAgents)
}

/** The loaded agents plus those given on the command line, with the active set worked out again. */
export function withCliAgents(
  loaded: AgentDefinitionsResult,
  cliAgents: readonly AgentDefinition[],
): AgentDefinitionsResult {
  const allAgents = [...loaded.allAgents, ...cliAgents]
  return { ...loaded, allAgents, activeAgents: getActiveAgentsFromList(allAgents) }
}
