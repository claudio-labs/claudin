import figures from 'figures'
import * as React from 'react'
import { GithubDeviceFlowStep } from '../commands/provider/GithubDeviceFlowStep.js'
import { DEFAULT_CODEX_BASE_URL } from '../services/api/providerConfig.js'
import { Box, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useSetAppState } from '../state/AppState.js'
import type { ProviderProfile } from '../utils/config.js'
import {
  clearCodexCredentials,
  readCodexCredentialsAsync,
} from '../utils/codexCredentials.js'
import { isBareMode } from '../utils/envUtils.js'
import { getPrimaryModel, parseModelList } from '../utils/providerModels.js'
import { deleteProfileFile } from '../utils/providerProfile.js'
import {
  addProviderProfile,
  deleteProviderProfile,
  getActiveProviderProfile,
  getProviderPresetDefaults,
  getProviderProfiles,
  setActiveProviderProfile,
  type ProviderPreset,
  type ProviderProfileInput,
  updateProviderProfile,
} from '../utils/providerProfiles.js'
import {
  clearGithubModelsToken,
  hydrateGithubModelsTokenFromSecureStorage,
  readGithubModelsTokenAsync,
} from '../utils/githubModelsCredentials.js'
import {
  probeAtomicChatReadiness,
  probeOllamaGenerationReadiness,
  type AtomicChatReadiness,
  type OllamaGenerationReadiness,
} from '../utils/providerDiscovery.js'
import {
  rankOllamaModels,
  recommendOllamaModel,
} from '../utils/providerRecommendation.js'
import { redactUrlForDisplay } from '../utils/urlRedaction.js'
import {
  type OptionWithDescription,
  Select,
} from './CustomSelect/index.js'
import { Pane } from './design-system/Pane.js'
import { MigrationBanner } from './MigrationBanner.js'
import TextInput from './TextInput.js'
import { useCodexOAuthFlow } from './useCodexOAuthFlow.js'
import {
  formatMigrationReport,
  legacyClaudeDirExists,
  migrateLegacyClaudeDir,
  shouldShowMigrationBanner,
} from '../utils/claudioMigration.js'

export type ProviderManagerResult = {
  action: 'saved' | 'cancelled' | 'activated'
  activeProfileId?: string
  activeProviderName?: string
  activeProviderModel?: string
  message?: string
}

type Props = {
  mode: 'first-run' | 'manage'
  onDone: (result?: ProviderManagerResult) => void
}

type Screen =
  | 'menu'
  | 'select-preset'
  | 'select-ollama-model'
  | 'select-atomic-chat-model'
  | 'codex-oauth'
  | 'github-onboard'
  | 'anthropic-auth-choice'
  | 'anthropic-oauth'
  | 'cloud-extras'
  | 'custom-headers'
  | 'form'
  | 'select-active'
  | 'select-edit'
  | 'select-delete'

type DraftField = 'name' | 'baseUrl' | 'model' | 'apiKey'

type ProviderDraft = Record<DraftField, string>

type CloudExtrasField =
  | 'awsRegion'
  | 'gcpProject'
  | 'gcpRegion'
  | 'azureResource'

type CloudExtrasDraft = Partial<Record<CloudExtrasField, string>>

type OllamaSelectionState =
  | { state: 'idle' }
  | { state: 'loading' }
  | {
      state: 'ready'
      options: OptionWithDescription<string>[]
      defaultValue?: string
    }
  | { state: 'unavailable'; message: string }

type AtomicChatSelectionState =
  | { state: 'idle' }
  | { state: 'loading' }
  | {
      state: 'ready'
      options: OptionWithDescription<string>[]
      defaultValue?: string
    }
  | { state: 'unavailable'; message: string }

const FORM_STEPS: Array<{
  key: DraftField
  label: string
  placeholder: string
  helpText: string
  optional?: boolean
}> = [
  {
    key: 'name',
    label: 'Provider name',
    placeholder: 'e.g. Ollama Home, OpenAI Work',
    helpText: 'A short label shown in /provider and startup setup.',
  },
  {
    key: 'baseUrl',
    label: 'Base URL',
    placeholder: 'e.g. http://localhost:11434/v1',
    helpText: 'API base URL used for this provider profile.',
  },
  {
    key: 'model',
    label: 'Default model',
    placeholder: 'e.g. llama3.1:8b or glm-4.7; glm-4.7-flash',
    helpText: 'Model name(s) to use. Separate multiple with ";" or ","; first is default.',
  },
  {
    key: 'apiKey',
    label: 'API key',
    placeholder: 'Leave empty if your provider does not require one',
    helpText: 'Optional. Press Enter with empty value to skip.',
    optional: true,
  },
]

const GITHUB_PROVIDER_ID = '__github_models__'
const GITHUB_PROVIDER_LABEL = 'GitHub Copilot'
const GITHUB_PROVIDER_DEFAULT_MODEL = 'github:copilot'
const GITHUB_PROVIDER_DEFAULT_BASE_URL = 'https://models.github.ai/inference'
const CODEX_OAUTH_PROVIDER_NAME = 'Codex OAuth'
const CODEX_OAUTH_PROVIDER_MODEL = 'codexplan'

type GithubCredentialSource = 'stored' | 'env' | 'none'

function toDraft(profile: ProviderProfile): ProviderDraft {
  return {
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKey: profile.apiKey ?? '',
  }
}

