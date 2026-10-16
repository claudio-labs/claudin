import * as React from 'react'
import { Select } from 'src/terminal/custom-select/index.js'
import { Box, Text } from 'src/terminal/ink.js'
import { useKeybinding } from 'src/terminal/keybindings/useKeybinding.js'
import {
  readCodexCliLogin,
  type CodexCliLogin,
} from 'src/providers/oauth/codexCliAuth.js'
import { useCodexOAuthFlow } from 'src/providers/ui/useCodexOAuthFlow.js'
import { useXaiOAuthFlow } from 'src/providers/ui/useXaiOAuthFlow.js'
import { useKimiOAuthFlow } from 'src/providers/ui/useKimiOAuthFlow.js'
import { getDisplayPath } from 'src/shared/fs/file.js'

// The three OAuth setup screens `/provider` can land on. Each one drives a
// single provider's OAuth flow hook (Codex's browser callback, xAI's and
// Kimi's device codes) and renders only that flow's waiting and error states;
// the tokens go straight back to ProviderManager through `onConfigured`, so
// none of them owns provider state of its own.

// `authPath` is set only for a linked Codex CLI login: ProviderManager then
// points the profile at that file instead of persisting the tokens.
type CodexSetupTokens = {
  accessToken: string
  refreshToken: string
  accountId?: string
  idToken?: string
  apiKey?: string
  authPath?: string
}

type CodexConfiguredHandler = (
  tokens: CodexSetupTokens,
  persistCredentials: (options?: { profileId?: string }) => void,
) => void | Promise<void>

function CodexOAuthFailed({
  message,
  onBack,
}: {
  message: string
  onBack: () => void
}): React.ReactNode {
  return (
    <Box flexDirection="column" gap={1}>
      <Text color="error" bold>
        Codex OAuth failed
      </Text>
      <Text>{message}</Text>
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

// A ChatGPT login already made with the Codex CLI is offered before the
// browser, so a machine that can't open one (or reach the localhost:1455
// callback) still gets a working Codex profile.
export function CodexOAuthSetup({
  onBack,
  onConfigured,
  readCliLogin = readCodexCliLogin,
}: {
  onBack: () => void
  onConfigured: CodexConfiguredHandler
  readCliLogin?: () => CodexCliLogin | undefined
}): React.ReactNode {
  const [cliLogin] = React.useState(() => readCliLogin())
  const [method, setMethod] = React.useState<'choose' | 'browser'>(
    cliLogin ? 'choose' : 'browser',
  )
  const [linkError, setLinkError] = React.useState<string | undefined>()
  useKeybinding('confirm:no', onBack)

  if (linkError) {
    return <CodexOAuthFailed message={linkError} onBack={onBack} />
  }

  if (method === 'browser' || !cliLogin) {
    return <CodexBrowserOAuthSetup onBack={onBack} onConfigured={onConfigured} />
  }

  const displayPath = getDisplayPath(cliLogin.authPath)
  return (
    <Box flexDirection="column" gap={1}>
      <Text color="remember" bold>
        Codex OAuth
      </Text>
      <Text>Found a Codex CLI login in {displayPath}.</Text>
      <Select
        options={[
          {
            value: 'codex-cli',
            label: 'Use Codex CLI login',
            description: `No browser: read ${displayPath} on each request and refresh it in place, shared with the codex CLI`,
          },
          {
            value: 'browser',
            label: 'Sign in with browser',
            description:
              'Sign in with ChatGPT and store a separate Codex login securely',
          },
        ]}
        onChange={value => {
          if (value === 'browser') {
            setMethod('browser')
            return
          }
          Promise.resolve(
            onConfigured(
              {
                accessToken: cliLogin.accessToken,
                refreshToken: cliLogin.refreshToken,
                accountId: cliLogin.accountId,
                idToken: cliLogin.idToken,
                authPath: cliLogin.authPath,
              },
              () => {},
            ),
          ).catch(error => {
            setLinkError(error instanceof Error ? error.message : String(error))
          })
        }}
        onCancel={onBack}
      />
      <Text dimColor>Press Esc to cancel and go back.</Text>
    </Box>
  )
}

function CodexBrowserOAuthSetup({
  onBack,
  onConfigured,
}: {
  onBack: () => void
  onConfigured: CodexConfiguredHandler
}): React.ReactNode {
  const handleAuthenticated = React.useCallback<CodexConfiguredHandler>(
    async (tokens, persistCredentials) => {
      await onConfigured(tokens, persistCredentials)
    },
    [onConfigured],
  )

  const status = useCodexOAuthFlow({
    onAuthenticated: handleAuthenticated,
  })

  if (status.state === 'error') {
    return <CodexOAuthFailed message={status.message} onBack={onBack} />
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
