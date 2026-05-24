import { randomBytes } from 'crypto'
import {
  getCurrentProjectConfig,
  getGlobalConfig,
  saveCurrentProjectConfig,
  saveGlobalConfig,
  type ProviderProfile,
} from './config.js'
import type { ModelOption } from './model/modelOptions.js'
import { parseModelList } from './providerModels.js'

export type ProviderPreset =
  | 'anthropic'
  | 'ollama'
  | 'openai'
  | 'kimi-code'
  | 'moonshotai'
  | 'deepseek'
  | 'gemini'
  | 'mistral'
  | 'together'
  | 'groq'
  | 'azure-openai'
  | 'openrouter'
  | 'lmstudio'
  | 'dashscope-cn'
  | 'dashscope-intl'
  | 'custom'
  | 'nvidia-nim'
  | 'minimax'
  | 'bankr'
  | 'atomic-chat'
  | 'bedrock'
  | 'vertex'
  | 'foundry'

export type ProviderProfileInput = {
  provider?: ProviderProfile['provider']
  name: string
  baseUrl: string
  model: string
  apiKey?: string
  extras?: ProviderProfile['extras']
}

export type ProviderPresetDefaults = Omit<ProviderProfileInput, 'provider'> & {
  provider: ProviderProfile['provider']
  requiresApiKey: boolean
}

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1'
const DEFAULT_OLLAMA_MODEL = 'llama3.1:8b'

function trimValue(value: string | undefined): string {
  return value?.trim() ?? ''
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = trimValue(value)
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeBaseUrl(value: string): string {
  return trimValue(value).replace(/\/+$/, '')
}

function sanitizeProvider(
  provider: unknown,
): ProviderProfile['provider'] {
  switch (provider) {
    case 'anthropic':
    case 'mistral':
    case 'gemini':
    case 'bedrock':
    case 'vertex':
    case 'foundry':
      return provider
    default:
      return 'openai'
  }
}

function sanitizeReasoningEffort(
  value: unknown,
): NonNullable<ProviderProfile['extras']>['reasoningEffort'] {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') {
    return value
  }
  return undefined
}

