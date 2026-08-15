import { PassThrough } from 'node:stream'

import { afterEach, expect, mock, test } from 'bun:test'
import React from 'react'
import { createRoot, Text } from 'src/terminal/ink.js'

// Capture real modules before the per-test mock.module() calls. mock.restore()
// (afterEach) only resets mock()/spyOn spies — it does NOT revert mock.module().
// The bootstrap/state.js stub here exposes only getIsNonInteractiveSession, so
// without restoring it later files lose switchSession/getSessionId (e.g.
// cost-tracker.projectTotals's switchSession→getSessionId round-trip).
const realBootstrapStateForApiKey = { ...(await import('src/bootstrap/state.js')) }
const realClaudeForApiKey = { ...(await import('src/services/api/claude.js')) }
const realAuthForApiKey = { ...(await import('src/services/auth/auth.js')) }

type AuthState = {
  anthropicAuthEnabled: boolean
  claudeSubscriber: boolean
  key?: string
  source?: string
}

function createTestStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
} {
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

  return { stdout, stdin }
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return
    }
    await Bun.sleep(10)
  }

  throw new Error('Timed out waiting for useApiKeyVerification test state')
}

afterEach(() => {
  mock.restore()
  // mock.restore() does not revert mock.module(); re-install the real modules.
  mock.module('src/bootstrap/state.js', () => realBootstrapStateForApiKey)
  mock.module('src/bootstrap/state.js', () => realBootstrapStateForApiKey)
  mock.module('src/services/api/claude.js', () => realClaudeForApiKey)
  mock.module('src/services/auth/auth.js', () => realAuthForApiKey)
})

test('useApiKeyVerification resets stale missing status when the session switches to a third-party provider', async () => {
  const authState: AuthState = {
    anthropicAuthEnabled: true,
    claudeSubscriber: false,
  }
  const seenStatuses: string[] = []

  mock.module('src/services/auth/auth.js', () => ({
    getAnthropicApiKeyWithSource: () => ({
      key: authState.key,
      source: authState.source,
    }),
    getApiKeyFromApiKeyHelper: async () => undefined,
    isAnthropicAuthEnabled: () => authState.anthropicAuthEnabled,
    isClaudeAISubscriber: () => authState.claudeSubscriber,
  }))

  mock.module('src/bootstrap/state.js', () => ({
    getIsNonInteractiveSession: () => false,
  }))

  mock.module('src/services/api/claude.js', () => ({
    verifyApiKey: async () => true,
  }))

  const { useApiKeyVerification } = await import(
    // @ts-expect-error cache-busting query string for Bun module mocks
    './useApiKeyVerification.ts?switch-to-third-party'
  )

  function Harness(): React.ReactNode {
    const { status } = useApiKeyVerification()

    React.useEffect(() => {
      seenStatuses.push(status)
    }, [status])

    return <Text>{status}</Text>
  }

  const { stdout, stdin } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(<Harness />)

  await waitForCondition(() => seenStatuses.includes('missing'))

  authState.anthropicAuthEnabled = false
  root.render(<Harness />)

  await waitForCondition(() => seenStatuses.includes('valid'))

  root.unmount()
  stdin.end()
  stdout.end()
  await Bun.sleep(0)

  expect(seenStatuses[0]).toBe('missing')
  expect(seenStatuses).toContain('valid')
})
