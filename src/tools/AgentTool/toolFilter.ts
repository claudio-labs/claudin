import { toolMatchesName, type Tools } from 'src/tools/Tool.js'
import { resolveAgentTools, type ResolvedAgentTools } from 'src/tools/AgentTool/agentToolUtils.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'

/**
 * Which filter picks an agent's tools out of the assembled pool: the
 * sub-agent one, or the background allowlist (`ASYNC_AGENT_ALLOWED_TOOLS`).
 */
export type ToolFilter = 'sync' | 'async'

/**
 * The tools one run of an agent gets. The filter normally follows how the
 * agent runs, but a resume always runs in the background, and filtering it as
 * a background agent dropped every tool outside the allowlist that its first
 * run had: two resumed agents called Git and got "No such tool available"
 * (2026-10-05..11 census). So a resume keeps its first run's filter, recorded
 * in the agent's metadata — and so does a foreground run sent to the
 * background mid-task.
 *
 * A background run still never holds Agent, whatever its filter: that block
 * is about recursion, not about which filter ran. Kept out of
 * agentToolUtils.ts, which has a third of its lines covered.
 */
export function resolveRunTools(
  agentDefinition: Pick<AgentDefinition, 'tools' | 'disallowedTools' | 'source' | 'permissionMode'>,
  availableTools: Tools,
  runsAsync: boolean,
  filter: ToolFilter,
): ResolvedAgentTools {
  const resolved = resolveAgentTools(agentDefinition, availableTools, filter === 'async')
  if (!runsAsync || filter === 'async') return resolved
  return { ...resolved, resolvedTools: resolved.resolvedTools.filter(tool => !toolMatchesName(tool, AGENT_TOOL_NAME)) }
}
