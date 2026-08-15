import { PassThrough } from 'node:stream'

import { afterEach, expect, mock, test } from 'bun:test'
import React from 'react'

import { createRoot, Text } from 'src/terminal/ink.js'
import type { XaiDeviceCodeResponse } from 'src/providers/oauth/xaiOAuth.js'

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

function createTestStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  getOutput: () => string
} {
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }

  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  return {
    stdout,
    stdin,
    getOutput: () => output,
  }
}

async function waitForCondition(
  predicate: () => boolean,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 5000
  const intervalMs = options?.intervalMs ?? 10
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return
    }
    await Bun.sleep(intervalMs)
  }

  throw new Error('Timed out waiting for useXaiOAuthFlow test condition')
}

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0

  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) break

    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) break

    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) {
      lastFrame = frame
    }
    cursor = end + SYNC_END.length
  }

  return lastFrame ?? output
}

const TOKENS = {
  accessToken: 'xai-access-token',
  refreshToken: 'xai-refresh-token',
  idToken: 'xai-id-token',
  expiresAt: 1_900_000_000_000,
}

const DEVICE: XaiDeviceCodeResponse = {
  device_code: 'device-abc',
  user_code: 'WXYZ-1234',
  verification_uri: 'https://accounts.x.ai/device',
  verification_uri_complete:
    'https://accounts.x.ai/device?user_code=WXYZ-1234',
  expires_in: 600,
  interval: 5,
}

afterEach(() => {
  mock.restore()
})

