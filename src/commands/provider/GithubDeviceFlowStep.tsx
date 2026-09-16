import * as React from 'react'
import { useCallback, useState } from 'react'
import { Select } from 'src/terminal/custom-select/select.js'
import { Spinner } from 'src/terminal/spinner/Spinner.js'
import TextInput from 'src/terminal/text-input/TextInput.js'
import { Box, Text } from 'src/terminal/ink.js'
import {
  exchangeForCopilotToken,
  normalizeGithubEnterpriseDomain,
  openVerificationUri,
  pollAccessToken,
  requestDeviceCode,
} from 'src/platform/github/deviceFlow.js'
import type { LocalJSXCommandOnDone } from 'src/shared/types/command.js'
import {
  readGithubModelsToken,
  saveGithubModelsToken,
} from 'src/providers/oauth/githubModelsCredentials.js'
import { prefetchCopilotModelCatalog } from 'src/providers/model/copilotModelCatalog.js'
import {
  addProviderProfile,
  getProviderProfiles,
  setActiveProviderProfile,
  updateProviderProfile,
} from 'src/providers/presets/providerProfiles.js'

const GITHUB_DEFAULT_MODEL = 'github:copilot'
const GITHUB_DEFAULT_BASE_URL = 'https://api.githubcopilot.com'

// Match across all profiles, not just the active one — re-signing in while a
// non-Copilot profile is active would otherwise create a duplicate. Refreshing
// in place also keeps `extras.githubToken` (consumed by the shim) in sync with
// the secure-storage token after a token refresh.
// `activate` controls whether saving also repoints the global active profile.
// The /provider menu passes false — signing in there must not hijack the
// active provider; activation stays an explicit menu action. Defaults to true
// so the standalone onboarding path keeps its historical behavior.
export function persistCopilotProfile(
  token: string,
  model: string = GITHUB_DEFAULT_MODEL,
  baseUrl?: string,
  options?: { activate?: boolean },
): { mode: 'updated' | 'created' | 'failed' } {
  const activate = options?.activate ?? true
  const existing = getProviderProfiles().find(
    profile =>
      profile.provider === 'openai' &&
      profile.extras?.githubToken !== undefined,
  )
  if (existing) {
    const saved = updateProviderProfile(existing.id, {
      provider: 'openai',
      name: existing.name,
      // A fresh sign-in's endpoint wins: switching github.com ↔ enterprise
      // must repoint the profile, not keep the stale endpoint.
      baseUrl: baseUrl || existing.baseUrl,
      model: existing.model || model,
      apiKey: token,
      extras: {
        ...existing.extras,
        githubToken: token,
      },
    })
    // A rejected save must not be reported as success — the caller shows an
    // error and the profile stays as-is rather than silently half-configured.
    if (!saved) return { mode: 'failed' }
    if (activate) setActiveProviderProfile(existing.id)
    return { mode: 'updated' }
  }
  const saved = addProviderProfile(
    {
      provider: 'openai',
      name: 'GitHub Copilot',
      baseUrl: baseUrl || GITHUB_DEFAULT_BASE_URL,
      model,
      apiKey: token,
      extras: {
        githubToken: token,
      },
    },
    { makeActive: activate },
  )
  if (!saved) return { mode: 'failed' }
  return { mode: 'created' }
}

type Step =
  | 'menu'
  | 'already-authed'
  | 'enterprise-domain'
  | 'device-busy'
  | 'error'

type Props = {
  onDone: LocalJSXCommandOnDone
  onBack?: () => void
  onChangeAPIKey?: () => void
  // When false, completing the flow saves the profile WITHOUT repointing the
  // global active provider (the /provider menu case). Defaults to true for the
  // standalone onboarding path.
  activateOnSave?: boolean
}

