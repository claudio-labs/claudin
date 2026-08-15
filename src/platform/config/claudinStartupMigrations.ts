/**
 * Startup-time legacy migrations applied before the REPL mounts.
 *
 * - `migrateLegacyClaudinProfile`: copies `.claudin-profile.json` (single-profile
 *   sidecar) into `providerProfiles[]` and deletes it.
 * - `rescueProviderEnvVars`: when no profile exists but the user still has
 *   `CLAUDE_CODE_USE_*` exports in their shell, derive a profile so they get
 *   a `/provider` entry instead of silently breaking. When a profile already
 *   exists, just log a warning that the envs are now ignored.
 *
 * All run idempotently and are intentionally side-effect-bounded.
 */
import {
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_MISTRAL_BASE_URL,
  DEFAULT_MISTRAL_MODEL,
  deleteProfileFile,
  loadProfileFile,
  type ProfileFile,
  type ProviderProfile as LegacyProviderProfile,
} from 'src/services/api/providerProfile.js'
import {
  addProviderProfile,
  getActiveProviderProfile,
  getProfileModelOptions,
  getProviderProfiles,
  stripProjectProviderPointers,
  type ProviderProfileInput,
} from 'src/services/api/providerProfiles.js'
import {
  getGlobalConfig,
  saveGlobalConfig,
  type ProviderProfile as StoredProviderProfile,
} from 'src/platform/config/config.js'
import { parseModelList } from 'src/services/api/providerModels.js'
import { KIMI_CODE_MODEL_LIST } from 'src/services/api/kimiOAuthShared.js'

const GITHUB_COPILOT_DEFAULT_BASE_URL = 'https://models.github.ai/inference'
const GITHUB_COPILOT_DEFAULT_MODEL = 'github:copilot'
const DEFAULT_AWS_REGION = 'us-east-1'
const DEFAULT_VERTEX_REGION = 'us-east5'
const DEFAULT_CLAUDE_CLOUD_MODEL = 'claude-sonnet-4-6'
const FOUNDRY_PLACEHOLDER_BASE_URL =
  'https://YOUR-RESOURCE-NAME.services.ai.azure.com'

export type StartupMigrationsResult = {
  legacyProfileMigrated: boolean
  rescueEnvAdoptedAs?: string
  envsIgnored: string[]
  notices: string[]
}

const PROVIDER_USE_ENVS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const

function listPresentProviderEnvs(env: NodeJS.ProcessEnv): string[] {
  return PROVIDER_USE_ENVS.filter(key => env[key])
}

function profileFromLegacyFile(
  file: ProfileFile,
): ProviderProfileInput | null {
  const legacyProfile: LegacyProviderProfile = file.profile
  switch (legacyProfile) {
    case 'gemini': {
      const baseUrl = file.env.GEMINI_BASE_URL ?? DEFAULT_GEMINI_BASE_URL
      const model = file.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL
      return {
        provider: 'gemini',
        name: 'Google Gemini (legacy)',
        baseUrl,
        model,
        apiKey: file.env.GEMINI_API_KEY ?? file.env.GOOGLE_API_KEY ?? '',
      }
    }
    case 'mistral': {
      return {
        provider: 'mistral',
        name: 'Mistral (legacy)',
        baseUrl: file.env.MISTRAL_BASE_URL ?? DEFAULT_MISTRAL_BASE_URL,
        model: file.env.MISTRAL_MODEL ?? DEFAULT_MISTRAL_MODEL,
        apiKey: file.env.MISTRAL_API_KEY ?? '',
      }
    }
    case 'codex':
    case 'openai':
    case 'ollama':
    case 'atomic-chat':
    case 'nvidia-nim':
    case 'minimax': {
      const baseUrl = file.env.OPENAI_BASE_URL?.trim()
      const model = file.env.OPENAI_MODEL?.trim()
      if (!baseUrl || !model) return null
      return {
        provider: 'openai',
        name: legacyLabel(legacyProfile),
        baseUrl,
        model,
        apiKey: file.env.OPENAI_API_KEY ?? '',
      }
    }
    default:
      return null
  }
}

function legacyLabel(profile: LegacyProviderProfile): string {
  switch (profile) {
    case 'codex':
      return 'Codex (legacy)'
    case 'openai':
      return 'OpenAI (legacy)'
    case 'ollama':
      return 'Ollama (legacy)'
    case 'atomic-chat':
      return 'Atomic Chat (legacy)'
    case 'nvidia-nim':
      return 'NVIDIA NIM (legacy)'
    case 'minimax':
      return 'MiniMax (legacy)'
    case 'gemini':
      return 'Google Gemini (legacy)'
    case 'mistral':
      return 'Mistral (legacy)'
  }
}

