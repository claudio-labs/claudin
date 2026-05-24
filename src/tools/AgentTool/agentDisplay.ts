/**
 * Shared utilities for displaying agent information.
 * Used by both the CLI `claude agents` handler and the interactive `/agents` command.
 */

import {
  checkIsClaudeNativeProvider,
  getDefaultSubagentModel,
} from '../../utils/model/agent.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { logError } from '../../utils/log.js'
import {
  getSourceDisplayName,
  type SettingSource,
} from '../../utils/settings/constants.js'
import {
  getAvailableModelIdsForActiveProfile,
  resolveModelOverride,
} from './agentModelResolver.js'
import type { AgentDefinition } from './loadAgentsDir.js'

type AgentSource = SettingSource | 'built-in' | 'plugin'

export type AgentSourceGroup = {
  label: string
  source: AgentSource
}

/**
 * Ordered list of agent source groups for display.
 * Both the CLI and interactive UI should use this to ensure consistent ordering.
 */
export const AGENT_SOURCE_GROUPS: AgentSourceGroup[] = [
  { label: 'User agents', source: 'userSettings' },
  { label: 'Project agents', source: 'projectSettings' },
  { label: 'Local agents', source: 'localSettings' },
  { label: 'Managed agents', source: 'policySettings' },
  { label: 'Plugin agents', source: 'plugin' },
  { label: 'CLI arg agents', source: 'flagSettings' },
  { label: 'Built-in agents', source: 'built-in' },
]

export type ResolvedAgent = AgentDefinition & {
  overriddenBy?: AgentSource
}

/**
 * Annotate agents with override information by comparing against the active
 * (winning) agent list. An agent is "overridden" when another agent with the
 * same type from a higher-priority source takes precedence.
 *
 * Also deduplicates by (agentType, source) to handle git worktree duplicates
 * where the same agent file is loaded from both the worktree and main repo.
 */
export function resolveAgentOverrides(
  allAgents: AgentDefinition[],
  activeAgents: AgentDefinition[],
): ResolvedAgent[] {
  const activeMap = new Map<string, AgentDefinition>()
  for (const agent of activeAgents) {
    activeMap.set(agent.agentType, agent)
  }

  const seen = new Set<string>()
  const resolved: ResolvedAgent[] = []

  // Iterate allAgents, annotating each with override info from activeAgents.
  // Deduplicate by (agentType, source) to handle git worktree duplicates.
  for (const agent of allAgents) {
    const key = `${agent.agentType}:${agent.source}`
    if (seen.has(key)) continue
    seen.add(key)

    const active = activeMap.get(agent.agentType)
    const overriddenBy =
      active && active.source !== agent.source ? active.source : undefined
    resolved.push({ ...agent, overriddenBy })
  }

  return resolved
}

/**
 * Resolve the display model string for an agent.
 *
 * Mirrors `getAgentModel` (utils/model/agent.ts) so `/agents` never shows a
 * model the runtime won't actually use:
 *  - Non-Claude-native provider + bare Claude family alias → `inherit`
 *    (runtime falls back to inherit; raw alias would be unreachable).
 *  - Claude-native provider + alias excluded by the user's `availableModels`
 *    allowlist → `inherit` (runtime would 403/400; showing the alias would
 *    promise something the user has explicitly forbidden).
 *  - Non-alias model IDs (e.g. `glm-5.1`) are delegated to
 *    `resolveModelOverride`, which returns `'inherit'` for orphans not present
 *    on the active profile.
 */
export function resolveAgentModelDisplay(
  agent: AgentDefinition,
): string | undefined {
  const model = agent.model || getDefaultSubagentModel()
  if (!model) return undefined
  if (model === 'inherit') return 'inherit'
  if (model === 'haiku' || model === 'sonnet' || model === 'opus') {
    try {
      if (!checkIsClaudeNativeProvider()) return 'inherit'
      if (!isModelAllowed(model)) return 'inherit'
    } catch (e) {
      // Provider/allowlist probes read config; on failure, fall through to
      // showing the raw value rather than guessing wrong.
      logError(e)
    }
    return model
  }
  // Non-alias model ID: collapse to 'inherit' if it's not on the active
  // profile (orphan), matching how project-scoped overrides are resolved.
  // Pass deps explicitly so the lookup is rebound on each call (the default
  // arg in resolveModelOverride captures at module-load time, which prevents
  // test mocks from taking effect).
  return (
    resolveModelOverride(model, `agent:${agent.agentType}`, {
      getAvailableModelIds: getAvailableModelIdsForActiveProfile,
      logDebug: () => {},
      logErr: logError,
    }) ?? model
  )
}

/**
 * Get a human-readable label for the source that overrides an agent.
 * Returns lowercase, e.g. "user", "project", "managed".
 */
export function getOverrideSourceLabel(source: AgentSource): string {
  return getSourceDisplayName(source).toLowerCase()
}

/**
 * Compare agents alphabetically by name (case-insensitive).
 */
export function compareAgentsByName(
  a: AgentDefinition,
  b: AgentDefinition,
): number {
  return a.agentType.localeCompare(b.agentType, undefined, {
    sensitivity: 'base',
  })
}
