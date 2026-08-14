import figures from 'figures'
import * as React from 'react'
import { GithubDeviceFlowStep } from '../commands/provider/GithubDeviceFlowStep.js'
import {
  DEFAULT_CODEX_BASE_URL,
  DEFAULT_XAI_BASE_URL,
} from '../services/api/providerConfig.js'
import { Box, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useSetAppState } from '../state/AppState.js'
import { suppressNextMainLoopModelPersist } from '../state/onChangeAppState.js'
import type { ProviderProfile } from '../utils/config.js'
import {
  clearCodexCredentials,
  readCodexCredentialsAsync,
} from '../utils/codexCredentials.js'
import { isBareMode } from '../utils/envUtils.js'
import { getPrimaryModel, parseModelList } from '../utils/providerModels.js'
import { getDefaultMainLoopModel } from '../utils/model/model.js'
import { deleteProfileFile } from '../utils/providerProfile.js'
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
} from '../utils/providerProfiles.js'
import { clearGithubModelsToken } from '../utils/githubModelsCredentials.js'
import {
  buildDiscoveredModelOptions,
  listOpenAICompatibleModels,
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
import { useXaiOAuthFlow } from './useXaiOAuthFlow.js'
import { useKimiOAuthFlow } from './useKimiOAuthFlow.js'
import {
  clearXaiCredentials,
  readXaiCredentials,
} from '../utils/xaiCredentials.js'
import {
  clearKimiCredentials,
  readKimiCredentials,
} from '../utils/kimiCredentials.js'
import { KIMI_CODE_MODEL_LIST } from '../services/api/kimiOAuthShared.js'
import {
  formatMigrationReport,
  legacyClaudeDirExists,
  migrateLegacyClaudeDir,
  shouldShowMigrationBanner,
} from '../utils/claudinMigration.js'

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
  | 'select-openai-model'
  | 'codex-oauth'
  | 'xai-oauth'
  | 'kimi-oauth'
  | 'kimi-auth-choice'
  | 'github-onboard'
  | 'anthropic-auth-choice'
  | 'anthropic-oauth'
  | 'cloud-extras'
  | 'custom-headers'
  | 'form'
  | 'select-active'
  | 'select-active-project'
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

type OpenAiModelSelectionState =
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
    key: 'apiKey',
    label: 'API key',
    placeholder: 'Leave empty if your provider does not require one',
    helpText: 'Optional. Press Enter with empty value to skip.',
    optional: true,
  },
  {
    key: 'model',
    label: 'Default model',
    placeholder: 'e.g. llama3.1:8b or glm-4.7; glm-4.7-flash',
    helpText: 'Model name(s) to use. Separate multiple with ";" or ","; first is default.',
  },
]

// Sentinel row appended to the discovered-model list so the user can always
// fall back to typing an id the provider's /models endpoint didn't return.
// The NUL prefix guarantees it can't collide with a real model id.
const MANUAL_MODEL_OPTION_VALUE = '\u0000__manual__'

// Providers whose model step must NOT auto-discover from a `/models` endpoint:
// `anthropic` is the native API, and `bedrock`/`vertex`/`foundry` run Claude via
// cloud SDKs (no OpenAI-style model list). Everything else that reaches the
// manual form (openai, mistral, gemini, and the many presets collapsed to
// `openai`) is OpenAI-compatible over HTTP and supports discovery.
const MODEL_DISCOVERY_EXCLUDED_PROVIDERS = new Set<ProviderProfile['provider']>([
  'anthropic',
  'bedrock',
  'vertex',
  'foundry',
])

const CODEX_OAUTH_PROVIDER_NAME = 'Codex OAuth'
const CODEX_OAUTH_PROVIDER_MODEL = 'codexplan'

const XAI_OAUTH_PROVIDER_NAME = 'xAI / Grok (OAuth)'
// Default model after sign-in; user can swap via /model. grok-4 is the
// current flagship — see plan ~/.claudin/plans/luminous-popping-clarke.md.
const XAI_OAUTH_PROVIDER_MODEL = 'grok-4'

// Kimi Code OAuth device-flow: openai_compat transport, tokens in secure
// storage (see docs/tech/kimi-code/wire-format.md). Defaults mirror the
// OAuth branch of the unified Moonshot AI preset.
const KIMI_OAUTH_PROVIDER_NAME = 'Moonshot AI'
const KIMI_OAUTH_PROVIDER_MODEL = KIMI_CODE_MODEL_LIST
const KIMI_OAUTH_BASE_URL = 'https://api.kimi.com/coding/v1'

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

/**
 * Locate the existing Kimi Code OAuth profile so a re-login UPDATES it (refreshing
 * the model list, etc.) instead of appending a duplicate. Prefers the profileId
 * stored with the credentials; falls back to the OAuth-profile signature (coding
 * host + no static key), mirroring the deletion heuristic below.
 */
