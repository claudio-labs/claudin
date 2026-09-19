// useKimiOAuthFlow — the device-code flow behind the Kimi Code provider.
//
// Its two siblings (useCodexOAuthFlow, useXaiOAuthFlow) have had suites for a
// while and this one had none, so everything below is new coverage rather than
// a relocation.
//
// Statuses are captured out of the component instead of parsed back out of the
// rendered frame: the hook's contract is the status object it returns, and a
// frame assertion would additionally pin how the caller chose to render it.

import { afterEach, expect, mock, test } from 'bun:test'
import React from 'react'

import { Text } from 'src/terminal/ink.js'
import {
  mountHook,
  waitForCondition,
} from 'src/providers/ui/__testutils__/inkHookHarness.js'
import type { KimiOAuthTokens } from 'src/providers/oauth/kimiOAuth.js'
import type { KimiOAuthFlowStatus } from 'src/providers/ui/useKimiOAuthFlow.js'

const DEVICE = {
  device_code: 'device-code',
  user_code: 'WXYZ-1234',
  verification_uri: 'https://kimi.example/device',
  verification_uri_complete: 'https://kimi.example/device?user_code=WXYZ-1234',
  expires_in: 600,
  interval: 5,
}

const TOKENS: KimiOAuthTokens = {
  accessToken: 'kimi-access-token',
  refreshToken: 'kimi-refresh-token',
  expiresAt: 1_800_000_000_000,
}

afterEach(() => {
  mock.restore()
})

type Deps = Parameters<
  typeof import('src/providers/ui/useKimiOAuthFlow.js').useKimiOAuthFlow
>[0]['deps']

/** Fresh module per test so no hook-level state is shared. Mirrors the
 *  cache-busting import the Codex suite uses. */
async function loadHook(tag: string) {
  const mod = await import(
    `./useKimiOAuthFlow.js?kimi-${tag}-${Date.now()}-${Math.random()}`
  )
  return mod.useKimiOAuthFlow as (options: {
    onAuthenticated: Parameters<
      typeof import('src/providers/ui/useKimiOAuthFlow.js').useKimiOAuthFlow
    >[0]['onAuthenticated']
    deps?: Deps
  }) => KimiOAuthFlowStatus
}

/** Mount the hook and collect every status it returns, newest last. */
async function mountFlow(
  tag: string,
  onAuthenticated: Parameters<
    typeof import('src/providers/ui/useKimiOAuthFlow.js').useKimiOAuthFlow
  >[0]['onAuthenticated'],
  deps: Deps,
): Promise<{
  statuses: KimiOAuthFlowStatus[]
  cleanup: () => Promise<void>
}> {
  const useKimiOAuthFlow = await loadHook(tag)
  const statuses: KimiOAuthFlowStatus[] = []

  function Harness(): React.ReactNode {
    const handleAuthenticated = React.useCallback(onAuthenticated, [
      onAuthenticated,
    ])
    const status = useKimiOAuthFlow({
      onAuthenticated: handleAuthenticated,
      deps,
    })
    statuses.push(status)
    return <Text>{status.state}</Text>
  }

  const mounted = await mountHook(<Harness />)
  return { statuses, cleanup: mounted.cleanup }
}

const latest = (statuses: KimiOAuthFlowStatus[]): KimiOAuthFlowStatus | undefined =>
  statuses[statuses.length - 1]

test('bare mode fails closed without ever starting the device flow', async () => {
  const createOAuthService = mock(() => {
    throw new Error('the device flow must not start under --bare')
  })
  const onAuthenticated = mock(async () => {})

  const { statuses, cleanup } = await mountFlow('bare', onAuthenticated, {
    createOAuthService,
    isBareMode: () => true,
    openBrowser: async () => true,
    saveKimiCredentials: mock(() => ({ success: true })),
  })

  try {
    await waitForCondition(() => latest(statuses)?.state === 'error', {
      label: 'the bare-mode error status',
    })
    const status = latest(statuses)
    expect(status).toEqual({
      state: 'error',
      message:
        'Kimi Code OAuth is unavailable in --bare because secure storage is disabled.',
    })
    // Secure storage is off, so there is nothing to come back to — the flow
    // must not burn a device code it can never persist the result of.
    expect(createOAuthService).not.toHaveBeenCalled()
    expect(onAuthenticated).not.toHaveBeenCalled()
  } finally {
    await cleanup()
  }
})

test('the waiting status carries the code and both verification URLs', async () => {
  const cleanupService = mock(() => {})
  const { statuses, cleanup } = await mountFlow(
    'waiting',
    async () => {},
    {
      createOAuthService: () => ({
        async startDeviceFlow(
          onDevice: (device: typeof DEVICE) => void | Promise<void>,
        ) {
          await onDevice(DEVICE)
          // Never resolves: this test is about the waiting state itself.
          return new Promise<never>(() => {})
        },
        cleanup: cleanupService,
      }),
      isBareMode: () => false,
      openBrowser: async () => true,
      saveKimiCredentials: mock(() => ({ success: true })),
    },
  )

  try {
    await waitForCondition(() => latest(statuses)?.state === 'waiting', {
      label: 'the waiting status',
    })
    expect(latest(statuses)).toEqual({
      state: 'waiting',
      userCode: DEVICE.user_code,
      verificationUri: DEVICE.verification_uri,
      verificationUriComplete: DEVICE.verification_uri_complete,
    })
  } finally {
    await cleanup()
  }
})

