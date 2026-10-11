import type { Tools } from 'src/tools/Tool.js'
import { resolveAgentTools, type ResolvedAgentTools } from 'src/tools/AgentTool/agentToolUtils.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'

/** Which filter picks an agent's tools: the sub-agent one, or the background allowlist. */
export type ToolPool = 'sync' | 'async'

/**
 * The tools one run of an agent gets. `pool` is the filter that picks them —
 * normally how the agent runs, but a resume always runs in the background, and
 * filtering it as a background agent dropped every tool outside the async
 * allowlist that its first run had: two resumed agents called Git and got "No
 * such tool available" (2026-10-05..11 census). So a resume keeps its first
 * run's pool, recorded in the agent's metadata.
 *
 * A background run still never holds Agent, whatever its pool: that block is
 * about recursion, not about which filter ran.
 */
export function resolveRunTools(
  agentDefinition: Pick<AgentDefinition, 'tools' | 'disallowedTools' | 'source' | 'permissionMode'>,
  availableTools: Tools,
  runsAsync: boolean,
  pool: ToolPool,
): ResolvedAgentTools {
  const resolved = resolveAgentTools(agentDefinition, availableTools, pool === 'async')
  if (!runsAsync || pool === 'async') return resolved
  return { ...resolved, resolvedTools: resolved.resolvedTools.filter(tool => tool.name !== AGENT_TOOL_NAME) }
}