function sanitizeCustomHeaders(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = trimValue(k)
    const val = typeof v === 'string' ? v.trim() : ''
    if (key.length > 0 && val.length > 0) {
      out[key] = val
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizeExtras(
  extras: ProviderProfile['extras'] | undefined,
): ProviderProfile['extras'] | undefined {
  if (!extras || typeof extras !== 'object') {
    return undefined
  }
  const out: NonNullable<ProviderProfile['extras']> = {}
  const codexAuthPath = trimOrUndefined(extras.codexAuthPath)
  if (codexAuthPath) out.codexAuthPath = codexAuthPath
  const codexAccountId = trimOrUndefined(extras.codexAccountId)
  if (codexAccountId) out.codexAccountId = codexAccountId
  const githubToken = trimOrUndefined(extras.githubToken)
  if (githubToken) out.githubToken = githubToken
  const awsRegion = trimOrUndefined(extras.awsRegion)
  if (awsRegion) out.awsRegion = awsRegion
  const gcpProject = trimOrUndefined(extras.gcpProject)
  if (gcpProject) out.gcpProject = gcpProject
  const gcpRegion = trimOrUndefined(extras.gcpRegion)
  if (gcpRegion) out.gcpRegion = gcpRegion
  const azureResource = trimOrUndefined(extras.azureResource)
  if (azureResource) out.azureResource = azureResource
  const customHeaders = sanitizeCustomHeaders(extras.customHeaders)
  if (customHeaders) out.customHeaders = customHeaders
  const reasoningEffort = sanitizeReasoningEffort(extras.reasoningEffort)
  if (reasoningEffort) out.reasoningEffort = reasoningEffort
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizeProfile(profile: ProviderProfile): ProviderProfile | null {
  const id = trimValue(profile.id)
  const name = trimValue(profile.name)
  const provider = sanitizeProvider(profile.provider)
  const baseUrl = normalizeBaseUrl(profile.baseUrl)
  const model = trimValue(profile.model)

  // Anthropic resolves the model via subscription-aware defaults in
  // getDefaultMainLoopModelSetting(), so an empty model is valid for it.
  // Other providers need a model to make API calls.
  const needsModel = provider !== 'anthropic'
  if (!id || !name || !baseUrl || (needsModel && !model)) {
    return null
  }

  const sanitized: ProviderProfile = {
    id,
    name,
    provider,
    baseUrl,
    model,
    apiKey: trimOrUndefined(profile.apiKey),
  }

  const extras = sanitizeExtras(profile.extras)
  if (extras) {
    sanitized.extras = extras
  }

  return sanitized
}

function sanitizeProfiles(profiles: ProviderProfile[] | undefined): ProviderProfile[] {
  const seen = new Set<string>()
  const sanitized: ProviderProfile[] = []

  for (const profile of profiles ?? []) {
    const normalized = sanitizeProfile(profile)
    if (!normalized || seen.has(normalized.id)) {
      continue
    }
    seen.add(normalized.id)
    sanitized.push(normalized)
  }

  return sanitized
}

function nextProfileId(): string {
  return `provider_${randomBytes(6).toString('hex')}`
}

function toProfile(
  input: ProviderProfileInput,
  id: string = nextProfileId(),
): ProviderProfile | null {
  return sanitizeProfile({
    id,
    provider: input.provider ?? 'openai',
    name: input.name,
    baseUrl: input.baseUrl,
    model: input.model,
    apiKey: input.apiKey,
    extras: input.extras,
  })
}

function getModelCacheByProfile(
  profileId: string,
  config = getGlobalConfig(),
): ModelOption[] {
  return config.openaiAdditionalModelOptionsCacheByProfile?.[profileId] ?? []
}

export function getProviderPresetDefaults(
  preset: ProviderPreset,
): ProviderPresetDefaults {
  switch (preset) {
    case 'anthropic':
      return {
        provider: 'anthropic',
        name: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: '',
        apiKey: '',
        requiresApiKey: true,
      }
    case 'openai':
      return {
        provider: 'openai',
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4',
        apiKey: '',
        requiresApiKey: true,
      }
    case 'kimi-code':
      return {
        provider: 'openai',
        name: 'Moonshot AI - Kimi Code',
        baseUrl: 'https://api.kimi.com/coding/v1',
        model: 'kimi-for-coding',
        apiKey: '',
        requiresApiKey: true,
      }
    case 'moonshotai':
      return {
        provider: 'openai',
        name: 'Moonshot AI - API',
        baseUrl: 'https://api.moonshot.ai/v1',
        model: 'kimi-k2.5',
        apiKey: '',
        requiresApiKey: true,
      }
    case 'deepseek':
      return {
        provider: 'openai',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-flash, deepseek-v4-pro, deepseek-chat, deepseek-reasoner',
        apiKey: '',
        requiresApiKey: true,
      }
    case 'gemini':
      return {
        provider: 'gemini',
        name: 'Google Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: 'gemini-3-flash-preview',
        apiKey: '',
        requiresApiKey: true,
      }
    case 'mistral':
      return {
        provider: 'mistral',
        name: 'Mistral',
        baseUrl: 'https://api.mistral.ai/v1',
        model: 'devstral-latest',
        apiKey: '',
        requiresApiKey: true
      }
    case 'together':
      return {
        provider: 'openai',
        name: 'Together AI',
        baseUrl: 'https://api.together.xyz/v1',
        model: 'Qwen/Qwen3.5-9B',
        apiKey: '',
        requiresApiKey: true,
      }
    case 'groq':
      return {
        provider: 'openai',
        name: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        model: 'llama-3.3-70b-versatile',
        apiKey: '',
        requiresApiKey: true,
      }
    case 'azure-openai':
      return {
        provider: 'openai',
        name: 'Azure OpenAI',
        baseUrl: 'https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1',
        model: 'YOUR-DEPLOYMENT-NAME',
        apiKey: '',
        requiresApiKey: true,
      }
    case 'openrouter':
      return {
        provider: 'openai',
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openai/gpt-5-mini',
        apiKey: '',
        requiresApiKey: true,
      }
    case 'lmstudio':
      return {
        provider: 'openai',
        name: 'LM Studio',
        baseUrl: 'http://localhost:1234/v1',
        model: 'local-model',
        apiKey: '',
        requiresApiKey: false,
      }
    case 'dashscope-cn':
      return {
        provider: 'openai',
        name: 'Alibaba Coding Plan (China)',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
        model: 'qwen3.6-plus',
        apiKey: '',
        requiresApiKey: true,
      }
    case 'dashscope-intl':
      return {
        provider: 'openai',
        name: 'Alibaba Coding Plan',
        baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
        model: 'qwen3.6-plus',
        apiKey: '',
        requiresApiKey: true,
      }
    case 'custom':
      return {
        provider: 'openai',
        name: 'Custom OpenAI-compatible',
        baseUrl: DEFAULT_OLLAMA_BASE_URL,
        model: DEFAULT_OLLAMA_MODEL,
        apiKey: '',
        requiresApiKey: false,
      }
    case 'nvidia-nim':
      return {
        provider: 'openai',
        name: 'NVIDIA NIM',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        model: 'nvidia/llama-3.1-nemotron-70b-instruct',
        apiKey: '',
        requiresApiKey: true,
      }
    case 'minimax':
      return {
        provider: 'openai',
        name: 'MiniMax',
        baseUrl: 'https://api.minimax.io/v1',
        model: 'MiniMax-M2.5',
        apiKey: '',
        requiresApiKey: true,
      }
    case 'atomic-chat':
      return {
        provider: 'openai',
        name: 'Atomic Chat',
        baseUrl: 'http://127.0.0.1:1337/v1',
        model: 'local-model',
        apiKey: '',
        requiresApiKey: false,
      }
    case 'bankr':
      return {
        provider: 'openai',
        name: 'Bankr',
        baseUrl: 'https://llm.bankr.bot/v1',
        model: 'claude-opus-4.6',
        apiKey: '',
        requiresApiKey: true,
      }
    case 'bedrock':
      return {
        provider: 'bedrock',
        name: 'AWS Bedrock',
        baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
        model: 'claude-sonnet-4-6',
        apiKey: '',
        requiresApiKey: false,
      }
    case 'vertex':
      return {
        provider: 'vertex',
        name: 'Google Vertex AI',
        baseUrl: 'https://us-central1-aiplatform.googleapis.com',
        model: 'claude-sonnet-4-6',
        apiKey: '',
        requiresApiKey: false,
      }
    case 'foundry':
      return {
        provider: 'foundry',
        name: 'Azure AI Foundry',
        baseUrl: 'https://YOUR-RESOURCE-NAME.services.ai.azure.com',
        model: 'claude-sonnet-4-6',
        apiKey: '',
        requiresApiKey: false,
      }
    case 'ollama':
    default:
      return {
        provider: 'openai',
        name: 'Ollama',
        baseUrl: DEFAULT_OLLAMA_BASE_URL,
        model: DEFAULT_OLLAMA_MODEL,
        apiKey: '',
        requiresApiKey: false,
      }
  }
}

export function getProviderProfiles(
  config = getGlobalConfig(),
): ProviderProfile[] {
  return sanitizeProfiles(config.providerProfiles)
}

export function hasProviderProfiles(config = getGlobalConfig()): boolean {
  return getProviderProfiles(config).length > 0
}

export function getActiveProviderProfile(
  config = getGlobalConfig(),
): ProviderProfile | undefined {
  const profiles = getProviderProfiles(config)
  if (profiles.length === 0) {
    return undefined
  }

  const projectActiveId = trimOrUndefined(
    getCurrentProjectConfig().activeProviderProfileId,
  )
  if (projectActiveId) {
    const match = profiles.find(profile => profile.id === projectActiveId)
    if (match) return match
    // Project override points to a missing profile (deleted/renamed). Fall back
    // to global silently; user can clear the override from /provider.
  }

  const activeId = trimOrUndefined(config.activeProviderProfileId)
  return profiles.find(profile => profile.id === activeId) ?? profiles[0]
}

/**
 * Returns the profile id active for the current project via override, if any.
 * Returns undefined when no project-level override is set OR when the override
 * points to a missing profile (caller treats that as "no override").
 *
 * Use `hasProjectProviderProfileOverride()` when you need to know that an
 * override is set even if it currently resolves to a missing profile (e.g.
 * to expose a "clear override" affordance).
 *
 * Note: project scope is keyed by the resolved project directory (git root
 * when available, otherwise cwd). Worktrees of the same repo therefore
 * share the same override — this is intentional, since profile choice is
 * a per-repo concern, not a per-branch one.
 */
export function getProjectActiveProviderProfileId(): string | undefined {
  const projectActiveId = trimOrUndefined(
    getCurrentProjectConfig().activeProviderProfileId,
  )
  if (!projectActiveId) return undefined
  const profiles = getProviderProfiles()
  return profiles.some(p => p.id === projectActiveId)
    ? projectActiveId
    : undefined
}

/**
 * Returns the raw project-level override id (including stale ids pointing to
 * a missing profile). Returns undefined when no override is set.
 */
export function getRawProjectActiveProviderProfileId(): string | undefined {
  return trimOrUndefined(getCurrentProjectConfig().activeProviderProfileId)
}

/**
 * True when a project-level override is set, even if it currently points to
 * a missing profile. Use this for UI affordances that should remain available
 * for the user to clear a stale override.
 */
export function hasProjectProviderProfileOverride(): boolean {
  return getRawProjectActiveProviderProfileId() !== undefined
}

/**
 * Returns the globally-default profile id (ignoring any project override),
 * or undefined when no global default is set.
 */
export function getGlobalActiveProviderProfileId(): string | undefined {
  return trimOrUndefined(getGlobalConfig().activeProviderProfileId)
}

export function addProviderProfile(
  input: ProviderProfileInput,
  options?: { makeActive?: boolean },
): ProviderProfile | null {
  const profile = toProfile(input)
  if (!profile) {
    return null
  }

  const makeActive = options?.makeActive ?? true

  saveGlobalConfig(current => {
    const currentProfiles = getProviderProfiles(current)
    const nextProfiles = [...currentProfiles, profile]
    const currentActive = trimOrUndefined(current.activeProviderProfileId)
    const nextActiveId =
      makeActive || !currentActive || !nextProfiles.some(p => p.id === currentActive)
        ? profile.id
        : currentActive

    return {
      ...current,
      providerProfiles: nextProfiles,
      activeProviderProfileId: nextActiveId,
    }
  })

  // Compare against the *global* active id (what we just wrote at line 526),
  // not the resolved active profile — a project-level override could otherwise
  // mask the fact that this new profile became the global default and skip the
  // post-write cache rotation.
  if (getGlobalActiveProviderProfileId() === profile.id) {
    setActiveProviderProfile(profile.id)
    clearActiveOpenAIModelOptionsCache()
  }

  return profile
}

export function updateProviderProfile(
  profileId: string,
  input: ProviderProfileInput,
): ProviderProfile | null {
  const updatedProfile = toProfile(input, profileId)
  if (!updatedProfile) {
    return null
  }

  let wasUpdated = false

  saveGlobalConfig(current => {
    const currentProfiles = getProviderProfiles(current)
    const profileIndex = currentProfiles.findIndex(
      profile => profile.id === profileId,
    )

    if (profileIndex < 0) {
      return current
    }

    wasUpdated = true

    const nextProfiles = [...currentProfiles]
    nextProfiles[profileIndex] = updatedProfile

    const cacheByProfile = {
      ...(current.openaiAdditionalModelOptionsCacheByProfile ?? {}),
    }
    delete cacheByProfile[profileId]

    const currentActive = trimOrUndefined(current.activeProviderProfileId)
    const nextActiveId =
      currentActive && nextProfiles.some(profile => profile.id === currentActive)
        ? currentActive
        : nextProfiles[0]?.id

    const updatedProfileIsActive = nextActiveId === profileId

    return {
      ...current,
      providerProfiles: nextProfiles,
      activeProviderProfileId: nextActiveId,
      openaiAdditionalModelOptionsCacheByProfile: cacheByProfile,
      openaiAdditionalModelOptionsCache: updatedProfileIsActive
        ? []
        : current.openaiAdditionalModelOptionsCache,
    }
  })

  if (!wasUpdated) {
    return null
  }

  return updatedProfile
}

export function persistActiveProviderProfileModel(
  model: string,
): ProviderProfile | null {
  const nextModel = trimOrUndefined(model)
  if (!nextModel) {
    return null
  }

  const activeProfile = getActiveProviderProfile()
  if (!activeProfile) {
    return null
  }

  // If the model is already part of the profile's model list, don't
  // overwrite the field. This preserves comma-separated model lists like
  // "glm-4.5, glm-4.7". Switching between models in the list is a
  // session-level choice handled by mainLoopModelOverride, not a profile
  // edit — the profile's model list should only change via explicit edit.
  const existingModels = parseModelList(activeProfile.model)
  if (existingModels.includes(nextModel)) {
    return activeProfile
  }

  saveGlobalConfig(current => {
    const currentProfiles = getProviderProfiles(current)
    const profileIndex = currentProfiles.findIndex(
      profile => profile.id === activeProfile.id,
    )

    if (profileIndex < 0) {
      return current
    }

    const currentProfile = currentProfiles[profileIndex]
    if (currentProfile.model === nextModel) {
      return current
    }

    const nextProfiles = [...currentProfiles]
    nextProfiles[profileIndex] = {
      ...currentProfile,
      model: nextModel,
    }

    return {
      ...current,
      providerProfiles: nextProfiles,
    }
  })

  const resolvedProfile = getActiveProviderProfile()
  if (!resolvedProfile || resolvedProfile.id !== activeProfile.id) {
    return null
  }
  return resolvedProfile
}

/**
 * Clear the active provider profile's model field so the system default is
 * used. Called when the user selects "Default" in the model picker.
 */
export function clearActiveProviderProfileModel(): void {
  const activeProfile = getActiveProviderProfile()
  if (!activeProfile) return

  saveGlobalConfig(current => {
    const currentProfiles = getProviderProfiles(current)
    const profileIndex = currentProfiles.findIndex(
      profile => profile.id === activeProfile.id,
    )
    if (profileIndex < 0) return current

    const currentProfile = currentProfiles[profileIndex]
    if (!currentProfile.model) return current

    const nextProfiles = [...currentProfiles]
    nextProfiles[profileIndex] = { ...currentProfile, model: '' }
    return { ...current, providerProfiles: nextProfiles }
  })
}

/**
 * Generate model options from a provider profile's model field.
 * Each parsed model becomes a separate option in the picker.
 */
export function getProfileModelOptions(profile: ProviderProfile): ModelOption[] {
  const models = parseModelList(profile.model)
  if (models.length === 0) {
    return []
  }

  return models.map(model => ({
    value: model,
    label: model,
    description: `Provider: ${profile.name}`,
  }))
}

function applyActiveProfileModelCache(
  profile: ProviderProfile,
  config: ReturnType<typeof getGlobalConfig>,
): Pick<
  ReturnType<typeof getGlobalConfig>,
  | 'openaiAdditionalModelOptionsCache'
  | 'openaiAdditionalModelOptionsCacheByProfile'
> {
  const profileModelOptions = getProfileModelOptions(profile)
  return {
    openaiAdditionalModelOptionsCache: profileModelOptions.length > 0
      ? profileModelOptions
      : getModelCacheByProfile(profile.id, config),
    openaiAdditionalModelOptionsCacheByProfile: {
      ...(config.openaiAdditionalModelOptionsCacheByProfile ?? {}),
      [profile.id]: profileModelOptions.length > 0
        ? profileModelOptions
        : (config.openaiAdditionalModelOptionsCacheByProfile?.[profile.id] ?? []),
    },
  }
}

export function setActiveProviderProfile(
  profileId: string,
): ProviderProfile | null {
  const current = getGlobalConfig()
  const profiles = getProviderProfiles(current)
  const activeProfile = profiles.find(profile => profile.id === profileId)

  if (!activeProfile) {
    return null
  }

  saveGlobalConfig(config => ({
    ...config,
    activeProviderProfileId: profileId,
    ...applyActiveProfileModelCache(activeProfile, config),
  }))

  return activeProfile
}

/**
 * Sets (or clears) the active provider profile override for the current
 * project. Pass `null` to remove the override and fall back to the global
 * default. Returns the resolved profile when set, or `null` on clear / when
 * the given profileId does not exist.
 */
export function setActiveProviderProfileForProject(
  profileId: string | null,
): ProviderProfile | null {
  if (profileId === null) {
    // Drop both the override id AND its sibling per-project model. Leaving
    // activeModelForProject behind would silently resurface as the project's
    // preferred model the next time the user sets ANY override here, even
    // for a different profile — surprising and wrong.
    saveCurrentProjectConfig(current => ({
      ...current,
      activeProviderProfileId: undefined,
      activeModelForProject: undefined,
    }))
    // Refresh the OpenAI model-options cache for the new effective profile
    // (now the global default, if any), so the model picker isn't stale.
    const nowEffective = getActiveProviderProfile()
    if (nowEffective) refreshActiveProfileModelCacheIfNeeded(nowEffective)
    return null
  }

  const profiles = getProviderProfiles()
  const target = profiles.find(profile => profile.id === profileId)
  if (!target) {
    return null
  }

  // Re-validate inside the updater. saveCurrentProjectConfig is not atomic
  // with the global-config read above, so a concurrent deleteProviderProfile
  // (gRPC / multi-session) could remove this profile between our existence
  // check and persist, leaving a dangling project override. Re-reading the
  // freshest profiles snapshot inside the updater closes the practical race
  // window; if the profile vanished mid-flight we return the prior config
  // unchanged and signal failure to the caller.
  //
  // Also: when the override target *changes* (vs. re-selecting the same
  // profile) drop activeModelForProject so a stale per-project model from
  // the previous override doesn't carry into a different-shape transport.
  // Relying on the UI's subsequent setAppState diff to do this cleanup is
  // unsound: if the new profile's primary model string equals the stale one,
  // no diff fires and the stale value survives.
  let raceLost = false
  saveCurrentProjectConfig(current => {
    const stillExists = getProviderProfiles().some(p => p.id === profileId)
    if (!stillExists) {
      raceLost = true
      return current
    }
    const next: typeof current = {
      ...current,
      activeProviderProfileId: profileId,
    }
    if (current.activeProviderProfileId !== profileId) {
      next.activeModelForProject = undefined
    }
    return next
  })
  if (raceLost) return null

  // Keep the global OpenAI model-options cache in sync with the now-effective
  // profile so downstream consumers (model picker, etc.) see correct options.
  refreshActiveProfileModelCacheIfNeeded(target)

  return target
}

/**
 * Writes the OpenAI model-options cache for the given profile only when the
 * write would produce a different result. Avoids unnecessary disk writes +
 * listener fan-out when toggling between profiles that don't carry OpenAI
 * model options (e.g. Anthropic ↔ Anthropic).
 */
function refreshActiveProfileModelCacheIfNeeded(profile: ProviderProfile): void {
  const config = getGlobalConfig()
  const next = applyActiveProfileModelCache(profile, config)
  const currentTopLevel = config.openaiAdditionalModelOptionsCache ?? []
  const currentByProfile =
    config.openaiAdditionalModelOptionsCacheByProfile?.[profile.id] ?? []
  const nextByProfile =
    next.openaiAdditionalModelOptionsCacheByProfile?.[profile.id] ?? []
  if (
    arraysShallowEqual(currentTopLevel, next.openaiAdditionalModelOptionsCache ?? []) &&
    arraysShallowEqual(currentByProfile, nextByProfile)
  ) {
    return
  }
  // Reuse the `next` already computed above instead of recomputing inside the
  // updater. saveGlobalConfig's updater may be called more than once under
  // contention, but the result is referentially stable for the same profile.
  saveGlobalConfig(c => ({ ...c, ...applyActiveProfileModelCache(profile, c) }))
  // Note: keeping the updater-form for write-time recomputation because
  // saveGlobalConfig's locked updater can re-read a newer base config than
  // `config` above. Eliminating one of the two calls would risk staleness;
  // the diff-check above prevents the *write* when nothing changes, which is
  // the actual cost driver.
}

function arraysShallowEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function deleteProviderProfile(profileId: string): {
  removed: boolean
  activeProfileId?: string
} {
  let removed = false
  let nextActiveProfile: ProviderProfile | undefined

  saveGlobalConfig(current => {
    const currentProfiles = getProviderProfiles(current)
    const existing = currentProfiles.find(profile => profile.id === profileId)

    if (!existing) {
      return current
    }

    removed = true

    const nextProfiles = currentProfiles.filter(profile => profile.id !== profileId)
    const currentActive = trimOrUndefined(current.activeProviderProfileId)
    const activeWasDeleted =
      !currentActive || currentActive === profileId ||
      !nextProfiles.some(profile => profile.id === currentActive)

    const nextActiveId = activeWasDeleted ? nextProfiles[0]?.id : currentActive

    if (nextActiveId) {
      nextActiveProfile =
        nextProfiles.find(profile => profile.id === nextActiveId) ?? nextProfiles[0]
    }

    const cacheByProfile = {
      ...(current.openaiAdditionalModelOptionsCacheByProfile ?? {}),
    }
    delete cacheByProfile[profileId]

    // Strip the deleted profile id AND its paired per-project model from
    // every project-level override so we don't leave dangling pointers — or
    // a stale model — across the user's other projects. Without this, those
    // projects either keep a stale override that silently falls back to the
    // global default while still showing as "override set" in /provider, or
    // they preserve activeModelForProject that would resurface the next time
    // an override is set in that project (see M4).
    // Skip the rebuild entirely when no project pointed at the deleted
    // profile — the common case for users who only set overrides in one or
    // two projects. Avoids touching the projects map and its downstream
    // listener cost.
    const projectsTouched = current.projects
      ? Object.values(current.projects).some(
          pc => pc?.activeProviderProfileId === profileId,
        )
      : false
    const nextProjects =
      projectsTouched && current.projects
        ? Object.fromEntries(
            Object.entries(current.projects).map(([key, projectConfig]) => {
              if (projectConfig?.activeProviderProfileId === profileId) {
                const {
                  activeProviderProfileId: _droppedId,
                  activeModelForProject: _droppedModel,
                  ...rest
                } = projectConfig
                return [key, rest]
              }
              return [key, projectConfig]
            }),
          )
        : current.projects

    return {
      ...current,
      providerProfiles: nextProfiles,
      activeProviderProfileId: nextActiveId,
      openaiAdditionalModelOptionsCacheByProfile: cacheByProfile,
      openaiAdditionalModelOptionsCache: nextActiveId
        ? getModelCacheByProfile(nextActiveId, {
            ...current,
            openaiAdditionalModelOptionsCacheByProfile: cacheByProfile,
          })
        : [],
      projects: nextProjects,
    }
  })

  return {
    removed,
    activeProfileId: nextActiveProfile?.id,
  }
}

export function getActiveOpenAIModelOptionsCache(
  config = getGlobalConfig(),
): ModelOption[] {
  const activeProfile = getActiveProviderProfile(config)

  if (!activeProfile) {
    return config.openaiAdditionalModelOptionsCache ?? []
  }

  const cached = config.openaiAdditionalModelOptionsCacheByProfile?.[
    activeProfile.id
  ]
  if (cached) {
    return cached
  }

  // Backward compatibility for users who have only the legacy single cache.
  if (
    Object.keys(config.openaiAdditionalModelOptionsCacheByProfile ?? {}).length ===
    0
  ) {
    return config.openaiAdditionalModelOptionsCache ?? []
  }

  return []
}

export function setActiveOpenAIModelOptionsCache(options: ModelOption[]): void {
  const activeProfile = getActiveProviderProfile()

  if (!activeProfile) {
    saveGlobalConfig(current => ({
      ...current,
      openaiAdditionalModelOptionsCache: options,
    }))
    return
  }

  saveGlobalConfig(current => ({
    ...current,
    openaiAdditionalModelOptionsCache: options,
    openaiAdditionalModelOptionsCacheByProfile: {
      ...(current.openaiAdditionalModelOptionsCacheByProfile ?? {}),
      [activeProfile.id]: options,
    },
  }))
}

export function clearActiveOpenAIModelOptionsCache(): void {
  const activeProfile = getActiveProviderProfile()

  if (!activeProfile) {
    saveGlobalConfig(current => ({
      ...current,
      openaiAdditionalModelOptionsCache: [],
    }))
    return
  }

  saveGlobalConfig(current => {
    const cacheByProfile = {
      ...(current.openaiAdditionalModelOptionsCacheByProfile ?? {}),
    }
    delete cacheByProfile[activeProfile.id]

    return {
      ...current,
      openaiAdditionalModelOptionsCache: [],
      openaiAdditionalModelOptionsCacheByProfile: cacheByProfile,
    }
  })
}
