import * as React from 'react'
import { Select } from 'src/terminal/custom-select/index.js'
import { Box, Text } from 'src/terminal/ink.js'
import {
  addProviderProfile,
  getProviderPresetDefaults,
  getProviderProfiles,
  setActiveProviderProfile,
  type ProviderPreset,
  type ProviderProfileInput,
  updateProviderProfile,
} from 'src/providers/presets/providerProfiles.js'
import { findAnthropicOAuthProfile } from 'src/providers/ui/providerLookups.js'
import type {
  ProviderManagerResult,
  Screen,
} from 'src/providers/ui/ProviderManager.types.js'

// The two "how do you want to sign in" pickers `/provider` shows for the two
// presets that offer both OAuth and an API key, plus the Anthropic OAuth
// screen the first of them hands off to. ProviderManager keeps the screen
// state and every piece of profile state; these three only decide what to
// render and which callback a selection fires.

export type AnthropicAuthChoiceScreenProps = {
  setScreen: (screen: Screen) => void
}

export function AnthropicAuthChoiceScreen({
  setScreen,
}: AnthropicAuthChoiceScreenProps): React.ReactNode {
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

export type KimiAuthChoiceScreenProps = {
  setScreen: (screen: Screen) => void
  startCreateFromPreset: (preset: ProviderPreset) => void
}

export function KimiAuthChoiceScreen({
  setScreen,
  startCreateFromPreset,
}: KimiAuthChoiceScreenProps): React.ReactNode {
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

export type AnthropicOAuthScreenProps = {
  mode: 'first-run' | 'manage'
  onDone: (result?: ProviderManagerResult) => void
  activeProfileId: string | undefined
  setErrorMessage: (message: string | undefined) => void
  setScreen: (screen: Screen) => void
  setStatusMessage: (message: string | undefined) => void
  refreshProfiles: () => void
  returnToMenu: () => void
}

export function AnthropicOAuthScreen({
  mode,
  onDone,
  activeProfileId,
  setErrorMessage,
  setScreen,
  setStatusMessage,
  refreshProfiles,
  returnToMenu,
}: AnthropicOAuthScreenProps): React.ReactNode {
  // Lazy require to avoid circular import: ConsoleOAuthFlow imports
  // ProviderManager for its `platform_setup` fallback. Resolving the module
  // at render-time breaks the cycle without restructuring either side.
  const ConsoleOAuthFlow = require('src/providers/ui/ConsoleOAuthFlow.js')
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
          // Adding from the /provider menu must not hijack the global active
          // pointer — only the first-run wizard activates what it creates.
          const activateOnSave = mode === 'first-run'
          const saved = existing
            ? updateProviderProfile(existing.id, payload)
            : addProviderProfile(payload, { makeActive: activateOnSave })
          if (!saved) {
            setErrorMessage(
              'OAuth completed, but the Anthropic profile could not be saved.',
            )
            setScreen('select-preset')
            return
          }
          // updateProviderProfile keeps the current active pointer, so make the
          // (re-)configured Anthropic profile active explicitly when it isn't —
          // but only when this flow is allowed to activate.
          const active =
            activateOnSave && existing && activeProfileId !== saved.id
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