type RescueProfile = {
  input: ProviderProfileInput
  warning?: string
}

function profileFromProviderEnvs(
  env: NodeJS.ProcessEnv,
): RescueProfile | null {
  if (env.CLAUDE_CODE_USE_OPENAI) {
    const baseUrl = env.OPENAI_BASE_URL?.trim() ?? env.OPENAI_API_BASE?.trim()
    const model = env.OPENAI_MODEL?.trim()
    if (!baseUrl || !model) return null
    return {
      input: {
        provider: 'openai',
        name: 'OpenAI (env)',
        baseUrl,
        model,
        apiKey: env.OPENAI_API_KEY ?? '',
      },
    }
  }
  if (env.CLAUDE_CODE_USE_GEMINI) {
    return {
      input: {
        provider: 'gemini',
        name: 'Google Gemini (env)',
        baseUrl: env.GEMINI_BASE_URL?.trim() ?? DEFAULT_GEMINI_BASE_URL,
        model: env.GEMINI_MODEL?.trim() ?? DEFAULT_GEMINI_MODEL,
        apiKey: env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY ?? '',
      },
    }
  }
  if (env.CLAUDE_CODE_USE_MISTRAL) {
    return {
      input: {
        provider: 'mistral',
        name: 'Mistral (env)',
        baseUrl: env.MISTRAL_BASE_URL?.trim() ?? DEFAULT_MISTRAL_BASE_URL,
        model: env.MISTRAL_MODEL?.trim() ?? DEFAULT_MISTRAL_MODEL,
        apiKey: env.MISTRAL_API_KEY ?? '',
      },
    }
  }
  if (env.CLAUDE_CODE_USE_GITHUB) {
    const githubToken = env.GITHUB_TOKEN?.trim() ?? env.GH_TOKEN?.trim() ?? ''
    return {
      input: {
        provider: 'openai',
        name: 'GitHub Copilot (legacy env)',
        baseUrl: GITHUB_COPILOT_DEFAULT_BASE_URL,
        model: GITHUB_COPILOT_DEFAULT_MODEL,
        apiKey: '',
        extras: githubToken ? { githubToken } : undefined,
      },
    }
  }
  if (env.CLAUDE_CODE_USE_BEDROCK) {
    const awsRegion =
      env.AWS_REGION?.trim() ??
      env.AWS_DEFAULT_REGION?.trim() ??
      DEFAULT_AWS_REGION
    return {
      input: {
        provider: 'bedrock',
        name: 'AWS Bedrock (legacy env)',
        baseUrl: `https://bedrock-runtime.${awsRegion}.amazonaws.com`,
        model: DEFAULT_CLAUDE_CLOUD_MODEL,
        extras: { awsRegion },
      },
    }
  }
  if (env.CLAUDE_CODE_USE_VERTEX) {
    const gcpProject =
      env.GCLOUD_PROJECT?.trim() ??
      env.GOOGLE_CLOUD_PROJECT?.trim() ??
      env.ANTHROPIC_VERTEX_PROJECT_ID?.trim()
    const gcpRegion = env.CLOUD_ML_REGION?.trim() ?? DEFAULT_VERTEX_REGION
    const extras: NonNullable<ProviderProfileInput['extras']> = { gcpRegion }
    if (gcpProject) extras.gcpProject = gcpProject
    return {
      input: {
        provider: 'vertex',
        name: 'Google Vertex AI (legacy env)',
        baseUrl: `https://${gcpRegion}-aiplatform.googleapis.com`,
        model: DEFAULT_CLAUDE_CLOUD_MODEL,
        extras,
      },
    }
  }
  if (env.CLAUDE_CODE_USE_FOUNDRY) {
    return {
      input: {
        provider: 'foundry',
        name: 'Azure AI Foundry (legacy env)',
        baseUrl: FOUNDRY_PLACEHOLDER_BASE_URL,
        model: DEFAULT_CLAUDE_CLOUD_MODEL,
      },
      warning:
        'Profile created from CLAUDE_CODE_USE_FOUNDRY but azureResource missing — open /provider to complete',
    }
  }
  return null
}

/**
 * Ids present in the RAW stored profile list (no sanitize pass). The heals
 * below decide "dangling" against this, not `getProviderProfiles()`: a
 * profile that exists on disk but fails this build's `sanitizeProfile` (e.g.
 * created by a newer/branch build whose shape this build rejects) is
 * invisible, not deleted. Destroying its pointers would not survive a
 * round-trip back to the build that accepts it; runtime resolution already
 * falls back safely in the meantime.
 */
