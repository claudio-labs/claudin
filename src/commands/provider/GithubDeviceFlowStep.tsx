import * as React from 'react'
import { useCallback, useState } from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Spinner } from '../../components/Spinner.js'
import { Box, Text } from '../../ink.js'
import {
  exchangeForCopilotToken,
  openVerificationUri,
  pollAccessToken,
  requestDeviceCode,
} from '../../services/github/deviceFlow.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  readGithubModelsToken,
  saveGithubModelsToken,
} from '../../utils/githubModelsCredentials.js'
import {
  addProviderProfile,
  getActiveProviderProfile,
} from '../../utils/providerProfiles.js'

const GITHUB_DEFAULT_MODEL = 'github:copilot'
const GITHUB_DEFAULT_BASE_URL = 'https://api.githubcopilot.com'

type Step = 'menu' | 'already-authed' | 'device-busy' | 'error'

type Props = {
  onDone: LocalJSXCommandOnDone
  onBack?: () => void
  onChangeAPIKey?: () => void
}

export function GithubDeviceFlowStep({
  onDone,
  onBack,
  onChangeAPIKey,
}: Props): React.ReactNode {
  const initialStep: Step = readGithubModelsToken()?.trim() ? 'already-authed' : 'menu'
  const [step, setStep] = useState<Step>(initialStep)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [deviceHint, setDeviceHint] = useState<{
    user_code: string
    verification_uri: string
  } | null>(null)

  const finalize = useCallback(
    async (
      token: string,
      model: string = GITHUB_DEFAULT_MODEL,
      oauthToken?: string,
    ) => {
      const saved = saveGithubModelsToken(token, oauthToken)
      if (!saved.success) {
        setErrorMsg(saved.warning ?? 'Could not save token to secure storage.')
        setStep('error')
        return
      }
      // Create or activate a provider profile that flows through the
      // github_copilot transport. The Copilot access token also lives in
      // secure storage, but profile.extras.githubToken is what /provider's
      // resolver surfaces to the shim.
      const active = getActiveProviderProfile()
      const alreadyConfigured =
        active?.provider === 'openai' &&
        active.extras?.githubToken !== undefined
      if (!alreadyConfigured) {
        addProviderProfile(
          {
            provider: 'openai',
            name: 'GitHub Copilot',
            baseUrl: GITHUB_DEFAULT_BASE_URL,
            model,
            apiKey: token,
            extras: {
              githubToken: token,
            },
          },
          { makeActive: true },
        )
      }
      onChangeAPIKey?.()
      onDone(
        'GitHub Copilot onboard complete. Copilot token stored in secure storage and as the active /provider profile.',
        { display: 'user' },
      )
    },
    [onChangeAPIKey, onDone],
  )

  const runDeviceFlow = useCallback(async () => {
    setStep('device-busy')
    setErrorMsg(null)
    setDeviceHint(null)
    try {
      const device = await requestDeviceCode()
      setDeviceHint({
        user_code: device.user_code,
        verification_uri: device.verification_uri,
      })
      await openVerificationUri(device.verification_uri)
      const oauthToken = await pollAccessToken(device.device_code, {
        initialInterval: device.interval,
        timeoutSeconds: device.expires_in,
      })
      const copilotToken = await exchangeForCopilotToken(oauthToken)
      await finalize(copilotToken.token, GITHUB_DEFAULT_MODEL, oauthToken)
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
      setStep('error')
    }
  }, [finalize])

  if (step === 'already-authed') {
    const options = [
      {
        label: 'Sign in again',
        value: 'sign-in-again' as const,
      },
      {
        label: onBack ? 'Back to /provider menu' : 'Cancel',
        value: 'back' as const,
      },
    ]
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>GitHub Copilot</Text>
        <Text>You are already signed in to GitHub Copilot.</Text>
        <Text dimColor>
          Choose &quot;Sign in again&quot; to refresh your token, or go back to the
          provider menu.
        </Text>
        <Select
          options={options}
          onChange={(v: string) => {
            if (v === 'sign-in-again') {
              void runDeviceFlow()
              return
            }
            if (onBack) {
              onBack()
              return
            }
            onDone('GitHub onboard cancelled', { display: 'system' })
          }}
        />
      </Box>
    )
  }

  if (step === 'error' && errorMsg) {
    const options = [
      {
        label: onBack ? 'Back to /provider menu' : 'Back to menu',
        value: 'back' as const,
      },
      {
        label: 'Exit',
        value: 'exit' as const,
      },
    ]
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="red">{errorMsg}</Text>
        <Select
          options={options}
          onChange={(v: string) => {
            if (v === 'back') {
              if (onBack) {
                onBack()
                return
              }
              setStep('menu')
              setErrorMsg(null)
              return
            }
            onDone('GitHub onboard cancelled', { display: 'system' })
          }}
        />
      </Box>
    )
  }

  if (step === 'device-busy') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>GitHub Copilot sign-in</Text>
        {deviceHint ? (
          <>
            <Text>
              Enter code <Text bold>{deviceHint.user_code}</Text> at{' '}
              {deviceHint.verification_uri}
            </Text>
            <Text dimColor>
              A browser window may have opened. Waiting for authorization...
            </Text>
          </>
        ) : (
          <Text dimColor>Requesting device code from GitHub...</Text>
        )}
        <Spinner />
      </Box>
    )
  }

  const menuOptions = [
    {
      label: 'Sign in with browser',
      value: 'device' as const,
    },
    {
      label: onBack ? 'Back to /provider menu' : 'Cancel',
      value: 'cancel' as const,
    },
  ]

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>GitHub Copilot setup</Text>
      <Text dimColor>
        Stores your token in the OS credential store (macOS Keychain when available)
        and creates a /provider profile so Copilot is the active provider — no
        manual env exports required.
      </Text>
      <Select
        options={menuOptions}
        onChange={(v: string) => {
          if (v === 'cancel') {
            if (onBack) {
              onBack()
              return
            }
            onDone('GitHub onboard cancelled', { display: 'system' })
            return
          }
          void runDeviceFlow()
        }}
      />
    </Box>
  )
}
