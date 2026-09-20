import * as React from 'react'
import { GithubDeviceFlowStep } from 'src/commands/provider/GithubDeviceFlowStep.js'
import {
  DEFAULT_CODEX_BASE_URL,
  DEFAULT_XAI_BASE_URL,
} from 'src/providers/presets/providerConfig.js'
import { Box, Text } from 'src/terminal/ink.js'
import { useKeybinding } from 'src/terminal/keybindings/useKeybinding.js'
import { useSetAppState } from 'src/terminal/state/AppState.js'
import { suppressNextMainLoopModelPersist } from 'src/terminal/state/onChangeAppState.js'
import type { ProviderProfile } from 'src/platform/config/config.js'
import {
  clearCodexCredentials,
  readCodexCredentialsAsync,
} from 'src/providers/oauth/codexCredentials.js'
import { isBareMode } from 'src/shared/envUtils.js'
import { getPrimaryModel } from 'src/providers/presets/providerModels.js'
import { getDefaultMainLoopModel } from 'src/providers/model/model.js'
import { deleteProfileFile } from 'src/providers/presets/providerProfile.js'
import {
  addProviderProfile,
  deleteProviderProfile,
  getActiveProviderProfile,
  getGlobalActiveProviderProfileId,
  getProjectActiveProviderProfileId,
  hasProjectProviderProfileOverride,
  getProviderPresetDefaults,
  getProviderProfiles,
  setActiveProviderProfile,
  setActiveProviderProfileForProject,
  type ProviderPreset,
  type ProviderProfileInput,
  updateProviderProfile,
} from 'src/providers/presets/providerProfiles.js'
import { clearGithubModelsToken } from 'src/providers/oauth/githubModelsCredentials.js'
import {
  buildDiscoveredModelOptions,
  describeDiscoveryFailure,
  listOpenAICompatibleModelsDetailed,
  probeAtomicChatReadiness,
  probeOllamaGenerationReadiness,
} from 'src/providers/presets/providerDiscovery.js'
import {
  rankOllamaModels,
  recommendOllamaModel,
} from 'src/providers/presets/providerRecommendation.js'
import {
  SearchableSelect,
  Select,
} from 'src/terminal/custom-select/index.js'
import { Pane } from 'src/terminal/design-system/Pane.js'
import { MigrationBanner } from 'src/platform/MigrationBanner.js'
import {
  CodexOAuthSetup,
  KimiOAuthSetup,
  XaiOAuthSetup,
} from 'src/providers/ui/OAuthSetup.js'
import {
  clearXaiCredentials,
  readXaiCredentials,
} from 'src/providers/oauth/xaiCredentials.js'
import {
  clearKimiCredentials,
  readKimiCredentials,
} from 'src/providers/oauth/kimiCredentials.js'
import {
  legacyClaudeDirExists,
  shouldShowMigrationBanner,
} from 'src/platform/config/claudinMigration.js'
import type {
  AtomicChatSelectionState,
  CloudExtrasDraft,
  DraftField,
  OllamaSelectionState,
  OpenAiModelSelectionState,
  ProviderDraft,
  ProviderManagerResult,
  Screen,
} from 'src/providers/ui/ProviderManager.types.js'
import {
  CODEX_OAUTH_PROVIDER_MODEL,
  CODEX_OAUTH_PROVIDER_NAME,
  FORM_STEPS,
  KIMI_OAUTH_BASE_URL,
  KIMI_OAUTH_PROVIDER_MODEL,
  KIMI_OAUTH_PROVIDER_NAME,
  MODEL_DISCOVERY_EXCLUDED_PROVIDERS,
  PROFILE_FAVORITES,
  XAI_OAUTH_PROVIDER_MODEL,
  XAI_OAUTH_PROVIDER_NAME,
} from 'src/providers/ui/providerManagerConstants.js'
import {
  buildExtrasFromDrafts,
  customHeadersToText,
  presetToDraft,
  profileSummary,
  toDraft,
} from 'src/providers/ui/providerDrafts.js'
import {
  describeAtomicChatSelectionIssue,
  describeOllamaSelectionIssue,
  findCodexOAuthProfile,
  findKimiOAuthProfile,
  findXaiOAuthProfile,
  isCodexOAuthProfile,
} from 'src/providers/ui/providerLookups.js'
import {
  AnthropicAuthChoiceScreen,
  AnthropicOAuthScreen,
  KimiAuthChoiceScreen,
} from 'src/providers/ui/screens/AuthChoice.js'
import {
  CloudExtrasScreen,
  CustomHeadersScreen,
  FormScreen,
} from 'src/providers/ui/screens/FormScreens.js'
import {
  AtomicChatSelectionScreen,
  OllamaSelectionScreen,
  OpenAiModelSelectionScreen,
} from 'src/providers/ui/screens/ModelSelection.js'
import { PresetSelectionScreen } from 'src/providers/ui/screens/PresetSelection.js'

/** Re-exported for ProviderManager.test.tsx, which imports it from this path. */
export { parseCustomHeaders } from 'src/providers/ui/providerDrafts.js'
/** Re-exported for src/commands/provider/provider.tsx, its only consumer. */
export type { ProviderManagerResult }

type Props = {
  mode: 'first-run' | 'manage'
  onDone: (result?: ProviderManagerResult) => void
}

