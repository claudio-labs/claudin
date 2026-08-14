import { getGlobalConfig } from 'src/services/config/config.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logError } from 'src/utils/log.js'
import {
  getActiveProviderProfile,
  getProfileModelOptions,
} from 'src/services/api/providerProfiles.js'

/**
 * Returns the set of model IDs available on the active provider profile,
 * or `undefined` if the profile has no enumerated list (e.g. catch-all
 * OpenAI-compatible) — in which case callers should skip the orphan check.
 */
export function getAvailableModelIdsForActiveProfile():
  | Set<string>
  | undefined {
  const profile = getActiveProviderProfile(getGlobalConfig())
  if (!profile) return undefined
  const profileOptions = getProfileModelOptions(profile)
  if (profileOptions.length === 0) return undefined
  return new Set(
    profileOptions
      .map(o => o.value)
      .filter((v): v is string => typeof v === 'string' && v.length > 0),
  )
}

/**
 * `'inherit'` plus the Claude family aliases are resolved
 * provider-agnostically by `getAgentModel`, so they bypass the
 * "is this model id known to the active profile?" check.
 */
export function isAliasOrInherit(value: string): boolean {
  return (
    value === 'inherit' ||
    value === 'haiku' ||
    value === 'sonnet' ||
    value === 'opus'
  )
}

export type ResolveOverrideDeps = {
  getAvailableModelIds: () => Set<string> | undefined
  logDebug: (msg: string) => void
  logErr: (e: unknown) => void
}

export const defaultResolveOverrideDeps: ResolveOverrideDeps = {
  getAvailableModelIds: getAvailableModelIdsForActiveProfile,
  logDebug: logForDebugging,
  logErr: logError,
}

/**
 * Resolve a raw override string against the active provider's model list.
 * Returns:
 *  - `undefined` when the override is missing/blank (caller should skip)
 *  - `'inherit'` when the override is an orphan (not on active profile)
 *  - the trimmed override value otherwise
 *
 * `contextLabel` is used only in the debug log so the orphan source is
 * identifiable (e.g. `built-in:Explore`, `project:product-strategist`).
 */
export function resolveModelOverride(
  rawOverride: string | undefined,
  contextLabel: string,
  deps: ResolveOverrideDeps = defaultResolveOverrideDeps,
): string | undefined {
  if (!rawOverride) return undefined
  const override = rawOverride.trim()
  if (!override) return undefined
  if (isAliasOrInherit(override)) return override

  let availableModelIds: Set<string> | undefined
  try {
    availableModelIds = deps.getAvailableModelIds()
  } catch (e) {
    deps.logErr(e)
    return override
  }
  if (!availableModelIds) return override
  if (availableModelIds.has(override)) return override

  deps.logDebug(
    `Dropping orphaned model override ${contextLabel}=${override} ` +
      `(not available on active provider); falling back to inherit.`,
  )
  return 'inherit'
}
