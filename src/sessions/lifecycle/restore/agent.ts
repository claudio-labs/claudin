/**
 * The agent a resumed session runs as, and how its name and color show.
 */
import {
  getMainLoopModelOverride,
  setMainLoopModelOverride,
  setMainThreadAgentType,
} from 'src/platform/bootstrap/state.js'
import { parseUserSpecifiedModel } from 'src/providers/model/model.js'
import { logForDebugging } from 'src/shared/debug.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import type { AgentColorName } from 'src/tools/AgentTool/agentColorManager.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from 'src/tools/AgentTool/loadAgentsDir.js'

export type RestoredAgent = {
  agentDefinition: AgentDefinition | undefined
  agentType: string | undefined
}

/** An agent whose model is this runs on the main loop's model. */
const MAIN_LOOP_MODEL = 'inherit'
/** How a color the user reset is stored. */
const RESET_COLOR = 'default'

export function restoreAgentFromSession(
  agentSetting: string | undefined,
  currentAgentDefinition: AgentDefinition | undefined,
  agentDefinitions: AgentDefinitionsResult,
): RestoredAgent {
  // An agent picked on this command line outranks the one the session ran as,
  // and leaves the main-thread agent and the model as they are.
  if (currentAgentDefinition) return { agentDefinition: currentAgentDefinition, agentType: undefined }
  // Only an agent in effect may come back: a shadowed definition must not.
  const resumed = stillActive(agentSetting, agentDefinitions.activeAgents)
  // Cleared when there is none, so that no earlier session's agent stays on.
  setMainThreadAgentType(resumed?.agentType)
  if (resumed) adoptAgentModel(resumed.model)
  return { agentDefinition: resumed, agentType: resumed?.agentType }
}

/** The agent the session ran as, when it is among the agents in effect. */
function stillActive(agentType: string | undefined, activeAgents: AgentDefinition[]): AgentDefinition | undefined {
  if (!agentType) return undefined
  const active = activeAgents.find(candidate => candidate.agentType === agentType)
  if (!active) {
    logForDebugging(`The resumed session ran as agent "${agentType}", which is not active now; resuming without it`)
  }
  return active
}

/** The agent's model becomes the session's, unless the user already chose one. */
function adoptAgentModel(model: string | undefined): void {
  if (getMainLoopModelOverride() !== undefined) return
  if (!model || model === MAIN_LOOP_MODEL) return
  setMainLoopModelOverride(parseUserSpecifiedModel(model))
}

export function computeStandaloneAgentContext(
  agentName: string | undefined,
  agentColor: string | undefined,
): AppState['standaloneAgentContext'] | undefined {
  if (!agentName && !agentColor) return undefined
  return { name: agentName ?? '', color: shownAgentColor(agentColor) }
}

/** The color an agent is shown in; a reset color shows as none. */
export function shownAgentColor(color: string | undefined): AgentColorName | undefined {
  if (!color || color === RESET_COLOR) return undefined
  // Written by this CLI from its own palette; a transcript is not re-validated.
  return color as AgentColorName
}