function rawProfileIds(
  profiles: StoredProviderProfile[] | undefined,
): Set<string> {
  const ids = new Set<string>()
  for (const profile of profiles ?? []) {
    const id = profile?.id?.trim()
    if (id) ids.add(id)
  }
  return ids
}

/**
 * Strips project-level provider overrides that point at profiles which no
 * longer exist. `deleteProviderProfile` performs this cleanup at delete time,
 * but dangling ids still occur in the wild: configs written by builds where
 * the cleanup didn't persist (the pre-fix `saveGlobalConfig` discarded
 * updater edits to `projects`), or a concurrent session re-writing a project
 * entry from a stale snapshot.
 *
 * A dangling override leaves `/provider` showing an override that resolves to
 * nothing. Drop both the stale id and its paired per-project model (chosen
 * against that now-missing provider, so no longer valid) via the same helper
 * `deleteProviderProfile` uses. Per-project models on projects *without* a
 * provider override are unaffected — they are keyed on the project, not the
 * override.
 */
function healDanglingProjectProviderOverrides(): string[] {
  const config = getGlobalConfig()
  if (!config.projects) return []

  const isDanglingAgainst =
    (knownIds: Set<string>) =>
    (overrideId: string): boolean => {
      const id = overrideId.trim()
      return id ? !knownIds.has(id) : false
    }

  // Cheap pre-scan on the cached config: skip the lock + re-read entirely in
  // the common no-dangle case (this runs on every startup).
  const probe = stripProjectProviderPointers(
    config.projects,
    isDanglingAgainst(rawProfileIds(config.providerProfiles)),
  )
  if (probe.stripped.length === 0) return []

  let notices: string[] = []
  saveGlobalConfig(current => {
    // Reset per invocation: saveGlobalConfig may run the updater again on its
    // fallback path, and only the last invocation's outcome is real. Notices
    // are derived from what THIS updater actually strips (re-checked against
    // the freshest config under the lock), never from the pre-scan snapshot.
    notices = []
    const { projects: nextProjects, stripped } = stripProjectProviderPointers(
      current.projects,
      isDanglingAgainst(rawProfileIds(current.providerProfiles)),
    )
    if (stripped.length === 0 || nextProjects === current.projects) {
      return current
    }
    // Name the dropped id and pinned model — this notice is the only
    // remaining record of the user's per-project choice.
    notices = stripped.map(
      ({ path, activeProviderProfileId, activeModelForProject }) =>
        `cleared stale project provider override for ${path} (profile ${activeProviderProfileId} no longer exists${
          activeModelForProject ? `; pinned model was ${activeModelForProject}` : ''
        }) — re-pin via /provider`,
    )
    return { ...current, projects: nextProjects }
  })

  return notices
}

/**
 * Heals a global `activeProviderProfileId` that points at a profile which no
 * longer exists (same out-of-band origins as the project-level case above).
 * Runtime resolution already falls back to the first sanitized profile
 * (`getActiveProviderProfile`), so persist that same election — mirroring
 * `deleteProviderProfile`'s re-election, including its model-options-cache
 * swap. When no profiles remain at all, clear the field. When profiles exist
 * on disk but none survive this build's sanitize pass, leave the config
 * untouched (see `rawProfileIds`).
 */
function healDanglingGlobalProviderDefault(): string | undefined {
  const config = getGlobalConfig()
  const globalActiveId = config.activeProviderProfileId?.trim()
  if (!globalActiveId) return undefined
  if (rawProfileIds(config.providerProfiles).has(globalActiveId)) {
    return undefined
  }

  let notice: string | undefined
  saveGlobalConfig(current => {
    // Reset per invocation — see the project heal for why.
    notice = undefined
    const currentActive = current.activeProviderProfileId?.trim()
    if (!currentActive) return current
    const rawIds = rawProfileIds(current.providerProfiles)
    if (rawIds.has(currentActive)) return current

    const nextActive = getProviderProfiles(current)[0]
    if (!nextActive && rawIds.size > 0) {
      // Profiles exist on disk but none survive this build's sanitize pass —
      // electing nothing here would destroy state another build still uses.
      return current
    }

    const cacheByProfile = {
      ...(current.openaiAdditionalModelOptionsCacheByProfile ?? {}),
    }
    delete cacheByProfile[currentActive]
    notice = nextActive
      ? `global provider default pointed at deleted profile ${currentActive} — now using "${nextActive.name}"`
      : `cleared global provider default (profile ${currentActive} no longer exists) — pick one via /provider`
    return {
      ...current,
      activeProviderProfileId: nextActive?.id,
      openaiAdditionalModelOptionsCacheByProfile: cacheByProfile,
      openaiAdditionalModelOptionsCache: nextActive
        ? (cacheByProfile[nextActive.id] ?? [])
        : [],
    }
  })

  return notice
}