export function GithubDeviceFlowStep({
  onDone,
  onBack,
  onChangeAPIKey,
  activateOnSave = true,
}: Props): React.ReactNode {
  const initialStep: Step = readGithubModelsToken()?.trim() ? 'already-authed' : 'menu'
  const [step, setStep] = useState<Step>(initialStep)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [enterpriseDomainInput, setEnterpriseDomainInput] = useState('')
  const [enterpriseCursor, setEnterpriseCursor] = useState(0)
  const [deviceHint, setDeviceHint] = useState<{
    user_code: string
    verification_uri: string
  } | null>(null)

  const finalize = useCallback(
    async (
      token: string,
      model: string = GITHUB_DEFAULT_MODEL,
      oauthToken?: string,
      options?: { baseUrl?: string; enterpriseDomain?: string },
    ) => {
      const saved = saveGithubModelsToken(
        token,
        oauthToken,
        options?.enterpriseDomain,
      )
      if (!saved.success) {
        setErrorMsg(saved.warning ?? 'Could not save token to secure storage.')
        setStep('error')
        return
      }
      const persisted = persistCopilotProfile(token, model, options?.baseUrl, {
        activate: activateOnSave,
      })
      if (persisted.mode === 'failed') {
        setErrorMsg('Could not save the GitHub Copilot provider profile.')
        setStep('error')
        return
      }
      // Warm the live model catalog now that the Copilot profile is active.
      // No-op when the active provider is unchanged (prefetch self-gates on
      // the active profile being a Copilot one).
      prefetchCopilotModelCatalog()
      onChangeAPIKey?.()
      onDone(
        activateOnSave
          ? 'GitHub Copilot onboard complete. Copilot token stored in secure storage and as the active /provider profile.'
          : 'GitHub Copilot sign-in complete. Copilot token stored in secure storage; the profile was saved without changing the active provider — activate it from "Set active provider".',
        { display: 'user' },
      )
    },
    [activateOnSave, onChangeAPIKey, onDone],
  )

  const runDeviceFlow = useCallback(
    async (enterpriseDomain?: string) => {
      setStep('device-busy')
      setErrorMsg(null)
      setDeviceHint(null)
      try {
        const device = await requestDeviceCode({ domain: enterpriseDomain })
        setDeviceHint({
          user_code: device.user_code,
          verification_uri: device.verification_uri,
        })
        await openVerificationUri(device.verification_uri)
        const oauthToken = await pollAccessToken(device.device_code, {
          initialInterval: device.interval,
          timeoutSeconds: device.expires_in,
          domain: enterpriseDomain,
        })
        const copilotToken = await exchangeForCopilotToken(oauthToken, {
          domain: enterpriseDomain,
        })
        await finalize(copilotToken.token, GITHUB_DEFAULT_MODEL, oauthToken, {
          // The exchange reports the account's Copilot inference endpoint —
          // on GHE deployments it differs from api.githubcopilot.com.
          baseUrl: copilotToken.endpoints.api?.replace(/\/+$/, '') || undefined,
          enterpriseDomain,
        })
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : String(e))
        setStep('error')
      }
    },
    [finalize],
  )

  if (step === 'already-authed') {
    const options = [
      {
        label: 'Sign in again',
        value: 'sign-in-again' as const,
      },
      {
        label: 'Sign in with GitHub Enterprise',
        value: 'enterprise' as const,
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
            if (v === 'enterprise') {
              setStep('enterprise-domain')
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

  if (step === 'enterprise-domain') {
    const submitDomain = (): void => {
      const normalized = normalizeGithubEnterpriseDomain(enterpriseDomainInput)
      if (!normalized) {
        // Empty or github.com → plain GitHub.com sign-in.
        void runDeviceFlow()
        return
      }
      void runDeviceFlow(normalized)
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>GitHub Enterprise sign-in</Text>
        <Text dimColor>
          Enter your GitHub Enterprise domain (e.g. github.acme.com). Leave
          empty for github.com.
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text>&gt;</Text>
          <TextInput
            value={enterpriseDomainInput}
            onChange={setEnterpriseDomainInput}
            onSubmit={submitDomain}
            onExit={() => setStep(initialStep)}
            focus
            showCursor
            placeholder="github.acme.com"
            columns={80}
            cursorOffset={enterpriseCursor}
            onChangeCursorOffset={setEnterpriseCursor}
          />
        </Box>
        <Text dimColor>Press Enter to continue. Press Esc to go back.</Text>
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
        <Text color="error">{errorMsg}</Text>
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
      label: 'Sign in with GitHub Enterprise',
      value: 'enterprise' as const,
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
          if (v === 'enterprise') {
            setStep('enterprise-domain')
            return
          }
          void runDeviceFlow()
        }}
      />
    </Box>
  )
}
