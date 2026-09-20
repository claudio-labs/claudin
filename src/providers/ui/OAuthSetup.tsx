import * as React from 'react'
import { Select } from 'src/terminal/custom-select/index.js'
import { Box, Text } from 'src/terminal/ink.js'
import { useKeybinding } from 'src/terminal/keybindings/useKeybinding.js'
import { useCodexOAuthFlow } from 'src/providers/ui/useCodexOAuthFlow.js'
import { useXaiOAuthFlow } from 'src/providers/ui/useXaiOAuthFlow.js'
import { useKimiOAuthFlow } from 'src/providers/ui/useKimiOAuthFlow.js'

// The three OAuth setup screens `/provider` can land on. Each one drives a
// single provider's OAuth flow hook (Codex's browser callback, xAI's and
// Kimi's device codes) and renders only that flow's waiting and error states;
// the tokens go straight back to ProviderManager through `onConfigured`, so
// none of them owns provider state of its own.

export function CodexOAuthSetup({
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

export function XaiOAuthSetup({
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

export function KimiOAuthSetup({
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