const KIMI_CODE_CANONICAL_MODELS = parseModelList(KIMI_CODE_MODEL_LIST)

function isKimiCodeCodingBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    const { hostname, pathname } = new URL(baseUrl)
    return hostname === 'api.kimi.com' && pathname.startsWith('/coding')
  } catch {
    return false
  }
}

function isKimiOAuthProfile(profile: StoredProviderProfile): boolean {
  return (
    profile.provider === 'openai' &&
    !profile.apiKey &&
    isKimiCodeCodingBaseUrl(profile.baseUrl)
  )
}

/** The `.value`s of a stored model-options cache array, or undefined if absent. */
function cachedOptionValues(cached: unknown): string[] | undefined {
  if (!Array.isArray(cached)) return undefined
  return cached
    .map(option =>
      option && typeof option === 'object'
        ? (option as { value?: unknown }).value
        : undefined,
    )
    .filter((value): value is string => typeof value === 'string')
}

function equalToCanonical(values: string[] | undefined): boolean {
  return (
    values !== undefined &&
    values.length === KIMI_CODE_CANONICAL_MODELS.length &&
    values.every((value, index) => value === KIMI_CODE_CANONICAL_MODELS[index])
  )
}

/**
 * A Kimi Code OAuth profile whose model list OR its derived model-options cache
 * predates the current canonical set (early builds shipped only `k3`), so
 * `/model` hides the other coding models. Only fires when every stored model is
 * canonical (a profile carrying a custom/extra model is left untouched) and
 * either a canonical model is missing from `profile.model` or the profile's
 * cache doesn't already list exactly the canonical set.
 */
function kimiProfileNeedsHeal(
  profile: StoredProviderProfile,
  config: ReturnType<typeof getGlobalConfig>,
): boolean {
  if (!isKimiOAuthProfile(profile)) return false
  const models = parseModelList(profile.model)
  if (models.length === 0) return false
  if (!models.every(model => KIMI_CODE_CANONICAL_MODELS.includes(model))) {
    return false
  }
  const modelStale = KIMI_CODE_CANONICAL_MODELS.some(
    model => !models.includes(model),
  )
  const cacheStale = !equalToCanonical(
    cachedOptionValues(
      config.openaiAdditionalModelOptionsCacheByProfile?.[profile.id],
    ),
  )
  return modelStale || cacheStale
}

/**
 * Refresh the model list on a Kimi Code OAuth profile stored by an earlier build
 * that only shipped `k3`, so every Kimi coding model shows up in `/model` without
 * a re-login. Idempotent: once the profile carries the full canonical list the
 * trigger no longer fires.
 */
function healStaleKimiCodeModelList(): string | undefined {
  const config = getGlobalConfig()
  if (
    !getProviderProfiles(config).some(profile =>
      kimiProfileNeedsHeal(profile, config),
    )
  ) {
    return undefined
  }

  let notice: string | undefined
  saveGlobalConfig(current => {
    notice = undefined
    const rawProfiles = current.providerProfiles ?? []
    const healed = getProviderProfiles(current).filter(profile =>
      kimiProfileNeedsHeal(profile, current),
    )
    const healedIds = new Set(healed.map(profile => profile.id))
    if (healedIds.size === 0) return current

    const nextProfiles = rawProfiles.map(profile =>
      healedIds.has(profile.id)
        ? { ...profile, model: KIMI_CODE_MODEL_LIST }
        : profile,
    )

    // Refresh the derived model-options cache from the new list. The /model
    // picker reads this cache for the active openai profile and returns it
    // WITHOUT re-parsing profile.model, so a stale entry (e.g. the old `[k3]`)
    // would keep hiding the coding models even after the profile is fixed.
    const cacheByProfile = {
      ...(current.openaiAdditionalModelOptionsCacheByProfile ?? {}),
    }
    for (const profile of healed) {
      cacheByProfile[profile.id] = getProfileModelOptions({
        ...profile,
        model: KIMI_CODE_MODEL_LIST,
      })
    }

    const activeId = current.activeProviderProfileId?.trim()
    const activeHealed = activeId !== undefined && healedIds.has(activeId)
    notice = 'refreshed the Kimi Code model list (added the coding models)'
    return {
      ...current,
      providerProfiles: nextProfiles,
      openaiAdditionalModelOptionsCacheByProfile: cacheByProfile,
      // The flat cache mirrors whichever openai profile is active; refresh it
      // too when the active profile was the one healed.
      openaiAdditionalModelOptionsCache: activeHealed
        ? cacheByProfile[activeId]
        : current.openaiAdditionalModelOptionsCache,
    }
  })

  return notice
}