function presetToDraft(preset: ProviderPreset): ProviderDraft {
  const defaults = getProviderPresetDefaults(preset)
  return {
    name: defaults.name,
    baseUrl: defaults.baseUrl,
    model: defaults.model,
    apiKey: defaults.apiKey ?? '',
  }
}

export function parseCustomHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (key && value) {
      out[key] = value
    }
  }
  return out
}

function customHeadersToText(
  headers: Record<string, string> | undefined,
): string {
  if (!headers) return ''
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

function buildExtrasFromDrafts(
  cloudExtras: CloudExtrasDraft,
  customHeadersText: string,
): ProviderProfile['extras'] | undefined {
  const extras: NonNullable<ProviderProfile['extras']> = {}
  const awsRegion = cloudExtras.awsRegion?.trim()
  if (awsRegion) extras.awsRegion = awsRegion
  const gcpProject = cloudExtras.gcpProject?.trim()
  if (gcpProject) extras.gcpProject = gcpProject
  const gcpRegion = cloudExtras.gcpRegion?.trim()
  if (gcpRegion) extras.gcpRegion = gcpRegion
  const azureResource = cloudExtras.azureResource?.trim()
  if (azureResource) extras.azureResource = azureResource
  const headers = parseCustomHeaders(customHeadersText)
  if (Object.keys(headers).length > 0) {
    extras.customHeaders = headers
  }
  return Object.keys(extras).length > 0 ? extras : undefined
}

const CLOUD_EXTRAS_STEPS: Record<
  'bedrock' | 'vertex' | 'foundry',
  ReadonlyArray<{
    key: CloudExtrasField
    label: string
    placeholder: string
    helpText: string
  }>
> = {
  bedrock: [
    {
      key: 'awsRegion',
      label: 'AWS region',
      placeholder: 'e.g. us-east-1',
      helpText:
        'Region of your Bedrock-enabled AWS account. Credentials are picked up from the AWS SDK chain.',
    },
  ],
  vertex: [
    {
      key: 'gcpProject',
      label: 'GCP project ID',
      placeholder: 'e.g. my-project-123456',
      helpText:
        'Google Cloud project where Vertex AI is enabled. Credentials are picked up from ADC.',
    },
    {
      key: 'gcpRegion',
      label: 'GCP region',
      placeholder: 'e.g. us-central1',
      helpText: 'Vertex AI region for the model.',
    },
  ],
  foundry: [
    {
      key: 'azureResource',
      label: 'Azure resource',
      placeholder: 'e.g. my-foundry-resource',
      helpText:
        'Name of your Azure AI Foundry resource. Credentials are picked up from DefaultAzureCredential.',
    },
  ],
}

function profileSummary(profile: ProviderProfile, isActive: boolean): string {
  const activeSuffix = isActive ? ' (active)' : ''
  const keyInfo = profile.apiKey ? 'key set' : 'no key'
  const providerKind =
    profile.provider === 'anthropic' ? 'anthropic' : 'openai-compatible'
  const models = parseModelList(profile.model)
  const modelDisplay =
    models.length <= 3
      ? models.join(', ')
      : `${models[0]}, ${models[1]} + ${models.length - 2} more`
  return `${providerKind} · ${profile.baseUrl} · ${modelDisplay} · ${keyInfo}${activeSuffix}`
}

function getGithubCredentialSourceFromEnv(): GithubCredentialSource {
  return 'none'
}

async function resolveGithubCredentialSource(): Promise<GithubCredentialSource> {
  if (await readGithubModelsTokenAsync()) {
    return 'stored'
  }
  return 'none'
}

function isGithubProviderAvailable(
  credentialSource: GithubCredentialSource,
): boolean {
  return credentialSource !== 'none'
}

function getGithubProviderModel(): string {
  return GITHUB_PROVIDER_DEFAULT_MODEL
}

function getGithubProviderSummary(
  isActive: boolean,
  credentialSource: GithubCredentialSource,
): string {
  const credentialSummary =
    credentialSource === 'stored'
      ? 'token stored'
      : credentialSource === 'env'
        ? 'token via env'
        : 'no token found'
  const activeSuffix = isActive ? ' (active)' : ''
  return `github-models · ${GITHUB_PROVIDER_DEFAULT_BASE_URL} · ${getGithubProviderModel()} · ${credentialSummary}${activeSuffix}`
}

function describeAtomicChatSelectionIssue(
  readiness: AtomicChatReadiness,
  baseUrl: string,
): string {
  if (readiness.state === 'unreachable') {
    return `Could not reach Atomic Chat at ${redactUrlForDisplay(baseUrl)}. Start the Atomic Chat app first, or enter the endpoint manually.`
  }

  if (readiness.state === 'no_models') {
    return 'Atomic Chat is running, but no models are loaded. Download and load a model inside the Atomic Chat app first, or enter details manually.'
  }

  return ''
}

function describeOllamaSelectionIssue(
  readiness: OllamaGenerationReadiness,
  baseUrl: string,
): string {
  if (readiness.state === 'unreachable') {
    return `Could not reach Ollama at ${redactUrlForDisplay(baseUrl)}. Start Ollama first, or enter the endpoint manually.`
  }

  if (readiness.state === 'no_models') {
    return 'Ollama is running, but no installed models were found. Pull a chat model such as qwen2.5-coder:7b or llama3.1:8b first, or enter details manually.'
  }

  if (readiness.state === 'generation_failed') {
    const modelHint = readiness.probeModel ?? 'the selected model'
    const detailSuffix = readiness.detail
      ? ` Details: ${readiness.detail}.`
      : ''
    return `Ollama is reachable and models are installed, but a generation probe failed for ${modelHint}.${detailSuffix} Run "ollama run ${modelHint}" once and retry, or enter details manually.`
  }

  return ''
}

function findCodexOAuthProfile(
  profiles: ProviderProfile[],
  profileId?: string,
): ProviderProfile | undefined {
  if (!profileId) {
    return undefined
  }

  return profiles.find(profile => profile.id === profileId)
}

function isCodexOAuthProfile(
  profile: ProviderProfile | null | undefined,
  profileId?: string,
): boolean {
  return Boolean(profile && profileId && profile.id === profileId)
}

function CodexOAuthSetup({
  onBack,
  onConfigured,
}: {
  onBack: () => void
  onConfigured: (tokens: {
    accessToken: string
    refreshToken: string
    accountId?: string
    idToken?: string
    apiKey?: string
  }, persistCredentials: (options?: { profileId?: string }) => void) => void | Promise<void>
}): React.ReactNode {
  const handleAuthenticated = React.useCallback(async (tokens: {
    accessToken: string
    refreshToken: string
    accountId?: string
    idToken?: string
    apiKey?: string
  }, persistCredentials: (options?: { profileId?: string }) => void) => {
    await onConfigured(tokens, persistCredentials)
  }, [onConfigured])
  useKeybinding('confirm:no', onBack, [onBack])

  const status = useCodexOAuthFlow({
    onAuthenticated: handleAuthenticated,
  })

  if (status.state === 'error') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error" bold>
          Codex OAuth failed
        </Text>
        <Text>{status.message}</Text>
        <Text dimColor>Press Enter or Esc to go back.</Text>
        <Select
          options={[
            {
              value: 'back',
              label: 'Back',
              description: 'Return to provider presets',
            },
          ]}
          onChange={onBack}
          onCancel={onBack}
          visibleOptionCount={1}
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text color="remember" bold>
        Codex OAuth
      </Text>
      <Text>
        Sign in with your ChatGPT account in the browser. Claudio will store
        the resulting Codex credentials securely and switch this session to the
        new Codex login when setup completes.
      </Text>
      {status.state === 'starting' ? (
        <Text dimColor>Starting local callback and preparing your browser...</Text>
      ) : status.browserOpened === false ? (
        <>
          <Text color="warning">
            Browser did not open automatically. Visit this URL to continue:
          </Text>
          <Text>{status.authUrl}</Text>
        </>
      ) : status.browserOpened === true ? (
        <>
          <Text dimColor>
            Browser opened. Finish the ChatGPT sign-in there and this setup will
            complete automatically.
          </Text>
          <Text>{status.authUrl}</Text>
        </>
      ) : (
        <Text dimColor>Opening your browser...</Text>
      )}
      <Text dimColor>Press Esc to cancel and go back.</Text>
    </Box>
  )
}

