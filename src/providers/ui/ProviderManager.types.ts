import type { OptionWithDescription } from 'src/terminal/custom-select/index.js'

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
