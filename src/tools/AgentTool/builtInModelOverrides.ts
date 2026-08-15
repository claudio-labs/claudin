import { getGlobalConfig } from 'src/platform/config/config.js'
import { logForDebugging } from 'src/shared/debug.js'
import { logError } from 'src/shared/log.js'
import {
  defaultResolveOverrideDeps,
  getAvailableModelIdsForActiveProfile,
  resolveModelOverride,
  type ResolveOverrideDeps,
} from 'src/tools/AgentTool/agentModelResolver.js'

type AgentLike = { agentType: string; model?: string }

/**
 * Storage key for a built-in agent's model override in
 * `~/.claudin/settings.json` → `agentModelOverrides`. Namespaced by source
 * so a user `.md` agent with the same name doesn't collide.
 */
export function builtInOverrideKey(agentType: string): string {
  return `built-in:${agentType}`
}

export type BuiltInModelOverrideDeps = {
  readConfig: () => { agentModelOverrides?: Record<string, string> }
} & ResolveOverrideDeps

const defaultDeps: BuiltInModelOverrideDeps = {
  readConfig: () => getGlobalConfig(),
  getAvailableModelIds: getAvailableModelIdsForActiveProfile,
  logDebug: logForDebugging,
  logErr: logError,
}

/**
 * Apply user-configured model overrides (~/.claudin/settings.json
 * `agentModelOverrides`) to built-in agent definitions. Only the `model`
 * field is overridden; everything else (prompt, tools, etc.) is preserved
 * so that the built-in's dynamic `getSystemPrompt` continues to work.
 *
 * Overrides are keyed `built-in:<agentType>` so a user-defined `.md` agent
 * that shadows a built-in (same name, different `source`) cannot
 * accidentally share the same override slot. Custom `.md` agents store
 * their per-user overrides in `<baseDir parent>/settings.agents.json`
 * instead (see `projectAgentOverrides.ts`).
 *
 * Orphan-validation, alias bypass, and trim behavior are delegated to
 * `resolveModelOverride` so the same rules apply to project/user agents.
 *
 * `deps` is for tests; production code should rely on the default.
 */
export function applyBuiltInModelOverrides<T extends AgentLike>(
  agents: T[],
  deps: BuiltInModelOverrideDeps = defaultDeps,
): T[] {
  let overrides: Record<string, string> | undefined
  try {
    overrides = deps.readConfig().agentModelOverrides
  } catch (e) {
    deps.logErr(e)
    return agents
  }
  if (!overrides) return agents
  const validOverrides = overrides

  return agents.map(agent => {
    const key = builtInOverrideKey(agent.agentType)
    const resolved = resolveModelOverride(validOverrides[key], key, {
      getAvailableModelIds: deps.getAvailableModelIds,
      logDebug: deps.logDebug,
      logErr: deps.logErr,
    })
    if (resolved === undefined) return agent
    return { ...agent, model: resolved }
  })
}

export { defaultResolveOverrideDeps }