test('the pre-filled URL is preferred over the bare one, and opened once', async () => {
  const opened: string[] = []
  const { statuses, cleanup } = await mountFlow('browser', async () => {}, {
    createOAuthService: () => ({
      async startDeviceFlow(
        onDevice: (device: typeof DEVICE) => void | Promise<void>,
      ) {
        await onDevice(DEVICE)
        // The sleep is load-bearing. Two callbacks in the same task are
        // auto-batched into ONE render and ONE effect run, so the ref guard
        // below is never reached and a test written without this passes with
        // the guard deleted. Yielding forces a second render.
        await Bun.sleep(30)
        await onDevice(DEVICE)
        return new Promise<never>(() => {})
      },
      cleanup: () => {},
    }),
    isBareMode: () => false,
    openBrowser: async (url: string) => {
      opened.push(url)
      return true
    },
    saveKimiCredentials: mock(() => ({ success: true })),
  })

  try {
    await waitForCondition(() => opened.length > 0, {
      label: 'the browser launch',
    })
    // Wait past the second device callback: it re-renders with an
    // equal-but-new status object, and the ref guard is the only thing that
    // keeps that render from opening a second tab.
    const rendersAfterFirstOpen = statuses.length
    await waitForCondition(() => statuses.length > rendersAfterFirstOpen, {
      label: 'the second device callback to re-render',
    })
    await Bun.sleep(20)
    expect(opened).toEqual([DEVICE.verification_uri_complete])
  } finally {
    await cleanup()
  }
})

test('a browser that refuses to open is not an error — the code stays on screen', async () => {
  const { statuses, cleanup } = await mountFlow('browser-fails', async () => {}, {
    createOAuthService: () => ({
      async startDeviceFlow(
        onDevice: (device: typeof DEVICE) => void | Promise<void>,
      ) {
        await onDevice(DEVICE)
        return new Promise<never>(() => {})
      },
      cleanup: () => {},
    }),
    isBareMode: () => false,
    openBrowser: async () => {
      throw new Error('no browser on this host')
    },
    saveKimiCredentials: mock(() => ({ success: true })),
  })

  try {
    await waitForCondition(() => latest(statuses)?.state === 'waiting', {
      label: 'the waiting status',
    })
    await Bun.sleep(20)
    // Headless, SSH and WSL all land here. The rendered code and URL are the
    // fallback, so a failed launch must not replace them with an error.
    expect(latest(statuses)?.state).toBe('waiting')
  } finally {
    await cleanup()
  }
})

test('a device flow that rejects surfaces the message as an error status', async () => {
  const { statuses, cleanup } = await mountFlow('flow-rejects', async () => {}, {
    createOAuthService: () => ({
      async startDeviceFlow() {
        throw new Error('device code expired')
      },
      cleanup: () => {},
    }),
    isBareMode: () => false,
    openBrowser: async () => true,
    saveKimiCredentials: mock(() => ({ success: true })),
  })

  try {
    await waitForCondition(() => latest(statuses)?.state === 'error', {
      label: 'the rejected-flow error status',
    })
    expect(latest(statuses)).toEqual({
      state: 'error',
      message: 'device code expired',
    })
  } finally {
    await cleanup()
  }
})

test('a non-Error rejection is stringified rather than dropped', async () => {
  const { statuses, cleanup } = await mountFlow('flow-rejects-raw', async () => {}, {
    createOAuthService: () => ({
      async startDeviceFlow() {
        throw 'access_denied'
      },
      cleanup: () => {},
    }),
    isBareMode: () => false,
    openBrowser: async () => true,
    saveKimiCredentials: mock(() => ({ success: true })),
  })

  try {
    await waitForCondition(() => latest(statuses)?.state === 'error', {
      label: 'the stringified error status',
    })
    expect(latest(statuses)).toEqual({
      state: 'error',
      message: 'access_denied',
    })
  } finally {
    await cleanup()
  }
})

test('persisting links the credentials to the profile that asked for them', async () => {
  const saveKimiCredentials = mock(() => ({ success: true }))
  const onAuthenticated = mock(
    async (
      _tokens: KimiOAuthTokens,
      persistCredentials: (options?: { profileId?: string }) => void,
    ) => {
      persistCredentials({ profileId: 'profile_kimi_oauth' })
    },
  )

  const { cleanup } = await mountFlow('persist', onAuthenticated, {
    createOAuthService: () => ({
      async startDeviceFlow(
        onDevice: (device: typeof DEVICE) => void | Promise<void>,
      ) {
        await onDevice(DEVICE)
        return TOKENS
      },
      cleanup: () => {},
    }),
    isBareMode: () => false,
    openBrowser: async () => true,
    saveKimiCredentials,
  })

  try {
    await waitForCondition(() => saveKimiCredentials.mock.calls.length === 1, {
      label: 'the credential save',
    })
    expect(saveKimiCredentials).toHaveBeenCalledWith({
      accessToken: TOKENS.accessToken,
      refreshToken: TOKENS.refreshToken,
      expiresAt: TOKENS.expiresAt,
      profileId: 'profile_kimi_oauth',
    })
  } finally {
    await cleanup()
  }
})