/**
 * Garbage-collect `openaiAdditionalModelOptionsCacheByProfile` entries whose
 * profile no longer exists. deleteProviderProfile prunes the deleted id, but
 * profiles removed by other paths (sanitize rejection, manual config edits)
 * can leave orphaned cache entries that grow unbounded. Idempotent.
 */
function pruneOrphanedModelOptionsCache(): string | undefined {
  const config = getGlobalConfig()
  const cache = config.openaiAdditionalModelOptionsCacheByProfile
  if (!cache) return undefined
  const validIds = new Set(getProviderProfiles(config).map(profile => profile.id))
  const orphanCount = Object.keys(cache).filter(id => !validIds.has(id)).length
  if (orphanCount === 0) return undefined

  saveGlobalConfig(current => {
    const currentCache = current.openaiAdditionalModelOptionsCacheByProfile
    if (!currentCache) return current
    const ids = new Set(getProviderProfiles(current).map(profile => profile.id))
    const nextCache: typeof currentCache = {}
    let removed = 0
    for (const [id, options] of Object.entries(currentCache)) {
      if (ids.has(id)) nextCache[id] = options
      else removed++
    }
    if (removed === 0) return current
    return {
      ...current,
      openaiAdditionalModelOptionsCacheByProfile: nextCache,
    }
  })

  return `pruned ${orphanCount} orphaned model-options cache ${
    orphanCount === 1 ? 'entry' : 'entries'
  }`
}

export function runClaudinStartupMigrations(options?: {
  processEnv?: NodeJS.ProcessEnv
  homeDir?: string
  log?: (message: string) => void
}): StartupMigrationsResult {
  const env = options?.processEnv ?? process.env
  const log = options?.log ?? defaultLog
  const result: StartupMigrationsResult = {
    legacyProfileMigrated: false,
    envsIgnored: [],
    notices: [],
  }

  // legacy .claudin-profile.json -> providerProfiles[]
  const legacy = loadProfileFile()
  if (legacy) {
    const input = profileFromLegacyFile(legacy)
    if (input && !getActiveProviderProfile()) {
      const saved = addProviderProfile(input, { makeActive: true })
      if (saved) {
        result.legacyProfileMigrated = true
        const notice =
          'migrated legacy .claudin-profile.json to providerProfiles[]'
        result.notices.push(notice)
        log(notice)
      }
    }
    // Whether or not the input could be derived, drop the file: keeping it
    // around makes startup re-attempt the same migration each run.
    deleteProfileFile()
  }

  // rescue CLAUDE_CODE_USE_* envs
  const presentEnvs = listPresentProviderEnvs(env)
  if (presentEnvs.length > 0) {
    const active = getActiveProviderProfile()
    if (!active) {
      const rescue = profileFromProviderEnvs(env)
      if (rescue) {
        const saved = addProviderProfile(rescue.input, { makeActive: true })
        if (saved) {
          result.rescueEnvAdoptedAs = saved.name
          const notice = `migrated env-based config to /provider as "${saved.name}"`
          result.notices.push(notice)
          log(notice)
          if (rescue.warning) {
            result.notices.push(rescue.warning)
            log(rescue.warning)
          }
        }
      }
    } else {
      result.envsIgnored = presentEnvs
      const notice = `ignoring ${presentEnvs.join(', ')} — managed by /provider`
      result.notices.push(notice)
      log(notice)
    }
  }

  // Heal dangling provider pointers (see function docs). Runs after the
  // profile migrations above so freshly-adopted profiles are part of the
  // known-id set.
  for (const notice of healDanglingProjectProviderOverrides()) {
    result.notices.push(notice)
    log(notice)
  }
  const globalHealNotice = healDanglingGlobalProviderDefault()
  if (globalHealNotice) {
    result.notices.push(globalHealNotice)
    log(globalHealNotice)
  }

  const kimiModelHealNotice = healStaleKimiCodeModelList()
  if (kimiModelHealNotice) {
    result.notices.push(kimiModelHealNotice)
    log(kimiModelHealNotice)
  }

  const cacheGcNotice = pruneOrphanedModelOptionsCache()
  if (cacheGcNotice) {
    result.notices.push(cacheGcNotice)
    log(cacheGcNotice)
  }

  return result
}

function defaultLog(message: string): void {
  // Yellow channel — matches existing managedEnv warning style without
  // pulling chalk into hot startup imports.
  process.stderr.write(`\x1b[33m${message}\x1b[0m\n`)
}
