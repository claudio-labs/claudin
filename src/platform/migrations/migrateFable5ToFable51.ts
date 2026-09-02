import {
  getMainLoopModelOverride,
  setMainLoopModelOverride,
} from 'src/platform/bootstrap/state.js'
import {
  getGlobalConfig,
  saveGlobalConfig,
  type ProjectConfig,
} from 'src/platform/config/config.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from 'src/platform/settings/settings.js'
import type { SettingsJson } from 'src/platform/settings/types.js'

/**
 * Retired model IDs and what each becomes. Claude Fable 5.1 ships on every
 * platform Fable 5 did, so unlike the Opus/Sonnet migrations — which remap to
 * an alias whose target is provider-dependent — this one is safe to run
 * regardless of the active provider, and deliberately has no `firstParty` gate.
 * Vertex and Foundry use the bare first-party ID; only Bedrock prefixes it.
 */
const RETIRED_MODEL_IDS: ReadonlyMap<string, string> = new Map([
  ['claude-fable-5', 'claude-fable-5-1'],
  ['anthropic.claude-fable-5', 'anthropic.claude-fable-5-1'],
])

/**
 * Exact match only, never a prefix or a substring. That is what makes every
 * function here idempotent: 'claude-fable-5-1' is not a key, so a second pass
 * cannot turn it into 'claude-fable-5-1-1'.
 */
function rewriteModelId(value: string): string {
  return RETIRED_MODEL_IDS.get(value) ?? value
}

/**
 * A patch shaped for `updateSettingsForSource`, which deep-merges plain objects
 * (`mergeWith` in src/platform/settings/settings.ts) and treats an `undefined`
 * value at a key as DELETE that key.
 *
 * That distinction only matters for `modelOverrides`. Scalars overwrite and
 * arrays are replaced wholesale by the merge customizer, but writing just the
 * renamed override key would leave the retired one sitting beside it — both
 * live, and the retired one still winning for anyone who has not moved. So the
 * retired keys are emitted explicitly as `undefined`.
 */
export type Fable5SettingsPatch = Omit<
  Partial<SettingsJson>,
  'modelOverrides'
> & {
  modelOverrides?: Record<string, string | undefined>
}

/**
 * Pure. Returns the settings fields that need rewriting, or null when the
 * settings hold no reference to a retired ID.
 *
 * `modelOverrides` is the awkward one: its KEYS are canonical model IDs (the
 * values are provider-specific strings, typically Bedrock inference-profile
 * ARNs), so the rewrite happens on the key side.
 */
export function rewriteFable5InSettings(
  settings: SettingsJson | null,
): Fable5SettingsPatch | null {
  if (!settings) {
    return null
  }
  const patch: Fable5SettingsPatch = {}

  if (settings.model !== undefined) {
    const next = rewriteModelId(settings.model)
    if (next !== settings.model) {
      patch.model = next
    }
  }

  if (settings.advisorModel !== undefined) {
    const next = rewriteModelId(settings.advisorModel)
    if (next !== settings.advisorModel) {
      patch.advisorModel = next
    }
  }

  if (settings.availableModels) {
    const next = settings.availableModels.map(rewriteModelId)
    if (next.some((m, i) => m !== settings.availableModels?.[i])) {
      patch.availableModels = next
    }
  }

  if (settings.modelOverrides) {
    const entries = Object.entries(settings.modelOverrides)
    const retired = entries.filter(([key]) => RETIRED_MODEL_IDS.has(key))
    if (retired.length > 0) {
      patch.modelOverrides = {
        // Tombstones first, so the deep merge drops the old keys instead of
        // keeping both. Spread order does not matter — the two key sets are
        // disjoint — but reading order does.
        ...Object.fromEntries(retired.map(([key]) => [key, undefined])),
        ...Object.fromEntries(
          entries.map(([key, value]) => [rewriteModelId(key), value]),
        ),
      }
    }
  }

  return Object.keys(patch).length > 0 ? patch : null
}

/**
 * Pure. Returns a rewritten projects map, or null when no project pins a
 * retired ID. `activeModelForProject` is the per-project `/model` choice.
 */
export function rewriteFable5InProjects(
  projects: Record<string, ProjectConfig> | undefined,
): Record<string, ProjectConfig> | null {
  if (!projects) {
    return null
  }
  const entries = Object.entries(projects)
  const stale = entries.filter(
    ([, project]) =>
      project.activeModelForProject !== undefined &&
      RETIRED_MODEL_IDS.has(project.activeModelForProject),
  )
  if (stale.length === 0) {
    return null
  }
  const out = { ...projects }
  for (const [path, project] of stale) {
    out[path] = {
      ...project,
      activeModelForProject: rewriteModelId(project.activeModelForProject!),
    }
  }
  return out
}

/**
 * Migrate every persisted reference to Claude Fable 5 over to Claude Fable 5.1.
 *
 * Fable 5 was removed from ALL_MODEL_CONFIGS when 5.1 launched (2026-09-01).
 * A leftover 'claude-fable-5' string still reaches the API — the model is
 * retired from the picker, not from Anthropic — but it canonicalizes through
 * the legacy branch in firstPartyNameToCanonical and bills at the older 0.1x
 * cache-read rate ($1/MTok against 5.1's $0.25), so leaving it in place costs
 * the user money for nothing.
 *
 * Reads and writes `userSettings` specifically, never merged settings: reading
 * merged would re-run forever and would silently promote a project-scoped pin
 * to the global default. That read/write symmetry plus the exact-match rewrite
 * is what makes this idempotent without a completion flag — which matters,
 * because runMigrations' version gate is `!==`, so bumping the version re-runs
 * the whole set for every user.
 *
 * Known gap: an agent's `model:` frontmatter lives in a .md on disk and is out
 * of reach here. That is why firstPartyNameToCanonical and MODEL_COSTS keep a
 * 'claude-fable-5' entry — so such a pin still prices and labels correctly.
 */
export function migrateFable5ToFable51(): void {
  const patch = rewriteFable5InSettings(getSettingsForSource('userSettings'))
  if (patch) {
    // The cast carries the deletion sentinel through: SettingsJson types
    // modelOverrides as Record<string, string>, but updateSettingsForSource's
    // merge customizer reads an undefined value as "delete this key", which is
    // the only way to drop a renamed override. See Fable5SettingsPatch.
    updateSettingsForSource('userSettings', patch as SettingsJson)
  }

  const projects = rewriteFable5InProjects(getGlobalConfig().projects)
  if (projects) {
    saveGlobalConfig(current => ({ ...current, projects }))
  }

  // The in-memory override is already resolved by the time migrations run, so
  // rewriting settings alone would leave this session on the retired ID.
  const override = getMainLoopModelOverride()
  if (override) {
    const next = rewriteModelId(override)
    if (next !== override) {
      setMainLoopModelOverride(next)
    }
  }
}
