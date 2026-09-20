import type { OptionWithDescription } from 'src/terminal/custom-select/index.js'

export type ProviderManagerResult = {
  action: 'saved' | 'cancelled' | 'activated'
  activeProfileId?: string
  activeProviderName?: string
  activeProviderModel?: string
  message?: string
}

/**
 * Every screen `/provider` can land on.
 *
 * Lives here rather than in ProviderManager.tsx because the extracted screens
 * under `screens/` take `setScreen` as a prop: importing the type back from
 * ProviderManager would close an import cycle the bundler's pre-scan sees.
 */
export type Screen =
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

export type DraftField = 'name' | 'baseUrl' | 'model' | 'apiKey'

export type ProviderDraft = Record<DraftField, string>

export type CloudExtrasField =
  | 'awsRegion'
  | 'gcpProject'
  | 'gcpRegion'
  | 'azureResource'

export type CloudExtrasDraft = Partial<Record<CloudExtrasField, string>>

export type OllamaSelectionState =
  | { state: 'idle' }
  | { state: 'loading' }
  | {
      state: 'ready'
      options: OptionWithDescription<string>[]
      defaultValue?: string
    }
  | { state: 'unavailable'; message: string }

export type AtomicChatSelectionState =
  | { state: 'idle' }
  | { state: 'loading' }
  | {
      state: 'ready'
      options: OptionWithDescription<string>[]
      defaultValue?: string
    }
  | { state: 'unavailable'; message: string }

export type OpenAiModelSelectionState =
  | { state: 'idle' }
  | { state: 'loading' }
  | {
      state: 'ready'
      options: OptionWithDescription<string>[]
      defaultValue?: string
    }
  | { state: 'unavailable'; message: string }