function findKimiOAuthProfile(
  profiles: ProviderProfile[],
  profileId?: string,
): ProviderProfile | undefined {
  if (profileId) {
    const byId = profiles.find(profile => profile.id === profileId)
    if (byId) return byId
  }
  return profiles.find(
    profile =>
      profile.provider === 'openai' &&
      profile.baseUrl === KIMI_OAUTH_BASE_URL &&
      !profile.apiKey,
  )
}

/**
 * Locate the existing xAI / Grok OAuth profile so a re-login UPDATES it instead
 * of appending a duplicate. Prefers the profileId stored with the credentials;
 * falls back to the OAuth-profile signature (xAI base URL + no static key).
 */
function findXaiOAuthProfile(
  profiles: ProviderProfile[],
  profileId?: string,
): ProviderProfile | undefined {
  if (profileId) {
    const byId = profiles.find(profile => profile.id === profileId)
    if (byId) return byId
  }
  return profiles.find(
    profile =>
      profile.provider === 'openai' &&
      profile.baseUrl === DEFAULT_XAI_BASE_URL &&
      !profile.apiKey,
  )
}

/**
 * Locate the existing Anthropic OAuth profile so a re-login UPDATES it instead of
 * appending a duplicate. Anthropic OAuth stores its tokens in the credentials file
 * (no per-profile id), so match the keyless anthropic profile by signature.
 */
function findAnthropicOAuthProfile(
  profiles: ProviderProfile[],
  baseUrl: string,
): ProviderProfile | undefined {
  return profiles.find(
    profile =>
      profile.provider === 'anthropic' &&
      profile.baseUrl === baseUrl &&
      !profile.apiKey,
  )
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
  useKeybinding('confirm:no', onBack)

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
        Sign in with your ChatGPT account in the browser. Claudin will store
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

function XaiOAuthSetup({
  onBack,
  onConfigured,
}: {
  onBack: () => void
  onConfigured: (
    tokens: {
      accessToken: string
      refreshToken: string
      idToken?: string
    },
    persistCredentials: (options?: { profileId?: string }) => void,
  ) => void | Promise<void>
}): React.ReactNode {
  const handleAuthenticated = React.useCallback(
    async (
      tokens: {
        accessToken: string
        refreshToken: string
        idToken?: string
      },
      persistCredentials: (options?: { profileId?: string }) => void,
    ) => {
      await onConfigured(tokens, persistCredentials)
    },
    [onConfigured],
  )
  useKeybinding('confirm:no', onBack)

  const status = useXaiOAuthFlow({
    onAuthenticated: handleAuthenticated,
  })

  if (status.state === 'error') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error" bold>
          xAI OAuth failed
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
        xAI / Grok OAuth
      </Text>
      {status.state === 'starting' ? (
        <Text dimColor>Requesting a device code from xAI...</Text>
      ) : (
        <>
          <Text>
            Open this URL on any device:{' '}
            <Text bold>{status.verificationUri}</Text>
          </Text>
          <Text>
            Enter code <Text bold>{status.userCode}</Text>
          </Text>
          {status.verificationUriComplete &&
          status.verificationUriComplete !== status.verificationUri ? (
            <Text dimColor>
              Or open this prefilled URL: {status.verificationUriComplete}
            </Text>
          ) : null}
          <Text dimColor>Waiting for you to authorize in the browser...</Text>
        </>
      )}
      <Text dimColor>Press Esc to cancel and go back.</Text>
    </Box>
  )
}

