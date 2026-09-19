import type { ProviderProfile } from 'src/platform/config/config.js'
import { makeFavoritesAdapter } from 'src/providers/favorites/favorites.js'
import { KIMI_CODE_MODEL_LIST } from 'src/providers/oauth/kimiOAuthShared.js'
import type {
  CloudExtrasField,
  DraftField,
} from 'src/providers/ui/ProviderManager.types.js'

export const FORM_STEPS: Array<{
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
export const MANUAL_MODEL_OPTION_VALUE = '\u0000__manual__'

// Providers whose model step must NOT auto-discover from a `/models` endpoint:
// `anthropic` is the native API, and `bedrock`/`vertex`/`foundry` run Claude via
// cloud SDKs (no OpenAI-style model list). Everything else that reaches the
// manual form (openai, mistral, gemini, and the many presets collapsed to
// `openai`) is OpenAI-compatible over HTTP and supports discovery.
export const MODEL_DISCOVERY_EXCLUDED_PROVIDERS = new Set<ProviderProfile['provider']>([
  'anthropic',
  'bedrock',
  'vertex',
  'foundry',
])

export const CODEX_OAUTH_PROVIDER_NAME = 'Codex OAuth'
export const CODEX_OAUTH_PROVIDER_MODEL = 'codexplan'

export const XAI_OAUTH_PROVIDER_NAME = 'xAI / Grok (OAuth)'
// Default model after sign-in; user can swap via /model. grok-4 is the
// current flagship — see plan ~/.claudin/plans/luminous-popping-clarke.md.
export const XAI_OAUTH_PROVIDER_MODEL = 'grok-4'

// Kimi Code OAuth device-flow: openai_compat transport, tokens in secure
// storage (see docs/tech/kimi-code/wire-format.md). Defaults mirror the
// OAuth branch of the unified Moonshot AI preset.
export const KIMI_OAUTH_PROVIDER_NAME = 'Moonshot AI'
export const KIMI_OAUTH_PROVIDER_MODEL = KIMI_CODE_MODEL_LIST
export const KIMI_OAUTH_BASE_URL = 'https://api.kimi.com/coding/v1'

/** A profile id is already the favorites key, so every row can be starred. */
export const PROFILE_FAVORITES = makeFavoritesAdapter<string>(
  'providerProfile',
  value => value,
)

export const CLOUD_EXTRAS_STEPS: Record<
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