test('does not persist credentials when downstream setup rejects', async () => {
  const saveXaiCredentials = mock(() => ({ success: true }))
  const cleanup = mock(() => {})
  const onAuthenticated = mock(async () => {
    throw new Error('profile save failed')
  })
  const deps = {
    createOAuthService: () => ({
      async startDeviceFlow(
        onDeviceCode: (device: XaiDeviceCodeResponse) => void | Promise<void>,
      ) {
        await onDeviceCode(DEVICE)
        return TOKENS
      },
      cleanup,
    }),
    saveXaiCredentials,
    isBareMode: () => false,
  }

  const { useXaiOAuthFlow } = await import(
    `./useXaiOAuthFlow.js?real-reject-${Date.now()}-${Math.random()}`
  )

  function Harness(): React.ReactNode {
    const handleAuthenticated = React.useCallback(onAuthenticated, [
      onAuthenticated,
    ])
    const status = useXaiOAuthFlow({
      onAuthenticated: handleAuthenticated,
      deps,
    })

    return (
      <Text>{status.state === 'error' ? status.message : status.state}</Text>
    )
  }

  const streams = createTestStreams()
  const root = await createRoot({
    stdout: streams.stdout as unknown as NodeJS.WriteStream,
    stdin: streams.stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(<Harness />)

  try {
    await waitForCondition(() => onAuthenticated.mock.calls.length === 1)
    await Bun.sleep(0)
    await Bun.sleep(0)
    expect(onAuthenticated).toHaveBeenCalled()
    expect(saveXaiCredentials).not.toHaveBeenCalled()
  } finally {
    root.unmount()
    streams.stdin.end()
    streams.stdout.end()
    await Bun.sleep(0)
  }
})

test('persists credentials with profile linkage after downstream setup succeeds', async () => {
  const saveXaiCredentials = mock(() => ({ success: true }))
  const onAuthenticated = mock(
    async (
      _tokens: typeof TOKENS,
      persistCredentials: (options?: { profileId?: string }) => void,
    ) => {
      persistCredentials({ profileId: 'profile_xai_oauth' })
    },
  )
  const cleanup = mock(() => {})
  const deps = {
    createOAuthService: () => ({
      async startDeviceFlow(
        onDeviceCode: (device: XaiDeviceCodeResponse) => void | Promise<void>,
      ) {
        await onDeviceCode(DEVICE)
        return TOKENS
      },
      cleanup,
    }),
    saveXaiCredentials,
    isBareMode: () => false,
  }

  const { useXaiOAuthFlow } = await import(
    `./useXaiOAuthFlow.js?real-persist-${Date.now()}-${Math.random()}`
  )

  function Harness(): React.ReactNode {
    const handleAuthenticated = React.useCallback(onAuthenticated, [
      onAuthenticated,
    ])
    useXaiOAuthFlow({
      onAuthenticated: handleAuthenticated,
      deps,
    })
    return <Text>waiting</Text>
  }

  const streams = createTestStreams()
  const root = await createRoot({
    stdout: streams.stdout as unknown as NodeJS.WriteStream,
    stdin: streams.stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(<Harness />)

  try {
    await waitForCondition(() => onAuthenticated.mock.calls.length === 1)
    await waitForCondition(() => saveXaiCredentials.mock.calls.length === 1)
    expect(onAuthenticated).toHaveBeenCalled()
    expect(saveXaiCredentials).toHaveBeenCalledWith({
      accessToken: TOKENS.accessToken,
      refreshToken: TOKENS.refreshToken,
      idToken: TOKENS.idToken,
      expiresAt: TOKENS.expiresAt,
      profileId: 'profile_xai_oauth',
    })
  } finally {
    root.unmount()
    streams.stdin.end()
    streams.stdout.end()
    await Bun.sleep(0)
  }
})

test('exposes the device code while polling so the UI can render it', async () => {
  const saveXaiCredentials = mock(() => ({ success: true }))
  const onAuthenticated = mock(async () => {})
  let resolveTokens!: (value: typeof TOKENS) => void
  const tokensPending = new Promise<typeof TOKENS>(resolve => {
    resolveTokens = resolve
  })
  const cleanup = mock(() => {})
  const deps = {
    createOAuthService: () => ({
      async startDeviceFlow(
        onDeviceCode: (device: XaiDeviceCodeResponse) => void | Promise<void>,
      ) {
        await onDeviceCode(DEVICE)
        return tokensPending
      },
      cleanup,
    }),
    saveXaiCredentials,
    isBareMode: () => false,
  }

  const { useXaiOAuthFlow } = await import(
    `./useXaiOAuthFlow.js?device-code-${Date.now()}-${Math.random()}`
  )

  function Harness(): React.ReactNode {
    const handleAuthenticated = React.useCallback(onAuthenticated, [
      onAuthenticated,
    ])
    const status = useXaiOAuthFlow({
      onAuthenticated: handleAuthenticated,
      deps,
    })
    if (status.state === 'waiting') {
      return (
        <Text>
          code:{status.userCode} url:{status.verificationUri}
        </Text>
      )
    }
    return <Text>{status.state}</Text>
  }

  const streams = createTestStreams()
  const root = await createRoot({
    stdout: streams.stdout as unknown as NodeJS.WriteStream,
    stdin: streams.stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(<Harness />)

  try {
    await waitForCondition(() => {
      const frame = extractLastFrame(streams.getOutput())
      return frame.includes('WXYZ-1234') && frame.includes('accounts.x.ai')
    })
    resolveTokens(TOKENS)
    await waitForCondition(() => onAuthenticated.mock.calls.length === 1)
  } finally {
    root.unmount()
    streams.stdin.end()
    streams.stdout.end()
    await Bun.sleep(0)
  }
})

test('blocks under bare mode with a clear error', async () => {
  const saveXaiCredentials = mock(() => ({ success: true }))
  const startDeviceFlow = mock(async () => TOKENS)
  const cleanup = mock(() => {})
  const onAuthenticated = mock(async () => {})
  const deps = {
    createOAuthService: () => ({
      startDeviceFlow,
      cleanup,
    }),
    saveXaiCredentials,
    isBareMode: () => true,
  }

  const { useXaiOAuthFlow } = await import(
    `./useXaiOAuthFlow.js?bare-block-${Date.now()}-${Math.random()}`
  )

  function Harness(): React.ReactNode {
    const handleAuthenticated = React.useCallback(onAuthenticated, [
      onAuthenticated,
    ])
    const status = useXaiOAuthFlow({
      onAuthenticated: handleAuthenticated,
      deps,
    })
    return (
      <Text>{status.state === 'error' ? status.message : status.state}</Text>
    )
  }

  const streams = createTestStreams()
  const root = await createRoot({
    stdout: streams.stdout as unknown as NodeJS.WriteStream,
    stdin: streams.stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(<Harness />)

  try {
    await waitForCondition(() => {
      const frame = extractLastFrame(streams.getOutput())
      return frame.includes('unavailable in --bare')
    })
    expect(startDeviceFlow).not.toHaveBeenCalled()
    expect(saveXaiCredentials).not.toHaveBeenCalled()
  } finally {
    root.unmount()
    streams.stdin.end()
    streams.stdout.end()
    await Bun.sleep(0)
  }
})