function KimiOAuthSetup({
  onBack,
  onConfigured,
}: {
  onBack: () => void
  onConfigured: (
    tokens: { accessToken: string; refreshToken: string },
    persistCredentials: (options?: { profileId?: string }) => void,
  ) => void | Promise<void>
}): React.ReactNode {
  const handleAuthenticated = React.useCallback(
    async (
      tokens: { accessToken: string; refreshToken: string },
      persistCredentials: (options?: { profileId?: string }) => void,
    ) => {
      await onConfigured(tokens, persistCredentials)
    },
    [onConfigured],
  )
  useKeybinding('confirm:no', onBack)

  const status = useKimiOAuthFlow({
    onAuthenticated: handleAuthenticated,
  })

  if (status.state === 'error') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error" bold>
          Kimi Code OAuth failed
        </Text>
        <Text>{status.message}</Text>
        <Text dimColor>Press Enter or Esc to go back.</Text>
        <Select
          options={[
            {
              value: 'back',
              label: 'Back',
              description: 'Return to Moonshot AI authentication choices',
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
        Moonshot AI · Kimi Code
      </Text>
      {status.state === 'starting' ? (
        <Text dimColor>Requesting a device code from Kimi...</Text>
      ) : (
        <>
          <Text>
            Open this URL on any device:{' '}
            <Text bold>{status.verificationUri}</Text>
          </Text>
          <Text>
            Enter code <Text bold>{status.userCode}</Text>
          </Text>
          {status.verificationUriComplete &&
          status.verificationUriComplete !== status.verificationUri ? (
            <Text dimColor>
              Or open this prefilled URL: {status.verificationUriComplete}
            </Text>
          ) : null}
          <Text dimColor>Waiting for you to authorize in the browser...</Text>
        </>
      )}
      <Text dimColor>Press Esc to cancel and go back.</Text>
    </Box>
  )
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
  const currentValue = draft[currentStepKey]

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
      canImportLegacyClaude,
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
      const ids = await listOpenAICompatibleModels({
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey || undefined,
      })
      if (cancelled) {
        return
      }
      if (!ids || ids.length === 0) {
        setOpenAiModelSelection({
          state: 'unavailable',
          message:
            "Couldn't list models from this provider. Enter the model id manually, or go back to check the base URL and API key.",
        })
        return
      }

      const { options, defaultValue } = buildDiscoveredModelOptions(
        ids,
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

    const saved = editingProfileId
      ? updateProviderProfile(editingProfileId, payload)
      : addProviderProfile(payload, { makeActive: true })

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
      !editingProfileId &&
      hasProjectProviderProfileOverride() &&
      !isActiveSavedProfile
    const overrideTargetName = overrideMaskingNew
      ? (getActiveProviderProfile()?.name ?? 'override target')
      : null
    const successMessage = editingProfileId
      ? `Updated provider: ${saved.name}`
      : overrideMaskingNew
        ? `Added provider: ${saved.name} (now global default — project keeps using ${overrideTargetName}; use "Clear project provider override" to apply here)`
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

  function goToFormStep(key: DraftField): void {
    const index = FORM_STEPS.findIndex(step => step.key === key)
    setFormStepIndex(index < 0 ? 0 : index)
    setCursorOffset(draft[key].length)
    setErrorMessage(undefined)
    setScreen('form')
  }

  function renderOpenAiModelSelection(): React.ReactNode {
    if (
      openAiModelSelection.state === 'loading' ||
      openAiModelSelection.state === 'idle'
    ) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>
            Fetching models
          </Text>
          <Text dimColor>
            Looking for models on your OpenAI-compatible provider…
          </Text>
          <Text dimColor>Press Esc to enter the model manually.</Text>
        </Box>
      )
    }

    if (openAiModelSelection.state === 'unavailable') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>
            Choose a model
          </Text>
          <Text dimColor>{openAiModelSelection.message}</Text>
          <Select
            options={[
              {
                value: 'manual',
                label: 'Enter manually',
                description: 'Type the model id yourself',
              },
              {
                value: 'back',
                label: 'Back',
                description: 'Return to the API key step',
              },
            ]}
            onChange={(value: string) => {
              if (value === 'manual') {
                goToFormStep('model')
                return
              }
              goToFormStep('apiKey')
            }}
            onCancel={() => goToFormStep('apiKey')}
            visibleOptionCount={2}
          />
        </Box>
      )
    }

    const options: OptionWithDescription<string>[] = [
      ...openAiModelSelection.options,
      {
        value: MANUAL_MODEL_OPTION_VALUE,
        label: 'Enter a model id manually',
        description: 'Type an id the provider did not list',
      },
    ]
    const focusValue =
      openAiModelSelection.defaultValue ?? MANUAL_MODEL_OPTION_VALUE

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          Choose a model
        </Text>
        <Text dimColor>Models from your OpenAI-compatible provider.</Text>
        <Select
          options={options}
          defaultValue={focusValue}
          defaultFocusValue={focusValue}
          inlineDescriptions
          visibleOptionCount={Math.min(8, options.length)}
          onChange={(value: string) => {
            if (value === MANUAL_MODEL_OPTION_VALUE) {
              goToFormStep('model')
              return
            }
            const nextDraft = { ...draft, model: value }
            setDraft(nextDraft)
            finishAfterModelStep(nextDraft)
          }}
          onCancel={() => goToFormStep('apiKey')}
        />
        <Text dimColor>Enter to select · Esc to go back</Text>
      </Box>
    )
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
  useKeybinding('confirm:no', () => goToFormStep('model'), {
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
      {
        value: 'cloudflare-workers-ai',
        label: 'Cloudflare Workers AI',
        description:
          'Cloudflare Workers AI (OpenAI-compatible); set your account ID in the base URL',
      },
      {
        value: 'cloudflare-ai-gateway',
        label: 'Cloudflare AI Gateway',
        description:
          'Cloudflare AI Gateway unified endpoint; set your account ID in the base URL',
      },
      ...(canUseCodexOAuth
        ? [
            {
              value: 'codex-oauth',
              label: 'Codex OAuth',
              description:
                'Sign in with ChatGPT in your browser and store Codex credentials securely',
            },
            {
              value: 'xai-oauth',
              label: 'xAI / Grok (OAuth)',
              description:
                'Sign in with xAI in your browser and store Grok credentials securely',
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
        label: 'Moonshot AI',
        description: 'API key or Kimi Code OAuth sign-in',
      },
      {
        value: 'nvidia-nim',
        label: 'NVIDIA NIM',
        description: 'NVIDIA NIM endpoint',
      },
      {
        value: 'opencode-go',
        label: 'OpenCode GO',
        description: 'OpenCode GO OpenAI-compatible endpoint',
      },
      {
        value: 'opencode-zen',
        label: 'OpenCode Zen',
        description: 'OpenCode Zen OpenAI-compatible endpoint',
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
        value: 'zai',
        label: 'Z.AI (GLM Coding Plan)',
        description: 'Z.AI GLM Coding Plan (OpenAI-compatible)',
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
            if (value === 'xai-oauth') {
              setScreen('xai-oauth')
              return
            }
            if (value === 'moonshotai') {
              setScreen('kimi-auth-choice')
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
                'Open a browser, sign in to Claude, and store tokens in ~/.claudin/.credentials.json',
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

  function renderKimiAuthChoice(): React.ReactNode {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          Moonshot AI — choose authentication
        </Text>
        <Text dimColor>
          Sign in with your Kimi Code subscription in the browser, or paste a Moonshot AI API key.
        </Text>
        <Select
          options={[
            {
              value: 'oauth',
              label: 'Sign in with web (OAuth)',
              description:
                'Open a browser, sign in to Kimi Code, and store tokens in ~/.claudin/.credentials.json',
            },
            {
              value: 'apiKey',
              label: 'Use API key',
              description: 'Paste a Moonshot AI API key (sk-…)',
            },
            {
              value: 'back',
              label: 'Back',
              description: 'Choose a different provider',
            },
          ]}
          onChange={(value: string) => {
            if (value === 'oauth') {
              setScreen('kimi-oauth')
              return
            }
            if (value === 'apiKey') {
              startCreateFromPreset('moonshotai')
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
            // Update the existing keyless Anthropic profile on re-login instead of
            // appending a duplicate.
            const existing = findAnthropicOAuthProfile(
              getProviderProfiles(),
              defaults.baseUrl,
            )
            const saved = existing
              ? updateProviderProfile(existing.id, payload)
              : addProviderProfile(payload, { makeActive: true })
            if (!saved) {
              setErrorMessage(
                'OAuth completed, but the Anthropic profile could not be saved.',
              )
              setScreen('select-preset')
              return
            }
            // updateProviderProfile keeps the current active pointer, so make the
            // (re-)configured Anthropic profile active explicitly when it isn't.
            const active =
              existing && activeProfileId !== saved.id
                ? setActiveProviderProfile(saved.id)
                : saved
            if (!active) {
              setErrorMessage(
                'OAuth completed, but the Anthropic profile could not be set as the startup provider.',
              )
              setScreen('select-preset')
              return
            }
            const message = `Anthropic OAuth configured: ${active.name}`
            refreshProfiles()
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
    case 'select-openai-model':
      content = renderOpenAiModelSelection()
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
            const saved = existing
              ? updateProviderProfile(existing.id, payload)
              : addProviderProfile(payload, { makeActive: true })

            if (!saved) {
              setErrorMessage(
                'xAI OAuth login finished, but the provider profile could not be saved.',
              )
              returnToMenu()
              return
            }

            // updateProviderProfile keeps the current active pointer, so make the
            // (re-)configured xAI profile active explicitly when it isn't already.
            const active =
              existing && activeProfileId !== saved.id
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
            const message = `xAI / Grok configured. Claudin switched to it for this session.`

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
      content = renderKimiAuthChoice()
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
            const saved = existing
              ? updateProviderProfile(existing.id, payload)
              : addProviderProfile(payload, { makeActive: true })

            if (!saved) {
              setErrorMessage(
                'Kimi Code OAuth login finished, but the provider profile could not be saved.',
              )
              returnToMenu()
              return
            }

            // updateProviderProfile keeps the current active pointer, so make the
            // (re-)configured Kimi profile active explicitly when it isn't already.
            const active =
              existing && activeProfileId !== saved.id
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
            const message = `Kimi Code configured. Claudin switched to it for this session.`

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
