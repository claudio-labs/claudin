import * as React from 'react'
import {
  type OptionWithDescription,
  Select,
} from 'src/terminal/custom-select/index.js'
import { Box, Text } from 'src/terminal/ink.js'
import { MANUAL_MODEL_OPTION_VALUE } from 'src/providers/ui/providerManagerConstants.js'
import type {
  AtomicChatSelectionState,
  DraftField,
  OllamaSelectionState,
  OpenAiModelSelectionState,
  ProviderDraft,
  Screen,
} from 'src/providers/ui/ProviderManager.types.js'

// The three model-picker screens `/provider` can land on after a base URL is
// known. ProviderManager runs the discovery effects and owns the draft; these
// components only render the resulting state and report the choice back.
//
// The bodies below carry the indentation they had as nested `render*`
// functions inside ProviderManager: the move is checked mechanically by
// scripts/migrations/verify-relocation.ts, which compares line multisets, and
// re-indenting would turn a provable relocation into an unreviewable rewrite.

/**
 * Shared by the two local-server pickers.
 *
 * `AtomicChatSelectionScreen` and `OllamaSelectionScreen` differ only in which
 * discovery state they read and in their copy, so they take one props type and
 * rename `selection` to the name the body already used. They stay two
 * components: the copy is user-facing and the two providers drift apart.
 */
export type LocalModelSelectionScreenProps = {
  selection: AtomicChatSelectionState | OllamaSelectionState
  draft: ProviderDraft
  setDraft: (draft: ProviderDraft) => void
  setScreen: (screen: Screen) => void
  setFormStepIndex: (index: number) => void
  setCursorOffset: (offset: number) => void
  persistDraft: (nextDraft: ProviderDraft) => void
}

export function AtomicChatSelectionScreen({
  selection: atomicChatSelection,
  draft,
  setDraft,
  setScreen,
  setFormStepIndex,
  setCursorOffset,
  persistDraft,
}: LocalModelSelectionScreenProps): React.ReactNode {
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

export function OllamaSelectionScreen({
  selection: ollamaSelection,
  draft,
  setDraft,
  setScreen,
  setFormStepIndex,
  setCursorOffset,
  persistDraft,
}: LocalModelSelectionScreenProps): React.ReactNode {
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

export type OpenAiModelSelectionScreenProps = {
  openAiModelSelection: OpenAiModelSelectionState
  draft: ProviderDraft
  setDraft: (draft: ProviderDraft) => void
  goToFormStep: (key: DraftField) => void
  goToManualModelStep: () => void
  finishAfterModelStep: (nextDraft: ProviderDraft) => void
}

export function OpenAiModelSelectionScreen({
  openAiModelSelection,
  draft,
  setDraft,
  goToFormStep,
  goToManualModelStep,
  finishAfterModelStep,
}: OpenAiModelSelectionScreenProps): React.ReactNode {
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
                goToManualModelStep()
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
              goToManualModelStep()
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
