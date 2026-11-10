import {
  getGlobalConfig,
  saveGlobalConfig,
  type ProjectConfig,
} from 'src/platform/config/config.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from 'src/platform/settings/settings.js'
import {
  getAPIProvider,
  getAPIProviderForProfile,
} from 'src/providers/model/providers.js'
import { resolveProviderProfile } from 'src/providers/presets/activeProvider.js'
import { getProviderProfiles } from 'src/providers/presets/providerProfiles.js'

/**
 * The pins this migration moves. Exact match only, which is what makes it
 * idempotent: 'fable' is not a key. The Bedrock id ('anthropic.claude-fable-5-1')
 * is absent on purpose — it is never a first-party pin.
 */
const FABLE_5_1_PINS: ReadonlySet<string> = new Set([
  'claude-fable-5-1',
  'claude-fable-5-1[1m]',
])

/**
 * Pure. The alias a Fable 5.1 pin moves to, or undefined when `model` is not
 * one. The [1m] tag is dropped: Fable is 1M native, and parseUserSpecifiedModel
 * drops it from the alias anyway.
 */
export function rewriteFable51Pin(model: string | undefined): string | undefined {
  return model !== undefined && FABLE_5_1_PINS.has(model) ? 'fable' : undefined
}

/**
 * Pure. Returns a rewritten projects map, or null when no project pins Fable 5.1
 * under a first-party profile. A project pin is honored only under the profile
 * it was made with (`activeModelForProjectProfileId`), so that profile decides,
 * not whichever provider happens to be active while migrations run.
 */
export function rewriteFable51InProjects(
  projects: Record<string, ProjectConfig> | undefined,
  isFirstPartyPin: (profileId: string | undefined) => boolean,
): Record<string, ProjectConfig> | null {
  if (!projects) {
    return null
  }
  const stale = Object.entries(projects).filter(
    ([, project]) =>
      rewriteFable51Pin(project.activeModelForProject) !== undefined &&
      isFirstPartyPin(project.activeModelForProjectProfileId),
  )
  if (stale.length === 0) {
    return null
  }
  const out = { ...projects }
  for (const [path, project] of stale) {
    out[path] = {
      ...project,
      activeModelForProject: rewriteFable51Pin(project.activeModelForProject),
    }
  }
  return out
}

function isFirstPartyProfile(profileId: string | undefined): boolean {
  if (profileId === undefined) {
    return getAPIProvider() === 'firstParty'
  }
  const profile = getProviderProfiles().find(p => p.id === profileId)
  return (
    profile !== undefined &&
    getAPIProviderForProfile(resolveProviderProfile(profile)) === 'firstParty'
  )
}

/**
 * Move Claude Fable 5.1 pins to the 'fable' alias, which resolves to Fable 5.2.
 * Claude Code 2.1.322 does the same to `userSettings.model`, first party only;
 * this one also moves the per-project `/model` choice, Claudin's equivalent.
 *
 * First party only, like Claude Code: on Bedrock, Vertex and Foundry the alias
 * would resolve to a model the account may not have, so a 3P pin stays on 5.1.
 * Not touched, as in Claude Code: advisorModel, availableModels, modelOverrides
 * and agent frontmatter. The in-memory override is left alone too: migrations
 * run in the preAction hook, before setupAgent sets it from `--model`, so it
 * only ever holds an explicit choice.
 *
 * Runs after migrateFable5ToFable51, so a Fable 5 pin moves 5 → 5.1 → 'fable'
 * in one startup.
 */
export function migrateFable51ToFableAlias(): void {
  if (getAPIProvider() === 'firstParty') {
    const model = rewriteFable51Pin(getSettingsForSource('userSettings')?.model)
    if (model) {
      updateSettingsForSource('userSettings', { model })
    }
  }

  const projects = rewriteFable51InProjects(
    getGlobalConfig().projects,
    isFirstPartyProfile,
  )
  if (projects) {
    saveGlobalConfig(current => ({ ...current, projects }))
  }
}
