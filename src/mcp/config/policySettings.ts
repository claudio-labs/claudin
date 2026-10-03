import { getInitialSettings, getSettingsForSource } from 'src/platform/settings/settings.js'
import { isRecord } from 'src/mcp/config/jsonFile.js'
import { compilePolicy, judgeServer, type PolicyLists, type PolicyVerdict } from 'src/mcp/config/policy.js'

/** Read from the managed policy alone: the flag in a user's own settings does nothing. */
export function shouldAllowManagedMcpServersOnly(): boolean {
  return getSettingsForSource('policySettings')?.allowManagedMcpServersOnly === true
}

/**
 * Denies merge from every enabled source, so users can block servers for
 * themselves. Allowlists merge too, unless the policy claims the allowlist.
 */
function resolvePolicyLists(): PolicyLists {
  const merged = getInitialSettings()
  const allow = shouldAllowManagedMcpServersOnly()
    ? getSettingsForSource('policySettings')?.allowedMcpServers
    : merged.allowedMcpServers
  return { allow, deny: merged.deniedMcpServers ?? [] }
}

export function judgeAgainstSettings(name: string, config: unknown): PolicyVerdict {
  return judgeServer(name, config, compilePolicy(resolvePolicyLists()))
}

export type PolicySplit<T> = { allowed: Record<string, T>; blocked: string[] }

/**
 * Splits a record by the policy, keeping allowed entries as the same objects
 * and blocked names in input order. `exemptSdk` lets in-process SDK servers
 * through unjudged.
 */
export function splitByPolicy<T>(configs: Record<string, T>, options: { exemptSdk: boolean }): PolicySplit<T> {
  const policy = compilePolicy(resolvePolicyLists())
  const split: PolicySplit<T> = { allowed: {}, blocked: [] }
  for (const [name, config] of Object.entries(configs)) {
    const exempt = options.exemptSdk && isRecord(config) && config.type === 'sdk'
    if (exempt || judgeServer(name, config, policy) === 'allowed') split.allowed[name] = config
    else split.blocked.push(name)
  }
  return split
}

/** The policy for callers handing in servers of any origin; SDK servers pass unjudged. */
export function filterMcpServersByPolicy<T>(configs: Record<string, T>): PolicySplit<T> {
  return splitByPolicy(configs, { exemptSdk: true })
}