export function ProviderManager({ mode, onDone }: Props): React.ReactNode {
  const setAppState = useSetAppState()
  const initialGithubCredentialSource = getGithubCredentialSourceFromEnv()
  const initialIsGithubActive = false
  const initialHasGithubCredential = initialGithubCredentialSource !== 'none'

  // Deferred initialization: useState initializers run synchronously during
  // render, so getProviderProfiles() and getActiveProviderProfile() would block
  // the UI on first mount (sync file I/O). Use empty initial values and load
  // asynchronously in useEffect with queueMicrotask to keep UI responsive.
  const [profiles, setProfiles] = React.useState<ProviderProfile[]>([])
  const [activeProfileId, setActiveProfileId] = React.useState<string | undefined>()
  const [githubProviderAvailable, setGithubProviderAvailable] = React.useState(
    () => isGithubProviderAvailable(initialGithubCredentialSource),
  )
  const [githubCredentialSource, setGithubCredentialSource] = React.useState<GithubCredentialSource>(
    () => initialGithubCredentialSource,
  )
  const [isGithubActive, setIsGithubActive] = React.useState(() => initialIsGithubActive)
  const [isGithubCredentialSourceResolved, setIsGithubCredentialSourceResolved] =
    React.useState(() => initialHasGithubCredential || initialIsGithubActive)
  const githubRefreshEpochRef = React.useRef(0)
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
      setIsInitializing(false)
      return
    }

    queueMicrotask(() => {
      const profilesData = getProviderProfiles()
      const activeId = getActiveProviderProfile()?.id
      setProfiles(profilesData)
      setActiveProfileId(activeId)
      setIsInitializing(false)
    })
  }, [])

  const currentStep = FORM_STEPS[formStepIndex] ?? FORM_STEPS[0]
  const currentStepKey = currentStep.key
  const currentValue = draft[currentStepKey]

  // Memoize menu options to prevent unnecessary re-renders when navigating
  // the select menu. Without this, each arrow key press creates a new options
  // array reference, causing Select to re-render and feel sluggish.
  const hasProfiles = profiles.length > 0
  const hasSelectableProviders = hasProfiles || githubProviderAvailable
  const menuOptions = React.useMemo(
    () => [
      {
        value: 'add',
        label: 'Add provider',
        description: 'Create a new provider profile',
      },
      ...(canImportLegacyClaude
        ? [
            {
              value: 'import-legacy',
              label: 'Import from Claude Code',
              description:
                'Copy ~/.claude/ tokens, settings, skills, agents, plugins.',
            },
          ]
        : []),
      {
        value: 'activate',
        label: 'Set active provider',
        description: 'Switch the active provider profile',
        disabled: !hasSelectableProviders,
      },
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
      canImportLegacyClaude,
    ],
  )

  const refreshGithubProviderState = React.useCallback((): void => {
    setIsGithubCredentialSourceResolved(false)
    const refreshEpoch = ++githubRefreshEpochRef.current
    void (async () => {
      const credentialSource = await resolveGithubCredentialSource()
      if (refreshEpoch !== githubRefreshEpochRef.current) {
        return
      }

      setGithubCredentialSource(credentialSource)
      setGithubProviderAvailable(isGithubProviderAvailable(credentialSource))
      setIsGithubActive(false)
      setIsGithubCredentialSourceResolved(true)
    })()
  }, [])

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
    refreshGithubProviderState()
    refreshCodexOAuthCredentialState()

    return () => {
      githubRefreshEpochRef.current += 1
      codexRefreshEpochRef.current += 1
    }
  }, [refreshCodexOAuthCredentialState, refreshGithubProviderState])

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
      refreshGithubProviderState()
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
      return `${options.prefix}. Claudio switched to it for this session with warnings: ${options.warnings.join('; ')}.`
    }

    return `${options.prefix}. Claudio switched to it for this session.`
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
    // Removes the legacy .claudio-profile.json sidecar if present;
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
      // setActiveProviderProfile(), activateGithubProvider(), and
      // clearStartupProviderOverrideFromUserSettings() all perform sync file writes
      // (saveGlobalConfig, saveProfileFile, updateSettingsForSource) which can
      // block the main thread on Windows (antivirus, disk cache, NTFS metadata).
      await new Promise<void>(resolve => queueMicrotask(resolve))

      if (profileId === GITHUB_PROVIDER_ID) {
        providerLabel = GITHUB_PROVIDER_LABEL
        const githubError = activateGithubProvider()
        if (githubError) {
          setErrorMessage(`Could not activate GitHub provider: ${githubError}`)
          setIsActivating(false)
          returnToMenu()
          return
        }

        setAppState(prev => ({
          ...prev,
          mainLoopModel: GITHUB_PROVIDER_DEFAULT_MODEL,
          mainLoopModelForSession: null,
        }))
        refreshProfiles()
        setStatusMessage(`Active provider: ${GITHUB_PROVIDER_LABEL}`)
        setIsActivating(false)
        onDone({
          action: 'activated',
          activeProviderName: GITHUB_PROVIDER_LABEL,
          activeProviderModel: GITHUB_PROVIDER_DEFAULT_MODEL,
          message: `Provider switched to ${GITHUB_PROVIDER_LABEL} (${GITHUB_PROVIDER_DEFAULT_MODEL})`,
        })
        returnToMenu()
        return
      }

      const active = setActiveProviderProfile(profileId)
      if (!active) {
        setErrorMessage('Could not change active provider.')
        setIsActivating(false)
        returnToMenu()
        return
      }

      // Update the session model to the new provider's first model.
      // persistActiveProviderProfileModel (called by onChangeAppState) will
      // not overwrite the multi-model list because it checks if the model
      // is already in the provider's configured model list.
      const newModel = getPrimaryModel(active.model)
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
      const activationMessage = isActiveCodexOAuth
        ? buildCodexOAuthActivationMessage({
            prefix: `Active provider: ${active.name}`,
            activationWarning,
            warnings: [
              activationWarning,
              settingsOverrideError
                ? `could not clear startup provider override (${settingsOverrideError})`
                : null,
            ].filter((warning): warning is string => Boolean(warning)),
          })
        : settingsOverrideError
          ? `Active provider: ${active.name}. Warning: could not clear startup provider override (${settingsOverrideError}).`
          : `Active provider: ${active.name}`
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

  function returnToMenu(): void {
    setMenuFocusValue('done')
    setScreen('menu')
  }

  function closeWithCancelled(message: string): void {
    onDone({ action: 'cancelled', message })
  }

  function activateGithubProvider(): string | null {
    // GitHub Copilot is a real preset profile (provider: 'openai' +
    // extras.githubToken), so any user reaching this path already has a real
    // profile via GithubDeviceFlowStep — nothing to flip here.
    hydrateGithubModelsTokenFromSecureStorage()
    return null
  }

  function deleteGithubProvider(): string | null {
    const cleared = clearGithubModelsToken()
    if (!cleared.success) {
      return cleared.warning ?? 'Could not clear GitHub credentials.'
    }
    return null
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

    const saved = editingProfileId
      ? updateProviderProfile(editingProfileId, payload)
      : addProviderProfile(payload, { makeActive: true })

    if (!saved) {
      setErrorMessage('Could not save provider. Fill all required fields.')
      return
    }

    const isActiveSavedProfile = getActiveProviderProfile()?.id === saved.id
    if (isActiveSavedProfile) {
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
    const successMessage =
      editingProfileId
        ? `Updated provider: ${saved.name}`
        : `Added provider: ${saved.name} (now active)`
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

  function renderAtomicChatSelection(): React.ReactNode {
    if (
      atomicChatSelection.state === 'loading' ||
      atomicChatSelection.state === 'idle'
    ) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>
            Checking Atomic Chat
          </Text>
          <Text dimColor>Looking for loaded Atomic Chat models...</Text>
        </Box>
      )
    }

    if (atomicChatSelection.state === 'unavailable') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>
            Atomic Chat setup
          </Text>
          <Text dimColor>{atomicChatSelection.message}</Text>
          <Select
            options={[
              {
                value: 'manual',
                label: 'Enter manually',
                description: 'Fill in the base URL and model yourself',
              },
              {
                value: 'back',
                label: 'Back',
                description: 'Choose another provider preset',
              },
            ]}
            onChange={(value: string) => {
              if (value === 'manual') {
                setFormStepIndex(0)
                setCursorOffset(draft.name.length)
                setScreen('form')
                return
              }
              setScreen('select-preset')
            }}
            onCancel={() => setScreen('select-preset')}
            visibleOptionCount={2}
          />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          Choose an Atomic Chat model
        </Text>
        <Text dimColor>
          Pick one of the models loaded in Atomic Chat to save into a local
          provider profile.
        </Text>
        <Select
          options={atomicChatSelection.options}
          defaultValue={atomicChatSelection.defaultValue}
          defaultFocusValue={atomicChatSelection.defaultValue}
          inlineDescriptions
          visibleOptionCount={Math.min(8, atomicChatSelection.options.length)}
          onChange={(value: string) => {
            const nextDraft = {
              ...draft,
              model: value,
            }
            setDraft(nextDraft)
            persistDraft(nextDraft)
          }}
          onCancel={() => setScreen('select-preset')}
        />
      </Box>
    )
  }

  function renderOllamaSelection(): React.ReactNode {
    if (ollamaSelection.state === 'loading' || ollamaSelection.state === 'idle') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>
            Checking Ollama
          </Text>
          <Text dimColor>Looking for installed Ollama models...</Text>
        </Box>
      )
    }

    if (ollamaSelection.state === 'unavailable') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>
            Ollama setup
          </Text>
          <Text dimColor>{ollamaSelection.message}</Text>
          <Select
            options={[
              {
                value: 'manual',
                label: 'Enter manually',
                description: 'Fill in the base URL and model yourself',
              },
              {
                value: 'back',
                label: 'Back',
                description: 'Choose another provider preset',
              },
            ]}
            onChange={(value: string) => {
              if (value === 'manual') {
                setFormStepIndex(0)
                setCursorOffset(draft.name.length)
                setScreen('form')
                return
              }
              setScreen('select-preset')
            }}
            onCancel={() => setScreen('select-preset')}
            visibleOptionCount={2}
          />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          Choose an Ollama model
        </Text>
        <Text dimColor>
          Pick one of the installed Ollama models to save into a local provider
          profile.
        </Text>
        <Select
          options={ollamaSelection.options}
          defaultValue={ollamaSelection.defaultValue}
          defaultFocusValue={ollamaSelection.defaultValue}
          inlineDescriptions
          visibleOptionCount={Math.min(8, ollamaSelection.options.length)}
          onChange={(value: string) => {
            const nextDraft = {
              ...draft,
              model: value,
            }
            setDraft(nextDraft)
            persistDraft(nextDraft)
          }}
          onCancel={() => setScreen('select-preset')}
        />
      </Box>
    )
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
      setFormStepIndex(nextIndex)
      setCursorOffset(nextDraft[nextKey].length)
      return
    }

    if (
      (pendingPreset === 'anthropic' || pendingPreset === 'custom') &&
      screen === 'form'
    ) {
      // Last step done — offer the optional custom-headers screen before save
      // for presets where extra HTTP headers are commonly needed (Anthropic
      // gateways, third-party OpenAI-compatible deployments).
      setDraft(nextDraft)
      setScreen('custom-headers')
      return
    }

    persistDraft(nextDraft)
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
      screen === 'anthropic-auth-choice' || screen === 'anthropic-oauth',
  })

  function renderPresetSelection(): React.ReactNode {
    const canUseCodexOAuth = !isBareMode()
    // Providers sorted alphabetically by label. `Custom` is pinned to the end
    // because it's the catch-all / escape hatch — users scanning the list
    // should always find known providers first. `Skip for now` (first-run
    // only) comes last, after Custom.
    const options = [
      ...(canImportLegacyClaude
        ? [
            {
              value: 'import-legacy',
              label: 'Import from Claude Code',
              description:
                'Reuse ~/.claude/ tokens, settings, theme, MCP, skills, agents, plugins.',
            },
          ]
        : []),
      {
        value: 'dashscope-intl',
        label: 'Alibaba Coding Plan',
        description: 'Alibaba DashScope International endpoint',
      },
      {
        value: 'dashscope-cn',
        label: 'Alibaba Coding Plan (China)',
        description: 'Alibaba DashScope China endpoint',
      },
      {
        value: 'anthropic',
        label: 'Anthropic',
        description: 'Native Claude API (x-api-key auth)',
      },
      {
        value: 'atomic-chat',
        label: 'Atomic Chat',
        description: 'Local Model Provider',
      },
      {
        value: 'azure-openai',
        label: 'Azure OpenAI',
        description: 'Azure OpenAI endpoint (model=deployment name)',
      },
      {
        value: 'foundry',
        label: 'Azure AI Foundry',
        description: 'Anthropic models hosted on Azure AI Foundry (resource-scoped)',
      },
      {
        value: 'bedrock',
        label: 'AWS Bedrock',
        description: 'Anthropic models on AWS Bedrock (region-scoped, AWS creds)',
      },
      {
        value: 'bankr',
        label: 'Bankr',
        description: 'Bankr LLM Gateway (OpenAI-compatible)',
      },
      ...(canUseCodexOAuth
        ? [
            {
              value: 'codex-oauth',
              label: 'Codex OAuth',
              description:
                'Sign in with ChatGPT in your browser and store Codex credentials securely',
            },
          ]
        : []),
      {
        value: 'github-onboard',
        label: 'GitHub Copilot',
        description: 'Sign in with GitHub in your browser to use Copilot models',
      },
      {
        value: 'deepseek',
        label: 'DeepSeek',
        description: 'DeepSeek OpenAI-compatible endpoint',
      },
      {
        value: 'gemini',
        label: 'Google Gemini',
        description: 'Gemini OpenAI-compatible endpoint',
      },
      {
        value: 'vertex',
        label: 'Google Vertex AI',
        description: 'Anthropic models on Vertex AI (project + region, ADC)',
      },
      {
        value: 'groq',
        label: 'Groq',
        description: 'Groq OpenAI-compatible endpoint',
      },
      {
        value: 'lmstudio',
        label: 'LM Studio',
        description: 'Local LM Studio endpoint',
      },
      {
        value: 'minimax',
        label: 'MiniMax',
        description: 'MiniMax API endpoint',
      },
      {
        value: 'mistral',
        label: 'Mistral',
        description: 'Mistral OpenAI-compatible endpoint',
      },
      {
        value: 'moonshotai',
        label: 'Moonshot AI - API',
        description: 'Moonshot AI - API endpoint',
      },
      {
        value: 'kimi-code',
        label: 'Moonshot AI - Kimi Code',
        description: 'Moonshot AI - Kimi Code Subscription endpoint',
      },
      {
        value: 'nvidia-nim',
        label: 'NVIDIA NIM',
        description: 'NVIDIA NIM endpoint',
      },
      {
        value: 'ollama',
        label: 'Ollama',
        description: 'Local or remote Ollama endpoint',
      },
      {
        value: 'openai',
        label: 'OpenAI',
        description: 'OpenAI API with API key',
      },
      {
        value: 'openrouter',
        label: 'OpenRouter',
        description: 'OpenRouter OpenAI-compatible endpoint',
      },
      {
        value: 'together',
        label: 'Together AI',
        description: 'Together chat/completions endpoint',
      },
      {
        value: 'custom',
        label: 'Custom',
        description: 'Any OpenAI-compatible provider',
      },
      ...(mode === 'first-run'
        ? [
            {
              value: 'skip',
              label: 'Skip for now',
              description: 'Continue with current defaults',
            },
          ]
        : []),
    ]

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          {mode === 'first-run' ? 'Set up provider' : 'Choose provider preset'}
        </Text>
        <Text dimColor>
          Pick a preset, then confirm base URL, model, and API key.
        </Text>
        <Select
          options={options}
          onChange={(value: string) => {
            if (value === 'skip') {
              closeWithCancelled('Provider setup skipped')
              return
            }
            if (value === 'codex-oauth') {
              setScreen('codex-oauth')
              return
            }
            if (value === 'github-onboard') {
              setScreen('github-onboard')
              return
            }
            if (value === 'import-legacy') {
              void (async () => {
                const report = await migrateLegacyClaudeDir({ force: true })
                setCanImportLegacyClaude(legacyClaudeDirExists())
                refreshProfiles()
                const summary = formatMigrationReport(report)
                if (report.errors.length > 0) {
                  setErrorMessage(summary)
                  return
                }
                const active = getActiveProviderProfile()
                if (mode === 'first-run' && active) {
                  onDone({
                    action: 'saved',
                    activeProfileId: active.id,
                    activeProviderName: active.name,
                    activeProviderModel: active.model,
                    message: summary,
                  })
                  return
                }
                setStatusMessage(summary)
                setErrorMessage(undefined)
                if (mode === 'manage') returnToMenu()
              })()
              return
            }
            startCreateFromPreset(value as ProviderPreset)
          }}
          onCancel={() => {
            if (mode === 'first-run') {
              closeWithCancelled('Provider setup skipped')
              return
            }
            returnToMenu()
          }}
          visibleOptionCount={Math.min(13, options.length)}
        />
      </Box>
    )
  }

  function renderAnthropicAuthChoice(): React.ReactNode {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          Anthropic — choose authentication
        </Text>
        <Text dimColor>
          Sign in with your Anthropic account in the browser, or paste an API key.
        </Text>
        <Select
          options={[
            {
              value: 'oauth',
              label: 'Sign in with web (OAuth)',
              description:
                'Open a browser, sign in to Claude, and store tokens in ~/.claudio/.credentials.json',
            },
            {
              value: 'apiKey',
              label: 'Use API key',
              description: 'Paste an x-api-key value (sk-ant-…)',
            },
            {
              value: 'back',
              label: 'Back',
              description: 'Choose a different provider',
            },
          ]}
          onChange={(value: string) => {
            if (value === 'oauth') {
              setScreen('anthropic-oauth')
              return
            }
            if (value === 'apiKey') {
              setScreen('form')
              return
            }
            setScreen('select-preset')
          }}
          onCancel={() => setScreen('select-preset')}
          visibleOptionCount={3}
        />
      </Box>
    )
  }

  function renderAnthropicOAuth(): React.ReactNode {
    // Lazy require to avoid circular import: ConsoleOAuthFlow imports
    // ProviderManager for its `platform_setup` fallback. Resolving the module
    // at render-time breaks the cycle without restructuring either side.
    const ConsoleOAuthFlow = require('./ConsoleOAuthFlow.js')
      .ConsoleOAuthFlow as React.ComponentType<{
      onDone: () => void
      mode?: 'login' | 'setup-token'
    }>

    return (
      <Box flexDirection="column" gap={1}>
        <ConsoleOAuthFlow
          mode="login"
          onDone={() => {
            // OAuth tokens are persisted by ConsoleOAuthFlow / installOAuthTokens.
            // We still want a profile entry so /provider can reference Anthropic
            // explicitly. apiKey stays undefined — the client reads tokens from
            // the credentials file when transport === 'anthropic'.
            const defaults = getProviderPresetDefaults('anthropic')
            const payload: ProviderProfileInput = {
              provider: 'anthropic',
              name: defaults.name,
              baseUrl: defaults.baseUrl,
              model: defaults.model,
            }
            const saved = addProviderProfile(payload, { makeActive: true })
            if (!saved) {
              setErrorMessage(
                'OAuth completed, but the Anthropic profile could not be saved.',
              )
              setScreen('select-preset')
              return
            }
            const message = `Anthropic OAuth configured: ${saved.name}`
            refreshProfiles()
            if (mode === 'first-run') {
              onDone({
                action: 'saved',
                activeProfileId: saved.id,
                message,
              })
              return
            }
            setStatusMessage(message)
            setErrorMessage(undefined)
            returnToMenu()
          }}
        />
      </Box>
    )
  }

  function renderCloudExtras(): React.ReactNode {
    const preset = pendingPreset
    if (preset !== 'bedrock' && preset !== 'vertex' && preset !== 'foundry') {
      return null
    }
    const steps = CLOUD_EXTRAS_STEPS[preset]
    const step = steps[cloudExtrasStepIndex] ?? steps[0]
    const value = draftExtras[step.key] ?? ''

    function onSubmit(submitted: string): void {
      const trimmed = submitted.trim()
      if (trimmed.length === 0) {
        setErrorMessage(`${step.label} is required.`)
        return
      }
      const nextExtras = { ...draftExtras, [step.key]: trimmed }
      setDraftExtras(nextExtras)
      setErrorMessage(undefined)
      if (cloudExtrasStepIndex < steps.length - 1) {
        setCloudExtrasStepIndex(cloudExtrasStepIndex + 1)
        return
      }
      // After cloud extras: jump straight to the form for name/baseUrl/model
      // confirmation. Users still see the full review before saving.
      setCloudExtrasStepIndex(0)
      setScreen('form')
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          {`${preset === 'bedrock' ? 'AWS Bedrock' : preset === 'vertex' ? 'Google Vertex AI' : 'Azure AI Foundry'} setup`}
        </Text>
        <Text dimColor>{step.helpText}</Text>
        <Text dimColor>
          Step {cloudExtrasStepIndex + 1} of {steps.length}: {step.label}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text>{figures.pointer}</Text>
          <TextInput
            value={value}
            onChange={v =>
              setDraftExtras(prev => ({ ...prev, [step.key]: v }))
            }
            onSubmit={onSubmit}
            focus
            showCursor
            placeholder={`${step.placeholder}${figures.ellipsis}`}
            columns={80}
            cursorOffset={cloudExtrasCursor}
            onChangeCursorOffset={setCloudExtrasCursor}
          />
        </Box>
        {errorMessage && <Text color="error">{errorMessage}</Text>}
        <Text dimColor>Press Enter to continue. Press Esc to go back.</Text>
      </Box>
    )
  }

  function renderCustomHeaders(): React.ReactNode {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          Custom headers (optional)
        </Text>
        <Text dimColor>
          Add HTTP headers sent on every request. One header per line as
          {' '}
          <Text>{`Header: Value`}</Text>. Leave empty to skip.
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text>{figures.pointer}</Text>
          <TextInput
            value={draftCustomHeaders}
            onChange={setDraftCustomHeaders}
            onSubmit={() => persistDraft(draft)}
            focus
            showCursor
            placeholder={'X-Header: value'}
            columns={80}
            multiline
            cursorOffset={customHeadersCursor}
            onChangeCursorOffset={setCustomHeadersCursor}
          />
        </Box>
        {errorMessage && <Text color="error">{errorMessage}</Text>}
        <Text dimColor>
          Press Enter on a blank line to save. Press Esc to go back.
        </Text>
      </Box>
    )
  }

  function renderForm(): React.ReactNode {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          {editingProfileId ? 'Edit provider profile' : 'Create provider profile'}
        </Text>
        <Text dimColor>{currentStep.helpText}</Text>
        <Text dimColor>
          Provider type:{' '}
          {draftProvider === 'anthropic'
            ? 'Anthropic native API'
            : 'OpenAI-compatible API'}
        </Text>
        <Text dimColor>
          Step {formStepIndex + 1} of {FORM_STEPS.length}: {currentStep.label}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text>{figures.pointer}</Text>
          <TextInput
            value={currentValue}
            onChange={value =>
              setDraft(prev => ({
                ...prev,
                [currentStepKey]: value,
              }))
            }
            onSubmit={handleFormSubmit}
            focus={true}
            showCursor={true}
            placeholder={`${currentStep.placeholder}${figures.ellipsis}`}
            mask={currentStepKey === 'apiKey' ? '*' : undefined}
            columns={80}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
          />
        </Box>
        {errorMessage && <Text color="error">{errorMessage}</Text>}
        <Text dimColor>
          Press Enter to continue. Press Esc to go back.
        </Text>
      </Box>
    )
  }

  function renderMenu(): React.ReactNode {
    // Use memoized menuOptions from component scope
    const hasProfiles = profiles.length > 0
    const hasSelectableProviders = hasProfiles || githubProviderAvailable

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
          {profiles.length === 0 && !githubProviderAvailable ? (
            isGithubCredentialSourceResolved ? (
              <Text dimColor>No provider profiles configured yet.</Text>
            ) : (
              <Text dimColor>Checking GitHub Copilot credentials...</Text>
            )
          ) : (
            <>
              {profiles.map(profile => (
                <Text key={profile.id} dimColor>
                  - {profile.name}: {profileSummary(profile, profile.id === activeProfileId)}
                </Text>
              ))}
              {githubProviderAvailable ? (
                <Text dimColor>
                  - {GITHUB_PROVIDER_LABEL}:{' '}
                  {getGithubProviderSummary(
                    isGithubActive,
                    githubCredentialSource,
                  )}
                </Text>
              ) : null}
            </>
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
              case 'import-legacy': {
                void (async () => {
                  const report = await migrateLegacyClaudeDir({ force: true })
                  setCanImportLegacyClaude(legacyClaudeDirExists())
                  refreshProfiles()
                  if (report.errors.length > 0) {
                    setErrorMessage(formatMigrationReport(report))
                  } else {
                    setStatusMessage(formatMigrationReport(report))
                  }
                })()
                break
              }
              case 'activate':
                if (hasSelectableProviders) {
                  setScreen('select-active')
                }
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
    options?: { includeGithub?: boolean },
  ): React.ReactNode {
    const includeGithub = options?.includeGithub ?? false
    const selectOptions = profiles.map(profile => ({
      value: profile.id,
      label:
        profile.id === activeProfileId
          ? `${profile.name} (active)`
          : profile.name,
      description: `${profile.provider === 'anthropic' ? 'anthropic' : 'openai-compatible'} · ${profile.baseUrl} · ${profile.model}`,
    }))

    if (includeGithub && githubProviderAvailable) {
      selectOptions.push({
        value: GITHUB_PROVIDER_ID,
        label: isGithubActive
          ? `${GITHUB_PROVIDER_LABEL} (active)`
          : GITHUB_PROVIDER_LABEL,
        description: `github-models · ${GITHUB_PROVIDER_DEFAULT_BASE_URL} · ${getGithubProviderModel()}`,
      })
    }

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
        <Select
          options={selectOptions}
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
      content = renderPresetSelection()
      break
    case 'select-ollama-model':
      content = renderOllamaSelection()
      break
    case 'select-atomic-chat-model':
      content = renderAtomicChatSelection()
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
            const saved = existing
              ? updateProviderProfile(existing.id, payload)
              : addProviderProfile(payload, { makeActive: true })

            if (!saved) {
              setErrorMessage(
                'Codex OAuth login finished, but the provider profile could not be saved.',
              )
              returnToMenu()
              return
            }

            const active =
              existing && activeProfileId !== saved.id
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
            const settingsOverrideError =
              clearStartupProviderOverrideFromUserSettings()
            const activationWarning = await activateCodexOAuthSession(tokens)
            setHasStoredCodexOAuthCredentials(true)
            setStoredCodexOAuthProfileId(saved.id)
            refreshProfiles()
            const warnings = [
              activationWarning,
              settingsOverrideError
                ? `could not clear startup provider override (${settingsOverrideError})`
                : null,
            ].filter((warning): warning is string => Boolean(warning))
            const message = buildCodexOAuthActivationMessage({
              prefix: 'Codex OAuth configured',
              activationWarning,
              warnings,
            })

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
      content = renderAnthropicAuthChoice()
      break
    case 'anthropic-oauth':
      content = renderAnthropicOAuth()
      break
    case 'cloud-extras':
      content = renderCloudExtras()
      break
    case 'custom-headers':
      content = renderCustomHeaders()
      break
    case 'form':
      content = renderForm()
      break
    case 'select-active':
      content = renderProfileSelection(
        'Set active provider',
        'No providers available. Add one first.',
        profileId => {
          void activateSelectedProvider(profileId)
        },
        { includeGithub: true },
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
          if (profileId === GITHUB_PROVIDER_ID) {
            const githubDeleteError = deleteGithubProvider()
            if (githubDeleteError) {
              setErrorMessage(`Could not delete GitHub provider: ${githubDeleteError}`)
            } else {
              refreshProfiles()
              setStatusMessage('GitHub provider deleted')
            }
            returnToMenu()
            return
          }

          const deletedCodexOAuthProfile =
            findCodexOAuthProfile(
              profiles,
              storedCodexOAuthProfileId,
            )?.id === profileId
          const result = deleteProviderProfile(profileId)
          if (!result.removed) {
            setErrorMessage('Could not delete provider.')
          } else {
            if (deletedCodexOAuthProfile) {
              const cleared = clearCodexCredentials()
              if (!cleared.success) {
                setErrorMessage(
                  cleared.warning ??
                    'Provider deleted, but Codex OAuth credentials could not be cleared.',
                )
              } else {
                setStoredCodexOAuthProfileId(undefined)
              }
              clearPersistedCodexOAuthProfile()
            }
            const settingsOverrideError = result.activeProfileId
              ? clearStartupProviderOverrideFromUserSettings()
              : null
            refreshProfiles()
            setStatusMessage(
              settingsOverrideError
                ? `Provider deleted. Warning: could not clear startup provider override (${settingsOverrideError}).`
                : 'Provider deleted',
            )
          }
          returnToMenu()
        },
        { includeGithub: true },
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
