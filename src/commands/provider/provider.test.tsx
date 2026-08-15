import { PassThrough } from 'node:stream'

import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'

import { render } from 'src/ink.js'
import { AppStateProvider } from 'src/state/AppState.js'
import type { ProviderProfile } from 'src/services/config/config.js'
import { buildProviderManagerCompletion } from 'src/commands/provider/provider.js'

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

const realGithubModelsCredentials = { ...(await import(
  'src/services/api/githubModelsCredentials.js'
)) }

afterAll(() => {
  mock.module(
    'src/services/api/githubModelsCredentials.js',
    () => realGithubModelsCredentials,
  )
})

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0

  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) {
      break
    }

    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) {
      break
    }

    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) {
      lastFrame = frame
    }
    cursor = end + SYNC_END.length
  }

  return lastFrame ?? output
}

async function renderFinalFrame(node: React.ReactNode): Promise<string> {
  const { stdout, stdin, getOutput } = createTestStreams()

  const instance = await render(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  await Promise.race([
    instance.waitUntilExit(),
    new Promise<void>(resolve => setTimeout(resolve, 3000)),
  ])
  return stripAnsi(extractLastFrame(getOutput()))
}

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

afterEach(() => {
  mock.restore()
})

test('buildProviderManagerCompletion records provider switch event and model-visible reminder', () => {
  const completion = buildProviderManagerCompletion({
    action: 'activated',
    activeProviderName: 'Sadaf Provider',
    activeProviderModel: 'sadaf-model',
    message: 'Provider switched to Sadaf Provider (sadaf-model)',
  })

  expect(completion.message).toBe(
    'Provider switched to Sadaf Provider (sadaf-model)',
  )
  expect(completion.metaMessages).toEqual([
    '<system-reminder>Provider switched mid-session to Sadaf Provider using model sadaf-model. Use this provider/model for subsequent requests unless the user switches again.</system-reminder>',
  ])
})

test('buildProviderManagerCompletion skips provider reminder when manager is cancelled', () => {
  const completion = buildProviderManagerCompletion({
    action: 'cancelled',
    message: 'Provider manager closed',
  })

  expect(completion.message).toBe('Provider manager closed')
  expect(completion.metaMessages).toBeUndefined()
})

test('GithubDeviceFlowStep renders setup menu when no stored token exists', async () => {
  mock.module('src/services/api/githubModelsCredentials.js', () => ({
    ...realGithubModelsCredentials,
    readGithubModelsToken: () => undefined,
  }))

  const { GithubDeviceFlowStep } = await import(
    // @ts-expect-error cache-busting query string for Bun module mocks
    './GithubDeviceFlowStep.js?no-token'
  )

  const output = await renderFinalFrame(
    <AppStateProvider>
      <GithubDeviceFlowStep onDone={() => {}} onBack={() => {}} />
    </AppStateProvider>,
  )

  expect(output).toContain('GitHub Copilot setup')
  expect(output).toContain('Sign in with browser')
  expect(output).toContain('Back to /provider menu')
})

test('GithubDeviceFlowStep renders already-authed screen when a token is stored', async () => {
  mock.module('src/services/api/githubModelsCredentials.js', () => ({
    ...realGithubModelsCredentials,
    readGithubModelsToken: () => 'stored-copilot-token',
  }))

  const { GithubDeviceFlowStep } = await import(
    // @ts-expect-error cache-busting query string for Bun module mocks
    './GithubDeviceFlowStep.js?already-authed'
  )

  const output = await renderFinalFrame(
    <AppStateProvider>
      <GithubDeviceFlowStep onDone={() => {}} onBack={() => {}} />
    </AppStateProvider>,
  )

  expect(output).toContain('You are already signed in to GitHub Copilot.')
  expect(output).toContain('Sign in again')
  expect(output).toContain('Back to /provider menu')
})

const realProviderProfilesForFinalize = { ...(await import(
  'src/services/api/providerProfiles.js'
)) }

afterAll(() => {
  mock.module(
    'src/services/api/providerProfiles.js',
    () => realProviderProfilesForFinalize,
  )
})

function mockProviderProfilesForFinalize(options: {
  profiles: ProviderProfile[]
}): {
  addProviderProfile: ReturnType<typeof mock>
  updateProviderProfile: ReturnType<typeof mock>
  setActiveProviderProfile: ReturnType<typeof mock>
} {
  const addProviderProfile = mock(() => ({ id: 'profile_saved' }))
  const updateProviderProfile = mock(() => ({ id: 'profile_saved' }))
  const setActiveProviderProfile = mock(() => null)
  mock.module('src/services/api/providerProfiles.js', () => ({
    ...realProviderProfilesForFinalize,
    getProviderProfiles: () => options.profiles,
    addProviderProfile,
    updateProviderProfile,
    setActiveProviderProfile,
  }))
  return { addProviderProfile, updateProviderProfile, setActiveProviderProfile }
}

test('persistCopilotProfile updates existing Copilot profile when re-signing in with a non-Copilot active profile', async () => {
  const copilotProfile = {
    id: 'profile_copilot',
    name: 'GitHub Copilot',
    provider: 'openai' as const,
    baseUrl: 'https://api.githubcopilot.com',
    model: 'github:copilot',
    apiKey: 'old-token',
    extras: { githubToken: 'old-token' },
  }
  const anthropicProfile = {
    id: 'profile_anthropic',
    name: 'Anthropic',
    provider: 'anthropic' as const,
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-6',
  }
  const mocks = mockProviderProfilesForFinalize({
    profiles: [anthropicProfile, copilotProfile],
  })

  const { persistCopilotProfile } = await import(
    // @ts-expect-error cache-busting
    './GithubDeviceFlowStep.js?finalize-update-non-active'
  )

  const result = persistCopilotProfile('new-token', 'github:copilot')

  expect(result).toEqual({ mode: 'updated' })
  expect(mocks.addProviderProfile).not.toHaveBeenCalled()
  expect(mocks.updateProviderProfile).toHaveBeenCalledTimes(1)
  expect(mocks.updateProviderProfile).toHaveBeenCalledWith(
    'profile_copilot',
    expect.objectContaining({
      apiKey: 'new-token',
      extras: expect.objectContaining({ githubToken: 'new-token' }),
    }),
  )
  expect(mocks.setActiveProviderProfile).toHaveBeenCalledWith('profile_copilot')
})

test('persistCopilotProfile updates the active Copilot profile in place', async () => {
  const copilotProfile = {
    id: 'profile_copilot',
    name: 'GitHub Copilot',
    provider: 'openai' as const,
    baseUrl: 'https://api.githubcopilot.com',
    model: 'github:copilot',
    apiKey: 'old-token',
    extras: { githubToken: 'old-token' },
  }
  const mocks = mockProviderProfilesForFinalize({ profiles: [copilotProfile] })

  const { persistCopilotProfile } = await import(
    // @ts-expect-error cache-busting
    './GithubDeviceFlowStep.js?finalize-update-active'
  )

  persistCopilotProfile('refreshed-token')

  expect(mocks.addProviderProfile).not.toHaveBeenCalled()
  expect(mocks.updateProviderProfile).toHaveBeenCalledTimes(1)
  expect(mocks.updateProviderProfile.mock.calls[0]?.[1]).toMatchObject({
    apiKey: 'refreshed-token',
    extras: { githubToken: 'refreshed-token' },
  })
})

test('persistCopilotProfile creates a new Copilot profile when none exists', async () => {
  const anthropicProfile = {
    id: 'profile_anthropic',
    name: 'Anthropic',
    provider: 'anthropic' as const,
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-6',
  }
  const mocks = mockProviderProfilesForFinalize({
    profiles: [anthropicProfile],
  })

  const { persistCopilotProfile } = await import(
    // @ts-expect-error cache-busting
    './GithubDeviceFlowStep.js?finalize-create'
  )

  persistCopilotProfile('fresh-token')

  expect(mocks.updateProviderProfile).not.toHaveBeenCalled()
  expect(mocks.setActiveProviderProfile).not.toHaveBeenCalled()
  expect(mocks.addProviderProfile).toHaveBeenCalledTimes(1)
  expect(mocks.addProviderProfile.mock.calls[0]?.[0]).toMatchObject({
    provider: 'openai',
    name: 'GitHub Copilot',
    baseUrl: 'https://api.githubcopilot.com',
    apiKey: 'fresh-token',
    extras: { githubToken: 'fresh-token' },
  })
  expect(mocks.addProviderProfile.mock.calls[0]?.[1]).toEqual({
    makeActive: true,
  })
})

test('persistCopilotProfile reports failure when the profile cannot be saved', async () => {
  const addProviderProfile = mock(() => null)
  const updateProviderProfile = mock(() => null)
  const setActiveProviderProfile = mock(() => null)
  mock.module('src/services/api/providerProfiles.js', () => ({
    ...realProviderProfilesForFinalize,
    getProviderProfiles: () => [],
    addProviderProfile,
    updateProviderProfile,
    setActiveProviderProfile,
  }))

  const { persistCopilotProfile } = await import(
    // @ts-expect-error cache-busting
    './GithubDeviceFlowStep.js?finalize-failed'
  )

  const result = persistCopilotProfile('fresh-token')

  expect(result).toEqual({ mode: 'failed' })
  expect(setActiveProviderProfile).not.toHaveBeenCalled()
})
