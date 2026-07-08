/**
 * Bridge to the agent registry, kept separate from loadWorkflows.ts so the pure
 * parse/validate helpers stay loadable under `bun test` without pulling the
 * agent-loading machinery (and, transitively, ink).
 */
import { getAgentDefinitionsWithOverrides } from 'src/tools/AgentTool/loadAgentsDir.js'

/** The set of agentTypes available in the given working directory. */
export async function getKnownAgentTypes(cwd: string): Promise<Set<string>> {
  const { allAgents } = await getAgentDefinitionsWithOverrides(cwd)
  return new Set(allAgents.map(a => a.agentType))
}
