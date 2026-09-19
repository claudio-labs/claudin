import figures from 'figures'
import * as React from 'react'
import { Box, Text } from 'src/terminal/ink.js'
import TextInput from 'src/terminal/text-input/TextInput.js'
import type { ProviderProfile } from 'src/platform/config/config.js'
import type { ProviderPreset } from 'src/providers/presets/providerProfiles.js'
import {
  CLOUD_EXTRAS_STEPS,
  FORM_STEPS,
} from 'src/providers/ui/providerManagerConstants.js'
import type {
  CloudExtrasDraft,
  ProviderDraft,
  Screen,
} from 'src/providers/ui/ProviderManager.types.js'

// The three text-entry screens of `/provider`: the four-step profile form, the
// cloud-credential steps that precede it for Bedrock/Vertex/Foundry, and the
// optional custom-headers step that follows it. Each one edits a slice of the
// draft ProviderManager owns; none of them saves anything itself.
//
// The bodies below carry the indentation they had as nested `render*`
// functions inside ProviderManager: the move is checked mechanically by
// scripts/migrations/verify-relocation.ts, which compares line multisets, and
// re-indenting would turn a provable relocation into an unreviewable rewrite.

export type FormScreenProps = {
  formStepIndex: number
  draft: ProviderDraft
  setDraft: React.Dispatch<React.SetStateAction<ProviderDraft>>
  setCursorOffset: (offset: number) => void
  cursorOffset: number
  editingProfileId: string | null
  draftProvider: ProviderProfile['provider']
  errorMessage: string | undefined
  handleFormSubmit: (value: string) => void
}

export function FormScreen({
  formStepIndex,
  draft,
  setDraft,
  setCursorOffset,
  cursorOffset,
  editingProfileId,
  draftProvider,
  errorMessage,
  handleFormSubmit,
}: FormScreenProps): React.ReactNode {
  // Derived from the two roots rather than passed: ProviderManager computes the
  // same three for `handleFormSubmit`, and threading them as props would make
  // a step change reach this screen through four values instead of one.
  const currentStep = FORM_STEPS[formStepIndex] ?? FORM_STEPS[0]
  const currentStepKey = currentStep.key
  const currentValue = draft[currentStepKey]

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

export type CloudExtrasScreenProps = {
  pendingPreset: ProviderPreset | null
  cloudExtrasStepIndex: number
  draftExtras: CloudExtrasDraft
  cloudExtrasCursor: number
  errorMessage: string | undefined
  setDraftExtras: React.Dispatch<React.SetStateAction<CloudExtrasDraft>>
  setCloudExtrasStepIndex: (index: number) => void
  setCloudExtrasCursor: (offset: number) => void
  setErrorMessage: (message: string | undefined) => void
  setScreen: (screen: Screen) => void
}

export function CloudExtrasScreen({
  pendingPreset,
  cloudExtrasStepIndex,
  draftExtras,
  cloudExtrasCursor,
  errorMessage,
  setDraftExtras,
  setCloudExtrasStepIndex,
  setCloudExtrasCursor,
  setErrorMessage,
  setScreen,
}: CloudExtrasScreenProps): React.ReactNode {
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

export type CustomHeadersScreenProps = {
  draftCustomHeaders: string
  draft: ProviderDraft
  customHeadersCursor: number
  errorMessage: string | undefined
  setDraftCustomHeaders: (value: string) => void
  setCustomHeadersCursor: (offset: number) => void
  persistDraft: (nextDraft: ProviderDraft) => void
}

export function CustomHeadersScreen({
  draftCustomHeaders,
  draft,
  customHeadersCursor,
  errorMessage,
  setDraftCustomHeaders,
  setCustomHeadersCursor,
  persistDraft,
}: CustomHeadersScreenProps): React.ReactNode {
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