test('nothing is persisted unless the caller asks — downstream setup owns that', async () => {
  const saveKimiCredentials = mock(() => ({ success: true }))
  const onAuthenticated = mock(async () => {
    throw new Error('profile save failed')
  })

  const { statuses, cleanup } = await mountFlow('no-persist', onAuthenticated, {
    createOAuthService: () => ({
      async startDeviceFlow(
        onDevice: (device: typeof DEVICE) => void | Promise<void>,
      ) {
        await onDevice(DEVICE)
        return TOKENS
      },
      cleanup: () => {},
    }),
    isBareMode: () => false,
    openBrowser: async () => true,
    saveKimiCredentials,
  })

  try {
    await waitForCondition(() => onAuthenticated.mock.calls.length === 1, {
      label: 'the authenticated callback',
    })
    await waitForCondition(() => latest(statuses)?.state === 'error', {
      label: 'the downstream failure status',
    })
    expect(latest(statuses)).toEqual({
      state: 'error',
      message: 'profile save failed',
    })
    // The tokens are real, but the profile they belong to was never created.
    // Writing them anyway would leave a credential no profile points at.
    expect(saveKimiCredentials).not.toHaveBeenCalled()
  } finally {
    await cleanup()
  }
})

test('a refused save raises the storage warning, not a generic failure', async () => {
  const saveKimiCredentials = mock(() => ({
    success: false,
    warning: 'secret-tool is not installed',
  }))
  let thrown: unknown
  const onAuthenticated = mock(
    async (
      _tokens: KimiOAuthTokens,
      persistCredentials: (options?: { profileId?: string }) => void,
    ) => {
      try {
        persistCredentials()
      } catch (error) {
        thrown = error
      }
    },
  )

  const { cleanup } = await mountFlow('save-warns', onAuthenticated, {
    createOAuthService: () => ({
      async startDeviceFlow(
        onDevice: (device: typeof DEVICE) => void | Promise<void>,
      ) {
        await onDevice(DEVICE)
        return TOKENS
      },
      cleanup: () => {},
    }),
    isBareMode: () => false,
    openBrowser: async () => true,
    saveKimiCredentials,
  })

  try {
    await waitForCondition(() => thrown !== undefined, {
      label: 'the persist failure',
    })
    expect((thrown as Error).message).toBe('secret-tool is not installed')
  } finally {
    await cleanup()
  }
})

test('a refused save with no warning still says the credentials were not stored', async () => {
  const saveKimiCredentials = mock(() => ({ success: false }))
  let thrown: unknown
  const onAuthenticated = mock(
    async (
      _tokens: KimiOAuthTokens,
      persistCredentials: (options?: { profileId?: string }) => void,
    ) => {
      try {
        persistCredentials()
      } catch (error) {
        thrown = error
      }
    },
  )

  const { cleanup } = await mountFlow('save-silent', onAuthenticated, {
    createOAuthService: () => ({
      async startDeviceFlow(
        onDevice: (device: typeof DEVICE) => void | Promise<void>,
      ) {
        await onDevice(DEVICE)
        return TOKENS
      },
      cleanup: () => {},
    }),
    isBareMode: () => false,
    openBrowser: async () => true,
    saveKimiCredentials,
  })

  try {
    await waitForCondition(() => thrown !== undefined, {
      label: 'the persist failure',
    })
    expect((thrown as Error).message).toBe(
      'Kimi Code OAuth succeeded, but credentials could not be saved securely.',
    )
  } finally {
    await cleanup()
  }
})

test('unmounting cleans up the device-flow poller', async () => {
  const cleanupService = mock(() => {})
  const { statuses, cleanup } = await mountFlow('unmount', async () => {}, {
    createOAuthService: () => ({
      async startDeviceFlow(
        onDevice: (device: typeof DEVICE) => void | Promise<void>,
      ) {
        await onDevice(DEVICE)
        return new Promise<never>(() => {})
      },
      cleanup: cleanupService,
    }),
    isBareMode: () => false,
    openBrowser: async () => true,
    saveKimiCredentials: mock(() => ({ success: true })),
  })

  await waitForCondition(() => latest(statuses)?.state === 'waiting', {
    label: 'the waiting status',
  })
  expect(cleanupService).not.toHaveBeenCalled()

  await cleanup()

  // Without this the poller outlives the dialog and keeps hitting the token
  // endpoint for a flow nobody is watching.
  expect(cleanupService).toHaveBeenCalledTimes(1)
})