export function ProviderManager({ mode, onDone }: Props): React.ReactNode {
  const setAppState = useSetAppState()

  // Deferred initialization: useState initializers run synchronously during
  // render, so getProviderProfiles() and getActiveProviderProfile() would block
  // the UI on first mount (sync file I/O). Use empty initial values and load
  // asynchronously in useEffect with queueMicrotask to keep UI responsive.
  const [profiles, setProfiles] = React.useState<ProviderProfile[]>([])
  const [activeProfileId, setActiveProfileId] = React.useState<string | undefined>()
  const [projectActiveProfileId, setProjectActiveProfileId] = React.useState<
    string | undefined
  >()
  // Tracks whether *any* project-level override is set, even if it points to
  // a missing profile. Used to keep the "Clear project override" affordance
  // visible so the user can recover from a stale override.
  const [hasProjectOverride, setHasProjectOverride] = React.useState(false)
  const [globalActiveProfileId, setGlobalActiveProfileId] = React.useState<
    string | undefined
  >()
  const codexRefreshEpochRef = React.useRef(0)
  const [screen, setScreen] = React.useState<Screen>(
    mode === 'first-run' ? 'select-preset' : 'menu',
  )
  const [editingProfileId, setEditingProfileId] = React.useState<string | null>(null)
  const [draftProvider, setDraftProvider] = React.useState<ProviderProfile['provider']>(
    'openai',
  )
  const [draft, setDraft] = React.useState<ProviderDraft>(() =>
    presetToDraft('ollama'),
  )
  const [draftExtras, setDraftExtras] = React.useState<CloudExtrasDraft>({})
  const [draftCustomHeaders, setDraftCustomHeaders] = React.useState<string>('')
  const [cloudExtrasCursor, setCloudExtrasCursor] = React.useState(0)
  const [customHeadersCursor, setCustomHeadersCursor] = React.useState(0)
  const [pendingPreset, setPendingPreset] = React.useState<ProviderPreset | null>(null)
  const [cloudExtrasStepIndex, setCloudExtrasStepIndex] = React.useState(0)
  const [formStepIndex, setFormStepIndex] = React.useState(0)
  const [cursorOffset, setCursorOffset] = React.useState(0)
  const [statusMessage, setStatusMessage] = React.useState<string | undefined>()
  const [errorMessage, setErrorMessage] = React.useState<string | undefined>()
  const [menuFocusValue, setMenuFocusValue] = React.useState<string | undefined>()
  const [hasStoredCodexOAuthCredentials, setHasStoredCodexOAuthCredentials] =
    React.useState(false)
  const [storedCodexOAuthProfileId, setStoredCodexOAuthProfileId] =
    React.useState<string | undefined>()
  const [ollamaSelection, setOllamaSelection] = React.useState<OllamaSelectionState>({
    state: 'idle',
  })
  const [atomicChatSelection, setAtomicChatSelection] =
    React.useState<AtomicChatSelectionState>({ state: 'idle' })
  const [openAiModelSelection, setOpenAiModelSelection] =
    React.useState<OpenAiModelSelectionState>({ state: 'idle' })
  // Deferred initialization: useState initializers run synchronously during
  // render, so getProviderProfiles() and getActiveProviderProfile() would block
  // the UI (sync file I/O). Defer to queueMicrotask after first render.
  // In test environment, skip defer to avoid timing issues with mocks.
  const [isInitializing, setIsInitializing] = React.useState(
    process.env.NODE_ENV !== 'test',
  )
  const [isActivating, setIsActivating] = React.useState(false)
  const isRefreshingRef = React.useRef(false)
  const [canImportLegacyClaude, setCanImportLegacyClaude] = React.useState(
    () => legacyClaudeDirExists(),
  )
  // Migration banner is decided once at mount. In tests we skip the homedir
  // probe entirely so dev machines with a real ~/.claude/ don't have the
  // banner take over the first-run provider screen under test.
  const [migrationActive, setMigrationActive] = React.useState(() =>
    process.env.NODE_ENV === 'test' ? false : shouldShowMigrationBanner(),
  )

  React.useEffect(() => {
    // Skip deferred initialization in test environment (mocks are synchronous)
    if (process.env.NODE_ENV === 'test') {
      setProfiles(getProviderProfiles())
      setActiveProfileId(getActiveProviderProfile()?.id)
      setProjectActiveProfileId(getProjectActiveProviderProfileId())
      setGlobalActiveProfileId(getGlobalActiveProviderProfileId())
      setHasProjectOverride(hasProjectProviderProfileOverride())
      setIsInitializing(false)
      return
    }

    queueMicrotask(() => {
      const profilesData = getProviderProfiles()
      const activeId = getActiveProviderProfile()?.id
      setProfiles(profilesData)
      setActiveProfileId(activeId)
      setProjectActiveProfileId(getProjectActiveProviderProfileId())
      setGlobalActiveProfileId(getGlobalActiveProviderProfileId())
      setHasProjectOverride(hasProjectProviderProfileOverride())
      setIsInitializing(false)
    })
  }, [])

  const currentStep = FORM_STEPS[formStepIndex] ?? FORM_STEPS[0]
  const currentStepKey = currentStep.key

  // Memoize menu options to prevent unnecessary re-renders when navigating
  // the select menu. Without this, each arrow key press creates a new options
  // array reference, causing Select to re-render and feel sluggish.
  const hasProfiles = profiles.length > 0
  const hasSelectableProviders = hasProfiles
  const menuOptions = React.useMemo(
    () => [
      {
        value: 'add',
        label: 'Add provider',
        description: 'Create a new provider profile',
      },
      {
        value: 'activate',
        label: 'Set active provider (Global)',
        description: globalActiveProfileId
          ? `Currently: ${profiles.find(p => p.id === globalActiveProfileId)?.name ?? 'unknown'}`
          : 'Default profile for projects without an override',
        disabled: !hasSelectableProviders,
      },
      {
        value: 'activate-project',
        label: 'Set active provider (Project)',
        description: projectActiveProfileId
          ? `Currently: ${profiles.find(p => p.id === projectActiveProfileId)?.name ?? 'unknown'} (this project)`
          : 'Override the global default for this project only',
        disabled: !hasSelectableProviders,
      },
      ...(hasProjectOverride
        ? [
            {
              value: 'clear-project-override',
              label: 'Clear project provider override',
              description: projectActiveProfileId
                ? 'Stop overriding for this project; fall back to global'
                : 'Project override points to a missing profile; clear it',
            },
          ]
        : []),
      {
        value: 'edit',
        label: 'Edit provider',
        description: 'Update URL, model, or key',
        disabled: !hasProfiles,
      },
      {
        value: 'delete',
        label: 'Delete provider',
        description: 'Remove a provider profile',
        disabled: !hasSelectableProviders,
      },
      ...(hasStoredCodexOAuthCredentials
        ? [
            {
              value: 'logout-codex-oauth',
              label: 'Log out Codex OAuth',
              description: 'Clear securely stored Codex OAuth credentials',
            },
          ]
        : []),
      {
        value: 'done',
        label: 'Done',
        description: 'Return to chat',
      },
    ],
    [
      hasSelectableProviders,
      hasProfiles,
      hasStoredCodexOAuthCredentials,
      globalActiveProfileId,
      projectActiveProfileId,
      profiles,
    ],
  )

  const refreshCodexOAuthCredentialState = React.useCallback((): void => {
    if (isBareMode()) {
      codexRefreshEpochRef.current += 1
      setHasStoredCodexOAuthCredentials(false)
      setStoredCodexOAuthProfileId(undefined)
      return
    }

    const refreshEpoch = ++codexRefreshEpochRef.current
    void (async () => {
      const credentials = await readCodexCredentialsAsync()
      if (refreshEpoch !== codexRefreshEpochRef.current) {
        return
      }

      setHasStoredCodexOAuthCredentials(
        Boolean(
          credentials?.apiKey ||
            credentials?.accessToken ||
            credentials?.refreshToken ||
            credentials?.idToken,
        ),
      )
      setStoredCodexOAuthProfileId(credentials?.profileId)
    })()
  }, [])

  React.useEffect(() => {
    refreshCodexOAuthCredentialState()

    return () => {
      codexRefreshEpochRef.current += 1
    }
  }, [refreshCodexOAuthCredentialState])

  React.useEffect(() => {
    if (screen !== 'select-ollama-model') {
      return
    }

    let cancelled = false
    setOllamaSelection({ state: 'loading' })

    void (async () => {
      const readiness = await probeOllamaGenerationReadiness({
        baseUrl: draft.baseUrl,
      })
      if (readiness.state !== 'ready') {
        if (!cancelled) {
          setOllamaSelection({
            state: 'unavailable',
            message: describeOllamaSelectionIssue(readiness, draft.baseUrl),
          })
        }
        return
      }

      const ranked = rankOllamaModels(readiness.models, 'balanced')
      const recommended = recommendOllamaModel(readiness.models, 'balanced')
      if (!cancelled) {
        setOllamaSelection({
          state: 'ready',
          defaultValue: recommended?.name ?? ranked[0]?.name,
          options: ranked.map(model => ({
            label: model.name,
            value: model.name,
            description: model.summary,
          })),
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [draft.baseUrl, screen])

  React.useEffect(() => {
    if (screen !== 'select-atomic-chat-model') {
      return
    }

    let cancelled = false
    setAtomicChatSelection({ state: 'loading' })

    void (async () => {
      const readiness = await probeAtomicChatReadiness({
        baseUrl: draft.baseUrl,
      })
      if (readiness.state !== 'ready') {
        if (!cancelled) {
          setAtomicChatSelection({
            state: 'unavailable',
            message: describeAtomicChatSelectionIssue(readiness, draft.baseUrl),
          })
        }
        return
      }

      if (!cancelled) {
        setAtomicChatSelection({
          state: 'ready',
          defaultValue: readiness.models[0],
          options: readiness.models.map(model => ({
            label: model,
            value: model,
          })),
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [draft.baseUrl, screen])

  React.useEffect(() => {
    if (screen !== 'select-openai-model') {
      return
    }

    let cancelled = false
    setOpenAiModelSelection({ state: 'loading' })

    void (async () => {
      const result = await listOpenAICompatibleModelsDetailed({
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey || undefined,
      })
      if (cancelled) {
        return
      }
      if (!result.ok) {
        setOpenAiModelSelection({
          state: 'unavailable',
          message: describeDiscoveryFailure(result),
        })
        return
      }

      const { options, defaultValue } = buildDiscoveredModelOptions(
        result.ids,
        draft.model,
      )
      setOpenAiModelSelection({ state: 'ready', options, defaultValue })
    })()

    return () => {
      cancelled = true
    }
    // draft.model is read for the initial focus only and never changes while
    // this screen is mounted, so it is intentionally excluded from the deps to
    // avoid a spurious re-fetch.
  }, [draft.baseUrl, draft.apiKey, screen])

  function refreshProfiles(): void {
    // Defer sync I/O to next microtask to prevent UI freeze.
    // getProviderProfiles() and getActiveProviderProfile() read config files
    // synchronously, which can block the main thread on Windows (antivirus, disk cache).
    // queueMicrotask ensures the current render completes first.
    if (isRefreshingRef.current) return
    isRefreshingRef.current = true

    queueMicrotask(() => {
      const nextProfiles = getProviderProfiles()
      setProfiles(nextProfiles)
      setActiveProfileId(getActiveProviderProfile()?.id)
      setProjectActiveProfileId(getProjectActiveProviderProfileId())
      setGlobalActiveProfileId(getGlobalActiveProviderProfileId())
      setHasProjectOverride(hasProjectProviderProfileOverride())
      refreshCodexOAuthCredentialState()
      isRefreshingRef.current = false
    })
  }

  function clearStartupProviderOverrideFromUserSettings(): string | null {
    // Provider-routing envs are no longer read at runtime, so no settings.env
    // sweep is needed. Function preserved as a no-op for the multiple call
    // sites below.
    return null
  }

  function buildCodexOAuthActivationMessage(options: {
    prefix: string
    activationWarning: string | null
    warnings: string[]
  }): string {
    if (options.activationWarning) {
      return `${options.prefix}. Saved for next startup. Warning: ${options.warnings.join('; ')}.`
    }

    if (options.warnings.length > 0) {
      return `${options.prefix}. Claudin switched to it for this session with warnings: ${options.warnings.join('; ')}.`
    }

    return `${options.prefix}. Claudin switched to it for this session.`
  }

  async function activateCodexOAuthSession(tokens?: {
    accessToken: string
    refreshToken?: string
    accountId?: string
    idToken?: string
  }): Promise<string | null> {
    // Codex OAuth credentials live in profile.extras (codexAuthPath /
    // codexAccountId). Activating a Codex profile is identical to activating
    // any other — setActiveProviderProfile already happened upstream — so
    // this hook exists only to surface a hint when stored credentials are
    // missing.
    if (tokens?.accessToken && tokens.accountId) {
      return null
    }

    const storedCredentials = await readCodexCredentialsAsync()
    if (!storedCredentials) {
      return 'stored Codex OAuth credentials could not be loaded'
    }
    if (!storedCredentials.accountId) {
      return 'stored Codex OAuth credentials are missing a ChatGPT account id'
    }
    return null
  }

  function clearPersistedCodexOAuthProfile(): void {
    // Removes the legacy .claudin-profile.json sidecar if present;
    // current profiles live in providerProfiles[] inside settings.
    deleteProfileFile()
  }

  async function activateSelectedProvider(profileId: string): Promise<void> {
    let providerLabel = 'provider'

    // Set loading state before sync I/O to keep UI responsive
    setIsActivating(true)
    setStatusMessage('Activating provider...')

    try {
      // Defer sync I/O to next microtask - UI renders loading state first.
      // setActiveProviderProfile() and clearStartupProviderOverrideFromUserSettings()
      // perform sync file writes (saveGlobalConfig, saveProfileFile,
      // updateSettingsForSource) which can block the main thread on Windows
      // (antivirus, disk cache, NTFS metadata).
      await new Promise<void>(resolve => queueMicrotask(resolve))

      // Capture override state BEFORE writing the global default so we know
      // whether this activation will actually be the effective profile for
      // the current project. If a project override exists, the resolver still
      // returns the override profile, and we must not push a session model
      // sourced from the new global default (would mismatch transport).
      const overrideActive = hasProjectProviderProfileOverride()

      const active = setActiveProviderProfile(profileId)
      if (!active) {
        setErrorMessage('Could not change active provider.')
        setIsActivating(false)
        returnToMenu()
        return
      }

      // Only refresh the session model when the activated profile is the one
      // the current project will actually use. With an override in place, the
      // effective profile remains the override target — touching mainLoopModel
      // here would send wrong-shape requests on the next turn.
      const effectiveProfile = overrideActive
        ? (getActiveProviderProfile() ?? active)
        : active
      // A profile with a blank model (e.g. the Anthropic preset, whose model is
      // resolved dynamically) must fall back to the provider's default model,
      // not leave mainLoopModel empty — an empty value inherits the previous
      // provider's stale model (e.g. keeping gpt-4o after switching to Anthropic).
      const newModel =
        getPrimaryModel(effectiveProfile.model) || getDefaultMainLoopModel()
      if (!overrideActive) {
        setAppState(prev => ({
          ...prev,
          mainLoopModel: newModel,
          mainLoopModelForSession: null,
        }))
      }
      providerLabel = active.name
      const settingsOverrideError =
        clearStartupProviderOverrideFromUserSettings()
      const isActiveCodexOAuth = isCodexOAuthProfile(
        active,
        storedCodexOAuthProfileId,
      )
      const activationWarning = isActiveCodexOAuth
        ? await activateCodexOAuthSession()
        : null

      refreshProfiles()
      const overrideNote =
        overrideActive && effectiveProfile.id !== active.id
          ? ` (project override still active — this project keeps using ${effectiveProfile.name}; use "Clear project provider override" to apply the new default here)`
          : ''
      const activationMessage = isActiveCodexOAuth
        ? buildCodexOAuthActivationMessage({
            prefix: `Active provider: ${active.name}${overrideNote}`,
            activationWarning,
            warnings: [
              activationWarning,
              settingsOverrideError
                ? `could not clear startup provider override (${settingsOverrideError})`
                : null,
            ].filter((warning): warning is string => Boolean(warning)),
          })
        : settingsOverrideError
          ? `Active provider: ${active.name}${overrideNote}. Warning: could not clear startup provider override (${settingsOverrideError}).`
          : `Active provider: ${active.name}${overrideNote}`
      setStatusMessage(activationMessage)
      setIsActivating(false)
      onDone({
        action: 'activated',
        activeProfileId: active.id,
        activeProviderName: active.name,
        activeProviderModel: newModel,
        message: `Provider switched to ${active.name} (${newModel})`,
      })
      returnToMenu()
    } catch (error) {
      refreshProfiles()
      setStatusMessage(undefined)
      setIsActivating(false)
      const detail = error instanceof Error ? error.message : String(error)
      setErrorMessage(`Could not finish activating ${providerLabel}: ${detail}`)
      returnToMenu()
    }
  }

  async function clearProjectProviderOverride(): Promise<void> {
    setIsActivating(true)
    setStatusMessage('Clearing project provider override...')

    try {
      await new Promise<void>(resolve => queueMicrotask(resolve))

      setActiveProviderProfileForProject(null)
      refreshProfiles()
      const nowEffective = getActiveProviderProfile()
      if (nowEffective) {
        const newModel =
          getPrimaryModel(nowEffective.model) || getDefaultMainLoopModel()
        // Suppress the /model persistence side-effect: clearing a project
        // override is NOT a /model choice. Without this, onChangeAppState
        // would clobber the user's prior global settings.model and overwrite
        // the global profile's model field with the override-clear fallback.
        suppressNextMainLoopModelPersist()
        setAppState(prev => ({
          ...prev,
          mainLoopModel: newModel,
          mainLoopModelForSession: null,
        }))
        setStatusMessage(
          `Project override cleared. Using global default: ${nowEffective.name}.`,
        )
        setIsActivating(false)
        onDone({
          action: 'activated',
          activeProfileId: nowEffective.id,
          activeProviderName: nowEffective.name,
          activeProviderModel: newModel,
          message: `Project override cleared — using ${nowEffective.name} (${newModel})`,
        })
        returnToMenu()
      } else {
        setStatusMessage(
          'Project provider override cleared. No global default set.',
        )
        setIsActivating(false)
        // The clear *did* succeed — a config change happened, the caller
        // should refresh. 'cancelled' would be wrong (callers branch on it to
        // skip side-effects); 'saved' matches the "config change, nothing
        // newly active" case used elsewhere in this component.
        onDone({
          action: 'saved',
          message:
            'Project provider override cleared. No global default set.',
        })
        returnToMenu()
      }
    } catch (error) {
      refreshProfiles()
      setStatusMessage(undefined)
      setIsActivating(false)
      const detail = error instanceof Error ? error.message : String(error)
      setErrorMessage(`Could not clear project provider override: ${detail}`)
      returnToMenu()
    }
  }

  async function activateSelectedProviderForProject(
    profileId: string,
  ): Promise<void> {
    let providerLabel = 'provider'
    setIsActivating(true)
    setStatusMessage('Setting provider for this project...')

    try {
      // Same rationale as activateSelectedProvider: defer sync I/O so the
      // loading state renders before saveGlobalConfig blocks the main thread.
      await new Promise<void>(resolve => queueMicrotask(resolve))

      // Read from disk, not React state — projectActiveProfileId is hydrated
      // via queueMicrotask in refreshProfiles and may be stale here. A stale
      // read would either suppress persist on a real id switch (clobbering
      // user's /model for the new profile) or fail to suppress on a same-id
      // re-election (clobbering the preserved activeModelForProject).
      const previousProjectProfileId = getProjectActiveProviderProfileId()
      const active = setActiveProviderProfileForProject(profileId)
      if (!active) {
        setErrorMessage('Could not set project provider override.')
        setIsActivating(false)
        returnToMenu()
        return
      }

      const newModel =
        getPrimaryModel(active.model) || getDefaultMainLoopModel()
      // Re-selecting the same project profile preserves `activeModelForProject`
      // inside setActiveProviderProfileForProject; suppress the persist side of
      // the upcoming setAppState so onChangeAppState's project-scoped branch
      // doesn't overwrite that preserved per-project /model with the primary.
      if (previousProjectProfileId === active.id) {
        suppressNextMainLoopModelPersist()
      }
      setAppState(prev => ({
        ...prev,
        mainLoopModel: newModel,
        mainLoopModelForSession: null,
      }))
      providerLabel = active.name
      const settingsOverrideError =
        clearStartupProviderOverrideFromUserSettings()
      const isActiveCodexOAuth = isCodexOAuthProfile(
        active,
        storedCodexOAuthProfileId,
      )
      const activationWarning = isActiveCodexOAuth
        ? await activateCodexOAuthSession()
        : null

      refreshProfiles()
      const baseMsg = `Active provider for this project: ${active.name}. Other projects keep the global default.`
      const activationMessage = isActiveCodexOAuth
        ? buildCodexOAuthActivationMessage({
            prefix: baseMsg,
            activationWarning,
            warnings: [
              activationWarning,
              settingsOverrideError
                ? `could not clear startup provider override (${settingsOverrideError})`
                : null,
            ].filter((warning): warning is string => Boolean(warning)),
          })
        : settingsOverrideError
          ? `${baseMsg} Warning: could not clear startup provider override (${settingsOverrideError}).`
          : baseMsg
      setStatusMessage(activationMessage)
      setIsActivating(false)
      onDone({
        action: 'activated',
        activeProfileId: active.id,
        activeProviderName: active.name,
        activeProviderModel: newModel,
        message: `Provider switched to ${active.name} (${newModel}) for this project`,
      })
      returnToMenu()
    } catch (error) {
      refreshProfiles()
      setStatusMessage(undefined)
      setIsActivating(false)
      const detail = error instanceof Error ? error.message : String(error)
      setErrorMessage(
        `Could not finish setting ${providerLabel} for this project: ${detail}`,
      )
      returnToMenu()
    }
  }

  function returnToMenu(): void {
    setMenuFocusValue('done')
    setScreen('menu')
  }

  function closeWithCancelled(message: string): void {
    onDone({ action: 'cancelled', message })
  }

  function startCreateFromPreset(preset: ProviderPreset): void {
    const defaults = getProviderPresetDefaults(preset)
    const nextDraft = {
      name: defaults.name,
      baseUrl: defaults.baseUrl,
      model: defaults.model,
      apiKey: defaults.apiKey ?? '',
    }
    setEditingProfileId(null)
    setDraftProvider(defaults.provider ?? 'openai')
    setDraft(nextDraft)
    setDraftExtras({})
    setDraftCustomHeaders('')
    setPendingPreset(preset)
    setFormStepIndex(0)
    setCloudExtrasStepIndex(0)
    setCursorOffset(nextDraft.name.length)
    setErrorMessage(undefined)

    if (preset === 'ollama') {
      setOllamaSelection({ state: 'loading' })
      setScreen('select-ollama-model')
      return
    }

    if (preset === 'atomic-chat') {
      setAtomicChatSelection({ state: 'loading' })
      setScreen('select-atomic-chat-model')
      return
    }

    if (preset === 'anthropic') {
      setScreen('anthropic-auth-choice')
      return
    }

    if (preset === 'bedrock' || preset === 'vertex' || preset === 'foundry') {
      setScreen('cloud-extras')
      return
    }

    setScreen('form')
  }

  function startEditProfile(profileId: string): void {
    const existing = profiles.find(profile => profile.id === profileId)
    if (!existing) {
      return
    }

    const nextDraft = toDraft(existing)
    setEditingProfileId(profileId)
    setDraftProvider(existing.provider ?? 'openai')
    setDraft(nextDraft)
    setDraftExtras({
      awsRegion: existing.extras?.awsRegion,
      gcpProject: existing.extras?.gcpProject,
      gcpRegion: existing.extras?.gcpRegion,
      azureResource: existing.extras?.azureResource,
    })
    setDraftCustomHeaders(customHeadersToText(existing.extras?.customHeaders))
    setPendingPreset(null)
    setFormStepIndex(0)
    setCloudExtrasStepIndex(0)
    setCursorOffset(nextDraft.name.length)
    setErrorMessage(undefined)
    setScreen('form')
  }

  function persistDraft(nextDraft: ProviderDraft = draft): void {
    const builtExtras = buildExtrasFromDrafts(draftExtras, draftCustomHeaders)
    const payload: ProviderProfileInput = {
      provider: draftProvider,
      name: nextDraft.name,
      baseUrl: nextDraft.baseUrl,
      model: nextDraft.model,
      apiKey: nextDraft.apiKey,
      extras: builtExtras,
    }

    // Adding from the /provider menu must not hijack the global active
    // pointer — only the first-run wizard (nothing configured yet) activates
    // what it creates. Activation stays an explicit menu action.
    const saved = editingProfileId
      ? updateProviderProfile(editingProfileId, payload)
      : addProviderProfile(payload, { makeActive: mode === 'first-run' })

    if (!saved) {
      setErrorMessage('Could not save provider. Fill all required fields.')
      return
    }

    const isActiveSavedProfile = getActiveProviderProfile()?.id === saved.id
    if (isActiveSavedProfile) {
      // Editing a profile is never a `/model` choice — suppress unconditionally
      // so onChangeAppState updates only the bootstrap override (so the next
      // turn resolves against the saved primary) without clobbering the user's
      // prior `/model` selection. WITH a project override active, the
      // project-scoped branch would overwrite `activeModelForProject`. WITHOUT
      // an override, the global branch would replace the user's `settings.model`
      // (which may be an alias like 'sonnet') with the profile's canonical
      // primary. Both are wrong: a profile edit must not pretend to be a
      // `/model` invocation.
      suppressNextMainLoopModelPersist()
      setAppState(prev => ({
        ...prev,
        mainLoopModel: getPrimaryModel(saved.model),
        mainLoopModelForSession: null,
      }))
    }
    const settingsOverrideError = isActiveSavedProfile
      ? clearStartupProviderOverrideFromUserSettings()
      : null

    refreshProfiles()
    const overrideMaskingNew =
      mode === 'first-run' &&
      !editingProfileId &&
      hasProjectProviderProfileOverride() &&
      !isActiveSavedProfile
    const overrideTargetName = overrideMaskingNew
      ? (getActiveProviderProfile()?.name ?? 'override target')
      : null
    const addedMessage =
      mode === 'first-run'
        ? `Added provider: ${saved.name} (now active)`
        : `Added provider: ${saved.name} (active provider unchanged)`
    const successMessage = editingProfileId
      ? `Updated provider: ${saved.name}`
      : overrideMaskingNew
        ? `Added provider: ${saved.name} (now global default — project keeps using ${overrideTargetName}; use "Clear project provider override" to apply here)`
        : addedMessage
    setStatusMessage(
      settingsOverrideError
        ? `${successMessage}. Warning: could not clear startup provider override (${settingsOverrideError}).`
        : successMessage,
    )

    if (mode === 'first-run') {
      onDone({
        action: 'saved',
        activeProfileId: saved.id,
        message: `Provider configured: ${saved.name}`,
      })
      return
    }

    setEditingProfileId(null)
    setFormStepIndex(0)
    setErrorMessage(undefined)
    returnToMenu()
  }

  function goToFormStep(key: DraftField): void {
    const index = FORM_STEPS.findIndex(step => step.key === key)
    setFormStepIndex(index < 0 ? 0 : index)
    setCursorOffset(draft[key].length)
    setErrorMessage(undefined)
    setScreen('form')
  }

  // Fall back to the free-text model step. When creating from a preset, the
  // draft model still holds the preset's hardcoded default — a value the
  // provider's /models endpoint just failed to confirm, so keeping it invites
  // saving a model that may not exist. Clear it; an edit of an existing
  // profile (or a preset-less draft) keeps its value.
  function goToManualModelStep(): void {
    if (
      !editingProfileId &&
      pendingPreset &&
      draft.model === presetToDraft(pendingPreset).model
    ) {
      const cleared = { ...draft, model: '' }
      setDraft(cleared)
      goToFormStep('model')
      setCursorOffset(0)
      return
    }
    goToFormStep('model')
  }

  function finishAfterModelStep(nextDraft: ProviderDraft): void {
    if (pendingPreset === 'anthropic' || pendingPreset === 'custom') {
      // Offer the optional custom-headers screen before save for presets where
      // extra HTTP headers are commonly needed (Anthropic gateways, third-party
      // OpenAI-compatible deployments).
      setDraft(nextDraft)
      setScreen('custom-headers')
      return
    }

    persistDraft(nextDraft)
  }

  function handleFormSubmit(value: string): void {
    const trimmed = value.trim()

    if (!currentStep.optional && trimmed.length === 0) {
      setErrorMessage(`${currentStep.label} is required.`)
      return
    }

    const nextDraft = {
      ...draft,
      [currentStepKey]: trimmed,
    }

    setDraft(nextDraft)
    setErrorMessage(undefined)

    if (formStepIndex < FORM_STEPS.length - 1) {
      const nextIndex = formStepIndex + 1
      const nextKey = FORM_STEPS[nextIndex]?.key ?? 'name'
      // For OpenAI-compatible providers, skip the free-text model step and let
      // the user pick from the provider's /models list instead. Needs a base URL
      // to query; a blank one falls through to the plain text step.
      if (
        nextKey === 'model' &&
        !MODEL_DISCOVERY_EXCLUDED_PROVIDERS.has(draftProvider) &&
        nextDraft.baseUrl.trim().length > 0
      ) {
        setScreen('select-openai-model')
        return
      }
      setFormStepIndex(nextIndex)
      setCursorOffset(nextDraft[nextKey].length)
      return
    }

    finishAfterModelStep(nextDraft)
  }

  function handleBackFromForm(): void {
    setErrorMessage(undefined)

    if (formStepIndex > 0) {
      const nextIndex = formStepIndex - 1
      const nextKey = FORM_STEPS[nextIndex]?.key ?? 'name'
      setFormStepIndex(nextIndex)
      setCursorOffset(draft[nextKey].length)
      return
    }

    if (mode === 'first-run') {
      setScreen('select-preset')
      return
    }

    returnToMenu()
  }

  useKeybinding('confirm:no', handleBackFromForm, {
    context: 'Settings',
    isActive: screen === 'form',
  })

  // While the model list is still loading there is no Select to catch Esc, so
  // handle it here: an impatient user jumps straight to typing the model id
  // instead of waiting out the discovery timeout. Once loaded, the Select's own
  // onCancel handles Esc (back to the API key step).
  useKeybinding('confirm:no', () => goToManualModelStep(), {
    context: 'Settings',
    isActive:
      screen === 'select-openai-model' &&
      (openAiModelSelection.state === 'loading' ||
        openAiModelSelection.state === 'idle'),
  })

  function handleBackFromCloudExtras(): void {
    setErrorMessage(undefined)
    if (cloudExtrasStepIndex > 0) {
      setCloudExtrasStepIndex(cloudExtrasStepIndex - 1)
      return
    }
    setScreen('select-preset')
  }
  useKeybinding('confirm:no', handleBackFromCloudExtras, {
    context: 'Settings',
    isActive: screen === 'cloud-extras',
  })

  useKeybinding('confirm:no', () => setScreen('form'), {
    context: 'Settings',
    isActive: screen === 'custom-headers',
  })

  useKeybinding('confirm:no', () => setScreen('select-preset'), {
    context: 'Settings',
    isActive:
      screen === 'anthropic-auth-choice' ||
      screen === 'anthropic-oauth' ||
      screen === 'kimi-auth-choice',
  })

  useKeybinding('confirm:no', () => setScreen('kimi-auth-choice'), {
    context: 'Settings',
    isActive: screen === 'kimi-oauth',
  })

  function renderMenu(): React.ReactNode {
    // Use memoized menuOptions from component scope
    const hasProfiles = profiles.length > 0
    const hasSelectableProviders = hasProfiles

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          Provider manager
        </Text>
        <Text dimColor>
          Active profile controls base URL, model, and API key used by this session.
        </Text>
        {statusMessage && <Text>{statusMessage}</Text>}
        <Box flexDirection="column">
          {profiles.length === 0 ? (
            <Text dimColor>No provider profiles configured yet.</Text>
          ) : (
            profiles.map(profile => (
              <Text key={profile.id} dimColor>
                - {profile.name}: {profileSummary(profile, profile.id === activeProfileId)}
              </Text>
            ))
          )}
        </Box>
        <Select
          options={menuOptions}
          onChange={(value: string) => {
            setErrorMessage(undefined)
            switch (value) {
              case 'add':
                setScreen('select-preset')
                break
              case 'activate':
                if (hasSelectableProviders) {
                  setScreen('select-active')
                }
                break
              case 'activate-project':
                if (hasSelectableProviders) {
                  setScreen('select-active-project')
                }
                break
              case 'clear-project-override':
                void clearProjectProviderOverride()
                break
              case 'edit':
                if (hasProfiles) {
                  setScreen('select-edit')
                }
                break
              case 'delete':
                if (hasSelectableProviders) {
                  setScreen('select-delete')
                }
                break
              case 'logout-codex-oauth': {
                const cleared = clearCodexCredentials()
                if (!cleared.success) {
                  setErrorMessage(
                    cleared.warning ??
                      'Could not clear Codex OAuth credentials.',
                  )
                  break
                }

                setHasStoredCodexOAuthCredentials(false)
                setStoredCodexOAuthProfileId(undefined)
                const codexProfile = findCodexOAuthProfile(
                  getProviderProfiles(),
                  storedCodexOAuthProfileId,
                )
                let settingsOverrideError: string | null = null
                if (codexProfile) {
                  const result = deleteProviderProfile(codexProfile.id)
                  if (!result.removed) {
                    setErrorMessage(
                      'Codex OAuth credentials were cleared, but the Codex profile could not be removed.',
                    )
                    refreshProfiles()
                    break
                  }

                  clearPersistedCodexOAuthProfile()
                  settingsOverrideError = result.activeProfileId
                    ? clearStartupProviderOverrideFromUserSettings()
                    : null
                }

                refreshProfiles()
                setStatusMessage(
                  settingsOverrideError
                    ? `Codex OAuth logged out. Warning: could not clear startup provider override (${settingsOverrideError}).`
                    : 'Codex OAuth logged out.',
                )
                break
              }
              default:
                closeWithCancelled('Provider manager closed')
                break
            }
          }}
          onCancel={() => closeWithCancelled('Provider manager closed')}
          defaultFocusValue={menuFocusValue}
          visibleOptionCount={menuOptions.length}
        />
      </Box>
    )
  }

  function renderProfileSelection(
    title: string,
    emptyMessage: string,
    onSelect: (profileId: string) => void,
  ): React.ReactNode {
    const selectOptions = profiles.map(profile => {
      const labelTags: string[] = []
      if (profile.id === activeProfileId) labelTags.push('active')
      // Always surface "this project" when an override is set, so the user
      // can see it even when the override matches the global default.
      if (projectActiveProfileId && profile.id === projectActiveProfileId) {
        labelTags.push('this project')
      }
      if (globalActiveProfileId && profile.id === globalActiveProfileId) {
        labelTags.push('global default')
      }
      const suffix = labelTags.length > 0 ? ` (${labelTags.join(', ')})` : ''
      return {
        value: profile.id,
        label: `${profile.name}${suffix}`,
        description: `${profile.provider === 'anthropic' ? 'anthropic' : 'openai-compatible'} · ${profile.baseUrl} · ${profile.model}`,
      }
    })

    if (selectOptions.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>
            {title}
          </Text>
          <Text dimColor>{emptyMessage}</Text>
          <Select
            options={[
              {
                value: 'back',
                label: 'Back',
                description: 'Return to provider manager',
              },
            ]}
            onChange={() => returnToMenu()}
            onCancel={() => returnToMenu()}
            visibleOptionCount={1}
          />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          {title}
        </Text>
        <SearchableSelect
          options={selectOptions}
          favorites={PROFILE_FAVORITES}
          searchPlaceholder="Search providers…"
          onChange={onSelect}
          onCancel={() => returnToMenu()}
          visibleOptionCount={Math.min(10, Math.max(2, selectOptions.length))}
        />
      </Box>
    )
  }

  let content: React.ReactNode

  switch (screen) {
    case 'select-preset':
      content = (
        <PresetSelectionScreen
          mode={mode}
          onDone={onDone}
          canImportLegacyClaude={canImportLegacyClaude}
          setScreen={setScreen}
          setCanImportLegacyClaude={setCanImportLegacyClaude}
          setErrorMessage={setErrorMessage}
          setStatusMessage={setStatusMessage}
          closeWithCancelled={closeWithCancelled}
          refreshProfiles={refreshProfiles}
          returnToMenu={returnToMenu}
          startCreateFromPreset={startCreateFromPreset}
        />
      )
      break
    case 'select-ollama-model':
      content = (
        <OllamaSelectionScreen
          selection={ollamaSelection}
          draft={draft}
          setDraft={setDraft}
          setScreen={setScreen}
          setFormStepIndex={setFormStepIndex}
          setCursorOffset={setCursorOffset}
          persistDraft={persistDraft}
        />
      )
      break
    case 'select-openai-model':
      content = (
        <OpenAiModelSelectionScreen
          openAiModelSelection={openAiModelSelection}
          draft={draft}
          setDraft={setDraft}
          goToFormStep={goToFormStep}
          goToManualModelStep={goToManualModelStep}
          finishAfterModelStep={finishAfterModelStep}
        />
      )
      break
    case 'select-atomic-chat-model':
      content = (
        <AtomicChatSelectionScreen
          selection={atomicChatSelection}
          draft={draft}
          setDraft={setDraft}
          setScreen={setScreen}
          setFormStepIndex={setFormStepIndex}
          setCursorOffset={setCursorOffset}
          persistDraft={persistDraft}
        />
      )
      break
    case 'codex-oauth':
      content = (
        <CodexOAuthSetup
          onBack={() => setScreen('select-preset')}
          onConfigured={async (tokens, persistCredentials) => {
            const payload: ProviderProfileInput = {
              provider: 'openai',
              name: CODEX_OAUTH_PROVIDER_NAME,
              baseUrl: DEFAULT_CODEX_BASE_URL,
              model: CODEX_OAUTH_PROVIDER_MODEL,
              apiKey: '',
            }

            const existing = findCodexOAuthProfile(
              getProviderProfiles(),
              storedCodexOAuthProfileId,
            )
            // Adding from the /provider menu must not hijack the global active
            // pointer — only the first-run wizard activates what it creates.
            const activateOnSave = mode === 'first-run'
            const saved = existing
              ? updateProviderProfile(existing.id, payload)
              : addProviderProfile(payload, { makeActive: activateOnSave })

            if (!saved) {
              setErrorMessage(
                'Codex OAuth login finished, but the provider profile could not be saved.',
              )
              returnToMenu()
              return
            }

            const active =
              activateOnSave && existing && activeProfileId !== saved.id
                ? setActiveProviderProfile(saved.id)
                : saved
            if (!active) {
              setErrorMessage(
                'Codex OAuth login finished, but the provider could not be set as the startup provider.',
              )
              returnToMenu()
              return
            }

            persistCredentials({ profileId: saved.id })
            setHasStoredCodexOAuthCredentials(true)
            setStoredCodexOAuthProfileId(saved.id)
            refreshProfiles()
            let message: string
            if (!activateOnSave) {
              // Manage mode saved the profile without activating it — no
              // session switch happened, so don't claim one.
              message = `Codex OAuth configured: ${saved.name} (active provider unchanged — activate it from "Set active provider")`
            } else {
              const settingsOverrideError =
                clearStartupProviderOverrideFromUserSettings()
              const activationWarning = await activateCodexOAuthSession(tokens)
              const warnings = [
                activationWarning,
                settingsOverrideError
                  ? `could not clear startup provider override (${settingsOverrideError})`
                  : null,
              ].filter((warning): warning is string => Boolean(warning))
              message = buildCodexOAuthActivationMessage({
                prefix: 'Codex OAuth configured',
                activationWarning,
                warnings,
              })
            }

            if (mode === 'first-run') {
              onDone({
                action: 'saved',
                activeProfileId: active.id,
                message,
              })
              return
            }

            setStatusMessage(message)
            setErrorMessage(undefined)
            returnToMenu()
          }}
        />
      )
      break
    case 'xai-oauth':
      content = (
        <XaiOAuthSetup
          onBack={() => setScreen('select-preset')}
          onConfigured={async (_tokens, persistCredentials) => {
            const payload: ProviderProfileInput = {
              provider: 'openai',
              name: XAI_OAUTH_PROVIDER_NAME,
              baseUrl: DEFAULT_XAI_BASE_URL,
              model: XAI_OAUTH_PROVIDER_MODEL,
              apiKey: '',
            }

            // Update the existing xAI profile on re-login instead of appending a
            // duplicate.
            const existing = findXaiOAuthProfile(
              getProviderProfiles(),
              readXaiCredentials()?.profileId,
            )
            // Adding from the /provider menu must not hijack the global active
            // pointer — only the first-run wizard activates what it creates.
            const activateOnSave = mode === 'first-run'
            const saved = existing
              ? updateProviderProfile(existing.id, payload)
              : addProviderProfile(payload, { makeActive: activateOnSave })

            if (!saved) {
              setErrorMessage(
                'xAI OAuth login finished, but the provider profile could not be saved.',
              )
              returnToMenu()
              return
            }

            // updateProviderProfile keeps the current active pointer, so make the
            // (re-)configured xAI profile active explicitly when it isn't
            // already — but only when this flow is allowed to activate.
            const active =
              activateOnSave && existing && activeProfileId !== saved.id
                ? setActiveProviderProfile(saved.id)
                : saved
            if (!active) {
              setErrorMessage(
                'xAI OAuth login finished, but the provider could not be set as the startup provider.',
              )
              returnToMenu()
              return
            }

            try {
              persistCredentials({ profileId: saved.id })
            } catch (error) {
              setErrorMessage(
                error instanceof Error ? error.message : String(error),
              )
              returnToMenu()
              return
            }

            // Refresh menu state so the new profile shows up and becomes
            // selectable as the active one.
            refreshProfiles()
            const message = activateOnSave
              ? `xAI / Grok configured. Claudin switched to it for this session.`
              : `xAI / Grok configured: ${saved.name} (active provider unchanged — activate it from "Set active provider")`

            if (mode === 'first-run') {
              onDone({
                action: 'saved',
                activeProfileId: active.id,
                message,
              })
              return
            }

            setStatusMessage(message)
            setErrorMessage(undefined)
            returnToMenu()
          }}
        />
      )
      break
    case 'kimi-auth-choice':
      content = (
        <KimiAuthChoiceScreen
          setScreen={setScreen}
          startCreateFromPreset={startCreateFromPreset}
        />
      )
      break
    case 'kimi-oauth':
      content = (
        <KimiOAuthSetup
          onBack={() => setScreen('kimi-auth-choice')}
          onConfigured={async (_tokens, persistCredentials) => {
            const payload: ProviderProfileInput = {
              provider: 'openai',
              name: KIMI_OAUTH_PROVIDER_NAME,
              baseUrl: KIMI_OAUTH_BASE_URL,
              model: KIMI_OAUTH_PROVIDER_MODEL,
              apiKey: '',
            }

            // Update the existing Kimi profile on re-login (refreshes the model
            // list) instead of appending a duplicate.
            const existing = findKimiOAuthProfile(
              getProviderProfiles(),
              readKimiCredentials()?.profileId,
            )
            // Adding from the /provider menu must not hijack the global active
            // pointer — only the first-run wizard activates what it creates.
            const activateOnSave = mode === 'first-run'
            const saved = existing
              ? updateProviderProfile(existing.id, payload)
              : addProviderProfile(payload, { makeActive: activateOnSave })

            if (!saved) {
              setErrorMessage(
                'Kimi Code OAuth login finished, but the provider profile could not be saved.',
              )
              returnToMenu()
              return
            }

            // updateProviderProfile keeps the current active pointer, so make the
            // (re-)configured Kimi profile active explicitly when it isn't
            // already — but only when this flow is allowed to activate.
            const active =
              activateOnSave && existing && activeProfileId !== saved.id
                ? setActiveProviderProfile(saved.id)
                : saved
            if (!active) {
              setErrorMessage(
                'Kimi Code OAuth login finished, but the provider could not be set as the startup provider.',
              )
              returnToMenu()
              return
            }

            try {
              persistCredentials({ profileId: saved.id })
            } catch (error) {
              setErrorMessage(
                error instanceof Error ? error.message : String(error),
              )
              returnToMenu()
              return
            }

            refreshProfiles()
            const message = activateOnSave
              ? `Kimi Code configured. Claudin switched to it for this session.`
              : `Kimi Code configured: ${saved.name} (active provider unchanged — activate it from "Set active provider")`

            if (mode === 'first-run') {
              onDone({
                action: 'saved',
                activeProfileId: active.id,
                message,
              })
              return
            }

            setStatusMessage(message)
            setErrorMessage(undefined)
            returnToMenu()
          }}
        />
      )
      break
    case 'github-onboard':
      content = (
        <GithubDeviceFlowStep
          activateOnSave={mode === 'first-run'}
          onDone={message => {
            if (message) {
              setStatusMessage(message)
              setErrorMessage(undefined)
            }
            refreshProfiles()
            returnToMenu()
          }}
          onBack={() => setScreen('select-preset')}
          onChangeAPIKey={refreshProfiles}
        />
      )
      break
    case 'anthropic-auth-choice':
      content = <AnthropicAuthChoiceScreen setScreen={setScreen} />
      break
    case 'anthropic-oauth':
      content = (
        <AnthropicOAuthScreen
          mode={mode}
          onDone={onDone}
          activeProfileId={activeProfileId}
          setErrorMessage={setErrorMessage}
          setScreen={setScreen}
          setStatusMessage={setStatusMessage}
          refreshProfiles={refreshProfiles}
          returnToMenu={returnToMenu}
        />
      )
      break
    case 'cloud-extras':
      content = (
        <CloudExtrasScreen
          pendingPreset={pendingPreset}
          cloudExtrasStepIndex={cloudExtrasStepIndex}
          draftExtras={draftExtras}
          cloudExtrasCursor={cloudExtrasCursor}
          errorMessage={errorMessage}
          setDraftExtras={setDraftExtras}
          setCloudExtrasStepIndex={setCloudExtrasStepIndex}
          setCloudExtrasCursor={setCloudExtrasCursor}
          setErrorMessage={setErrorMessage}
          setScreen={setScreen}
        />
      )
      break
    case 'custom-headers':
      content = (
        <CustomHeadersScreen
          draftCustomHeaders={draftCustomHeaders}
          draft={draft}
          customHeadersCursor={customHeadersCursor}
          errorMessage={errorMessage}
          setDraftCustomHeaders={setDraftCustomHeaders}
          setCustomHeadersCursor={setCustomHeadersCursor}
          persistDraft={persistDraft}
        />
      )
      break
    case 'form':
      content = (
        <FormScreen
          formStepIndex={formStepIndex}
          draft={draft}
          setDraft={setDraft}
          setCursorOffset={setCursorOffset}
          cursorOffset={cursorOffset}
          editingProfileId={editingProfileId}
          draftProvider={draftProvider}
          errorMessage={errorMessage}
          handleFormSubmit={handleFormSubmit}
        />
      )
      break
    case 'select-active':
      content = renderProfileSelection(
        'Set active provider (Global)',
        'No providers available. Add one first.',
        profileId => {
          void activateSelectedProvider(profileId)
        },
      )
      break
    case 'select-active-project':
      content = renderProfileSelection(
        'Set active provider (Project)',
        'No providers available. Add one first.',
        profileId => {
          void activateSelectedProviderForProject(profileId)
        },
      )
      break
    case 'select-edit':
      content = renderProfileSelection(
        'Edit provider',
        'No providers available. Add one first.',
        profileId => {
          startEditProfile(profileId)
        },
      )
      break
    case 'select-delete':
      content = renderProfileSelection(
        'Delete provider',
        'No providers available. Add one first.',
        profileId => {
          const targetProfile = profiles.find(p => p.id === profileId)
          const deletedCopilotProfile =
            targetProfile?.provider === 'openai' &&
            targetProfile?.extras?.githubToken !== undefined
          const deletedCodexOAuthProfile =
            findCodexOAuthProfile(
              profiles,
              storedCodexOAuthProfileId,
            )?.id === profileId
          // Only treat this as an OAuth deletion when (a) the profile points at
          // xAI, (b) it has no static API key (OAuth profiles persist apiKey as
          // undefined), and (c) the stored OAuth profileId matches. Otherwise
          // deleting a static-key xAI profile would wipe an unrelated OAuth
          // session's `.credentials.json` entry.
          const storedXaiOAuthProfileId = readXaiCredentials()?.profileId
          const deletedXaiOAuthProfile =
            targetProfile?.provider === 'openai' &&
            targetProfile.baseUrl === DEFAULT_XAI_BASE_URL &&
            !targetProfile.apiKey &&
            storedXaiOAuthProfileId === profileId
          const storedKimiOAuthProfileId = readKimiCredentials()?.profileId
          const deletedKimiOAuthProfile =
            targetProfile?.provider === 'openai' &&
            targetProfile.baseUrl === KIMI_OAUTH_BASE_URL &&
            !targetProfile.apiKey &&
            storedKimiOAuthProfileId === profileId
          // Snapshot whether the deletion will change the resolved active
          // profile for this session — used below to push a fresh
          // mainLoopModel so the next request doesn't go out with a
          // wrong-transport model string left over from the deleted profile.
          const wasActiveForSession =
            getActiveProviderProfile()?.id === profileId
          const result = deleteProviderProfile(profileId)
          if (!result.removed) {
            setErrorMessage('Could not delete provider.')
          } else {
            const warnings: string[] = []
            if (deletedCodexOAuthProfile) {
              const cleared = clearCodexCredentials()
              if (!cleared.success) {
                warnings.push(
                  cleared.warning ??
                    'could not clear Codex OAuth credentials',
                )
              } else {
                setStoredCodexOAuthProfileId(undefined)
              }
              clearPersistedCodexOAuthProfile()
            }
            if (deletedCopilotProfile) {
              const cleared = clearGithubModelsToken()
              if (!cleared.success) {
                warnings.push(
                  cleared.warning ??
                    'could not clear GitHub Copilot token',
                )
              }
            }
            if (deletedXaiOAuthProfile) {
              const cleared = clearXaiCredentials()
              if (!cleared.success) {
                warnings.push(
                  cleared.warning ?? 'could not clear xAI OAuth credentials',
                )
              }
            }
            if (deletedKimiOAuthProfile) {
              const cleared = clearKimiCredentials()
              if (!cleared.success) {
                warnings.push(
                  cleared.warning ?? 'could not clear Kimi Code OAuth credentials',
                )
              }
            }
            const settingsOverrideError = result.activeProfileId
              ? clearStartupProviderOverrideFromUserSettings()
              : null
            if (settingsOverrideError) {
              warnings.push(
                `could not clear startup provider override (${settingsOverrideError})`,
              )
            }
            refreshProfiles()
            // If the deleted profile was the one actively resolving for this
            // session, push the new fallback's primary model into AppState so
            // the next API request uses a model that matches the new active
            // profile's transport. Suppress persistence: the user did not
            // make a /model choice — just deleted a profile.
            if (wasActiveForSession) {
              const nextActive = getActiveProviderProfile()
              if (nextActive) {
                suppressNextMainLoopModelPersist()
                setAppState(prev => ({
                  ...prev,
                  mainLoopModel: getPrimaryModel(nextActive.model),
                  mainLoopModelForSession: null,
                }))
              } else {
                // No profiles left: clear the override so the default
                // resolver kicks in on the next turn.
                suppressNextMainLoopModelPersist()
                setAppState(prev => ({
                  ...prev,
                  mainLoopModel: null,
                  mainLoopModelForSession: null,
                }))
              }
            }
            setStatusMessage(
              warnings.length > 0
                ? `Provider deleted. Warning: ${warnings.join('; ')}.`
                : 'Provider deleted',
            )
          }
          returnToMenu()
        },
      )
      break
    case 'menu':
    default:
      content = renderMenu()
      break
  }

  return (
    <Pane color="permission">
      <MigrationBanner
        enabled={migrationActive}
        onDismiss={outcome => {
          setCanImportLegacyClaude(legacyClaudeDirExists())
          setMigrationActive(false)
          refreshProfiles()
          const active = getActiveProviderProfile()
          if (outcome === 'migrated' && mode === 'first-run' && active) {
            onDone({
              action: 'saved',
              activeProfileId: active.id,
              activeProviderName: active.name,
              activeProviderModel: active.model,
            })
          }
        }}
      />
      {migrationActive ? null : isInitializing ? (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>Loading providers...</Text>
          <Text dimColor>Reading provider profiles from disk.</Text>
        </Box>
      ) : isActivating ? (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>Activating provider...</Text>
          <Text dimColor>Please wait while the provider is being configured.</Text>
        </Box>
      ) : (
        content
      )}
    </Pane>
  )
}
