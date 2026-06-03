import { PassThrough } from 'node:stream'

import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'

import {
  resetGlobalConfigForTests,
  resetProjectConfigForTests,
} from '../utils/config.js'
import { createRoot } from '../ink.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { parseCustomHeaders } from './ProviderManager.js'
import { AppStateProvider } from '../state/AppState.js'

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

const ORIGINAL_ENV = {
  CLAUDE_CODE_SIMPLE: process.env.CLAUDE_CODE_SIMPLE,
  CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GH_TOKEN: process.env.GH_TOKEN,
}

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
  const timeoutMs = options?.timeoutMs ?? 2000
  const intervalMs = options?.intervalMs ?? 10
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return
    }
    await Bun.sleep(intervalMs)
  }

  throw new Error('Timed out waiting for ProviderManager test condition')
}

// Provider list is sorted alphabetically by label in the preset picker, so
// reaching a given provider takes more keypresses than it used to. Keep the
// target-by-label indirection here so these tests survive future list edits
// without further churn.
//
// Order matches ProviderManager.renderPresetSelection() when
// canUseCodexOAuth === true (default in mocked tests).
const PRESET_ORDER = [
  'Alibaba Coding Plan',
  'Alibaba Coding Plan (China)',
  'Anthropic',
  'Atomic Chat',
  'Azure OpenAI',
  'Azure AI Foundry',
  'AWS Bedrock',
  'Bankr',
  'Codex OAuth',
  'GitHub Copilot',
  'DeepSeek',
  'Google Gemini',
  'Google Vertex AI',
  'Groq',
  'LM Studio',
  'MiniMax',
  'Mistral',
  'Moonshot AI - API',
  'Moonshot AI - Kimi Code',
  'NVIDIA NIM',
  'OpenCode GO',
  'OpenCode Zen',
  'Ollama',
  'OpenAI',
  'OpenRouter',
  'Together AI',
  'Custom',
] as const

async function navigateToPreset(
  stdin: { write: (data: string) => void },
  label: (typeof PRESET_ORDER)[number],
): Promise<void> {
  const index = PRESET_ORDER.indexOf(label)
  if (index < 0) throw new Error(`Unknown preset label: ${label}`)
  for (let i = 0; i < index; i++) {
    stdin.write('j')
    await Bun.sleep(25)
  }
}

// Spread into plain objects so we hold a SNAPSHOT, not a live ESM namespace.
// Bun's `await import` returns live bindings that mutate when the module is
// re-mocked, so `() => realProviderProfilesForPm` would otherwise hand back
// whatever the most recent mock factory installed instead of the real exports.
const realProviderProfilesForPm = { ...(await import('../utils/providerProfiles.js')) }
const realProviderProfileForPm = { ...(await import('../utils/providerProfile.js')) }
const realSettingsForPm = { ...(await import('../utils/settings/settings.js')) }
const realClaudioMigrationForPm = { ...(await import('../utils/claudioMigration.js')) }
const realProviderDiscoveryForPm = { ...(await import('../utils/providerDiscovery.js')) }
const realGithubModelsCredentialsForPm = { ...(await import('../utils/githubModelsCredentials.js')) }
const realCodexCredentialsForPm = { ...(await import('../utils/codexCredentials.js')) }
const realUseCodexOAuthFlowForPm = { ...(await import('./useCodexOAuthFlow.js')) }

function mockProviderProfilesModule(options?: {
  addProviderProfile?: (...args: unknown[]) => unknown
  getActiveProviderProfile?: () => unknown
  getProviderProfiles?: () => unknown[]
  updateProviderProfile?: (...args: unknown[]) => unknown
  setActiveProviderProfile?: (...args: unknown[]) => unknown
}): void {
  mock.module('../utils/providerProfiles.js', () => ({
    ...realProviderProfilesForPm,
    addProviderProfile: options?.addProviderProfile ?? (() => null),
    deleteProviderProfile: () => ({ removed: false, activeProfileId: null }),
    getActiveProviderProfile: options?.getActiveProviderProfile ?? (() => null),
    getProviderPresetDefaults: (preset: string) => {
      if (preset === 'ollama') {
        return {
          provider: 'openai',
          name: 'Ollama',
          baseUrl: 'http://localhost:11434/v1',
          model: 'llama3.1:8b',
          apiKey: '',
        }
      }
      if (preset === 'bedrock') {
        return {
          provider: 'bedrock',
          name: 'AWS Bedrock',
          baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
          model: 'claude-sonnet-4-6',
          apiKey: '',
        }
      }
      if (preset === 'vertex') {
        return {
          provider: 'vertex',
          name: 'Google Vertex AI',
          baseUrl: 'https://us-central1-aiplatform.googleapis.com',
          model: 'claude-sonnet-4-6',
          apiKey: '',
        }
      }
      if (preset === 'foundry') {
        return {
          provider: 'foundry',
          name: 'Azure AI Foundry',
          baseUrl: 'https://YOUR-RESOURCE-NAME.services.ai.azure.com',
          model: 'claude-sonnet-4-6',
          apiKey: '',
        }
      }
      if (preset === 'anthropic') {
        return {
          provider: 'anthropic',
          name: 'Anthropic',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-6',
          apiKey: '',
        }
      }
      return {
        provider: 'openai',
        name: 'Mock provider',
        baseUrl: 'http://localhost:11434/v1',
        model: 'mock-model',
        apiKey: '',
      }
    },
    getProviderProfiles: options?.getProviderProfiles ?? (() => []),
    setActiveProviderProfile: options?.setActiveProviderProfile ?? (() => null),
    updateProviderProfile: options?.updateProviderProfile ?? (() => null),
  }))
}

function mockProviderManagerDependencies(
  options?: {
    addProviderProfile?: (...args: unknown[]) => unknown
    applySavedProfileToCurrentSession?: (...args: unknown[]) => Promise<string | null>
    clearCodexCredentials?: () => { success: boolean; warning?: string }
    getActiveProviderProfile?: () => unknown
    getProviderProfiles?: () => unknown[]
    probeOllamaGenerationReadiness?: () => Promise<{
      state: 'ready' | 'unreachable' | 'no_models' | 'generation_failed'
      models: Array<
        {
          name: string
          sizeBytes?: number | null
          family?: string | null
          families?: string[]
          parameterSize?: string | null
          quantizationLevel?: string | null
        }
      >
      probeModel?: string
      detail?: string
    }>
    codexSyncRead?: () => unknown
    codexAsyncRead?: () => Promise<unknown>
    updateProviderProfile?: (...args: unknown[]) => unknown
    setActiveProviderProfile?: (...args: unknown[]) => unknown
    useCodexOAuthFlow?: (options: {
      onAuthenticated: (tokens: {
        accessToken: string
        refreshToken: string
        accountId?: string
        idToken?: string
        apiKey?: string
      }, persistCredentials: (options?: { profileId?: string }) => void) =>
        void | Promise<void>
    }) => {
      state: 'starting' | 'waiting' | 'error'
      authUrl?: string
      browserOpened?: boolean | null
      message?: string
    }
  },
): void {
  mockProviderProfilesModule({
    addProviderProfile: options?.addProviderProfile,
    getActiveProviderProfile: options?.getActiveProviderProfile,
    getProviderProfiles: options?.getProviderProfiles,
    updateProviderProfile: options?.updateProviderProfile,
    setActiveProviderProfile: options?.setActiveProviderProfile,
  })

  mock.module('../utils/providerDiscovery.js', () => ({
    probeOllamaGenerationReadiness:
      options?.probeOllamaGenerationReadiness ??
      (async () => ({
        state: 'unreachable' as const,
        models: [],
      })),
  }))

  mock.module('../utils/githubModelsCredentials.js', () => ({
    clearGithubModelsToken: () => ({ success: true }),
  }))

  mock.module('../utils/codexCredentials.js', () => ({
    attachCodexProfileIdToStoredCredentials: () => ({ success: true }),
    clearCodexCredentials:
      options?.clearCodexCredentials ?? (() => ({ success: true })),
    readCodexCredentials:
      options?.codexSyncRead ?? (() => undefined),
    readCodexCredentialsAsync:
      options?.codexAsyncRead ?? (async () => undefined),
  }))

  mock.module('../utils/providerProfile.js', () => ({
    ...realProviderProfileForPm,
  }))

  mock.module('../utils/settings/settings.js', () => ({
    ...realSettingsForPm,
    updateSettingsForSource: () => ({ error: null }),
  }))

  mock.module('./useCodexOAuthFlow.js', () => ({
    useCodexOAuthFlow:
      options?.useCodexOAuthFlow ??
      (() => ({
        state: 'waiting' as const,
        authUrl: 'https://chatgpt.com/codex',
        browserOpened: true,
      })),
  }))

  // Suppress the migration banner inside ProviderManager so its Select doesn't
  // compete with the preset / menu Select for stdin in tests. Individual tests
  // that exercise the migration option override this mock after calling
  // mockProviderManagerDependencies().
  mock.module('../utils/claudioMigration.js', () => ({
    ...realClaudioMigrationForPm,
    shouldShowMigrationBanner: () => false,
    legacyClaudeDirExists: () => false,
  }))
}

async function waitForFrameOutput(
  getOutput: () => string,
  predicate: (output: string) => boolean,
  timeoutMs = 2500,
): Promise<string> {
  let output = ''

  await waitForCondition(() => {
    output = stripAnsi(extractLastFrame(getOutput()))
    return predicate(output)
  }, { timeoutMs })

  return output
}

async function mountProviderManager(
  ProviderManager: React.ComponentType<{
    mode: 'first-run' | 'manage'
    onDone: (result?: unknown) => void
  }>,
  options?: {
    mode?: 'first-run' | 'manage'
    onDone?: (result?: unknown) => void
    onChangeAppState?: (args: {
      newState: unknown
      oldState: unknown
    }) => void
  },
): Promise<{
  stdin: PassThrough
  getOutput: () => string
  dispose: () => Promise<void>
}> {
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(
    <AppStateProvider onChangeAppState={options?.onChangeAppState}>
      <KeybindingSetup>
        <ProviderManager
          mode={options?.mode ?? 'manage'}
          onDone={options?.onDone ?? (() => {})}
        />
      </KeybindingSetup>
    </AppStateProvider>,
  )

  return {
    stdin,
    getOutput,
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await Bun.sleep(0)
    },
  }
}

async function renderProviderManagerFrame(
  ProviderManager: React.ComponentType<{
    mode: 'first-run' | 'manage'
    onDone: (result?: unknown) => void
  }>,
  options?: {
    mode?: 'first-run' | 'manage'
    waitForOutput?: (output: string) => boolean
    timeoutMs?: number
  },
): Promise<string> {
  const mounted = await mountProviderManager(ProviderManager, {
    mode: options?.mode,
  })
  const output = await waitForFrameOutput(
    mounted.getOutput,
    frame => {
      if (!options?.waitForOutput) {
        return frame.includes('Provider manager')
      }
      return options.waitForOutput(frame)
    },
    options?.timeoutMs ?? 2500,
  )

  await mounted.dispose()
  return output
}

afterEach(() => {
  mock.restore()
  // ProviderManager tests share Bun's worker-level singletons
  // (TEST_GLOBAL_CONFIG_FOR_TESTING, TEST_PROJECT_CONFIG_FOR_TESTING).
  // Without this reset, a prior test that sets activeProviderProfileId would
  // leak a "Clear project override" menu entry into sibling tests and shift
  // every j-key index in those tests.
  resetGlobalConfigForTests()
  resetProjectConfigForTests()

  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key as keyof typeof ORIGINAL_ENV]
    } else {
      process.env[key as keyof typeof ORIGINAL_ENV] = value
    }
  }
})

afterAll(() => {
  // Restore module mocks so they don't bleed into other test files.
  // mock.restore() does not reset mock.module() calls.
  mock.module('../utils/claudioMigration.js', () => realClaudioMigrationForPm)
  mock.module('../utils/providerProfiles.js', () => realProviderProfilesForPm)
  mock.module('../utils/providerProfile.js', () => realProviderProfileForPm)
  mock.module('../utils/settings/settings.js', () => realSettingsForPm)
  mock.module('../utils/providerDiscovery.js', () => realProviderDiscoveryForPm)
  mock.module('../utils/githubModelsCredentials.js', () => realGithubModelsCredentialsForPm)
  mock.module('../utils/codexCredentials.js', () => realCodexCredentialsForPm)
  mock.module('./useCodexOAuthFlow.js', () => realUseCodexOAuthFlowForPm)
})

test('ProviderManager renders the GitHub Copilot profile exactly once when a real Copilot profile exists', async () => {
  // Regression: previously a synthetic "__github_models__" virtual entry was
  // injected whenever the secure-storage Copilot token existed, which double-
  // listed Copilot once GithubDeviceFlowStep started creating real profiles.
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const copilotProfile = {
    id: 'profile_copilot',
    name: 'GitHub Copilot',
    provider: 'openai' as const,
    baseUrl: 'https://api.githubcopilot.com',
    model: 'github:copilot',
    apiKey: 'gh-token',
    extras: { githubToken: 'gh-token' },
  }

  mockProviderManagerDependencies({
    getProviderProfiles: () => [copilotProfile],
    getActiveProviderProfile: () => copilotProfile,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const output = await renderProviderManagerFrame(ProviderManager, {
    waitForOutput: frame =>
      frame.includes('Provider manager') && frame.includes('GitHub Copilot'),
  })

  const copilotMatches = output.match(/GitHub Copilot/g) ?? []
  expect(copilotMatches.length).toBe(1)
  expect(output).not.toContain('github-models · https://models.github.ai/inference')
  expect(output).not.toContain('Checking GitHub Copilot credentials...')
})

test('ProviderManager preset list includes GitHub Copilot entry positioned after Codex OAuth', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  mockProviderManagerDependencies()

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const output = await renderProviderManagerFrame(ProviderManager, {
    mode: 'first-run',
    waitForOutput: frame =>
      frame.includes('Set up provider') &&
      frame.includes('Codex OAuth') &&
      frame.includes('GitHub Copilot'),
  })

  expect(output).toContain('Codex OAuth')
  expect(output).toContain('GitHub Copilot')
  expect(output.indexOf('GitHub Copilot')).toBeGreaterThan(
    output.indexOf('Codex OAuth'),
  )
})

test('ProviderManager first-run Ollama preset auto-detects installed models', async () => {
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const onDone = mock(() => {})
  const addProviderProfile = mock((payload: {
    provider: string
    name: string
    baseUrl: string
    model: string
    apiKey?: string
  }) => ({
    id: 'provider_ollama',
    provider: payload.provider,
    name: payload.name,
    baseUrl: payload.baseUrl,
    model: payload.model,
    apiKey: payload.apiKey,
  }))

  mockProviderManagerDependencies({
      addProviderProfile,
      probeOllamaGenerationReadiness: async () => ({
        state: 'ready',
        models: [
          {
            name: 'gemma4:31b-cloud',
            family: 'gemma',
            parameterSize: '31b',
          },
          {
            name: 'kimi-k2.5:cloud',
            family: 'kimi',
            parameterSize: '2.5b',
          },
        ],
        probeModel: 'gemma4:31b-cloud',
      }),
    },
  )

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, {
    mode: 'first-run',
    onDone,
  })

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Set up provider'),
  )

  await navigateToPreset(mounted.stdin, 'Ollama')
  mounted.stdin.write('\r')

  const modelFrame = await waitForFrameOutput(
    mounted.getOutput,
    frame =>
      frame.includes('Choose an Ollama model') &&
      frame.includes('gemma4:31b-cloud') &&
      frame.includes('kimi-k2.5:cloud'),
  )

  expect(modelFrame).toContain('Choose an Ollama model')
  expect(modelFrame).toContain('gemma4:31b-cloud')

  await Bun.sleep(25)
  mounted.stdin.write('\r')

  await waitForCondition(() => onDone.mock.calls.length > 0)

  expect(addProviderProfile).toHaveBeenCalled()
  expect(addProviderProfile.mock.calls[0]?.[0]).toMatchObject({
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'gemma4:31b-cloud',
  })
  expect(onDone).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'saved',
      message: 'Provider configured: Ollama',
    }),
  )

  await mounted.dispose()
})

test('ProviderManager activating a multi-model provider sets the session model to the primary model', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const multiModelProfile = {
    id: 'provider_multi_model',
    provider: 'openai',
    name: 'Multi Model Provider',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4; gpt-5.4-mini',
    apiKey: 'sk-test',
  }

  const setActiveProviderProfile = mock(() => multiModelProfile)
  const appStateChanges: Array<{ newState: any; oldState: any }> = []

  mockProviderManagerDependencies({
      getProviderProfiles: () => [multiModelProfile],
      setActiveProviderProfile,
    },
  )

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, {
    onChangeAppState: args => {
      appStateChanges.push(args as { newState: any; oldState: any })
    },
  })

  await waitForFrameOutput(
    mounted.getOutput,
    frame =>
      frame.includes('Provider manager') &&
      frame.includes('Set active provider'),
  )

  mounted.stdin.write('j')
  await Bun.sleep(25)
  mounted.stdin.write('\r')

  await waitForFrameOutput(
    mounted.getOutput,
    frame =>
      frame.includes('Set active provider') &&
      frame.includes('Multi Model Provider'),
  )

  await Bun.sleep(25)
  mounted.stdin.write('\r')

  await waitForCondition(() => setActiveProviderProfile.mock.calls.length > 0)
  await waitForCondition(() =>
    appStateChanges.some(
      ({ newState, oldState }) =>
        newState.mainLoopModel === 'gpt-5.4' &&
        oldState.mainLoopModel !== newState.mainLoopModel,
    ),
  )

  expect(setActiveProviderProfile).toHaveBeenCalledWith('provider_multi_model')
  expect(
    appStateChanges.some(
      ({ newState }) =>
        newState.mainLoopModel === 'gpt-5.4' &&
        newState.mainLoopModelForSession === null,
    ),
  ).toBe(true)
  expect(
    appStateChanges.some(
      ({ newState }) => newState.mainLoopModel === 'gpt-5.4; gpt-5.4-mini',
    ),
  ).toBe(false)

  await mounted.dispose()
})

test('ProviderManager editing an active multi-model provider keeps app state on the primary model', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const multiModelProfile = {
    id: 'provider_multi_model',
    provider: 'openai',
    name: 'Multi Model Provider',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4; gpt-5.4-mini',
    apiKey: 'sk-test',
  }

  const updateProviderProfile = mock(() => multiModelProfile)
  const appStateChanges: Array<{ newState: any; oldState: any }> = []

  mockProviderManagerDependencies({
      getActiveProviderProfile: () => multiModelProfile,
      getProviderProfiles: () => [multiModelProfile],
      updateProviderProfile,
    },
  )

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, {
    onChangeAppState: args => {
      appStateChanges.push(args as { newState: any; oldState: any })
    },
  })

  await waitForFrameOutput(
    mounted.getOutput,
    frame =>
      frame.includes('Provider manager') &&
      frame.includes('Edit provider'),
  )

  // Menu: Add(0), Set active Global(1), Set active Project(2), Edit(3),
  // Delete(4), Done(5). Three j-presses move cursor from Add to Edit.
  mounted.stdin.write('j')
  await Bun.sleep(25)
  mounted.stdin.write('j')
  await Bun.sleep(25)
  mounted.stdin.write('j')
  await Bun.sleep(25)
  mounted.stdin.write('\r')

  await waitForFrameOutput(
    mounted.getOutput,
    frame =>
      frame.includes('Edit provider') &&
      frame.includes('Multi Model Provider'),
  )

  await Bun.sleep(25)
  mounted.stdin.write('\r')

  await waitForFrameOutput(
    mounted.getOutput,
    frame =>
      frame.includes('Edit provider profile') &&
      frame.includes('Step 1 of 4'),
  )

  mounted.stdin.write('\r')
  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Step 2 of 4'),
  )

  mounted.stdin.write('\r')
  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Step 3 of 4'),
  )

  mounted.stdin.write('\r')
  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Step 4 of 4'),
  )

  mounted.stdin.write('\r')

  await waitForCondition(() => updateProviderProfile.mock.calls.length > 0)
  await waitForCondition(() =>
    appStateChanges.some(
      ({ newState, oldState }) =>
        newState.mainLoopModel === 'gpt-5.4' &&
        oldState.mainLoopModel !== newState.mainLoopModel,
    ),
  )

  expect(updateProviderProfile).toHaveBeenCalledWith(
    'provider_multi_model',
    expect.objectContaining({
      model: 'gpt-5.4; gpt-5.4-mini',
    }),
  )
  expect(
    appStateChanges.some(
      ({ newState }) =>
        newState.mainLoopModel === 'gpt-5.4' &&
        newState.mainLoopModelForSession === null,
    ),
  ).toBe(true)
  expect(
    appStateChanges.some(
      ({ newState }) => newState.mainLoopModel === 'gpt-5.4; gpt-5.4-mini',
    ),
  ).toBe(false)

  await mounted.dispose()
})

test('ProviderManager resolves Codex OAuth state from async storage without sync reads in render flow', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const codexSyncRead = mock(() => {
    throw new Error('sync codex credential read should not run in ProviderManager render flow')
  })
  const codexAsyncRead = mock(async () => ({
    accessToken: 'codex-access-token',
    refreshToken: 'codex-refresh-token',
  }))

  mockProviderManagerDependencies({
    codexSyncRead,
    codexAsyncRead,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const output = await renderProviderManagerFrame(ProviderManager, {
    waitForOutput: frame =>
      frame.includes('Provider manager') &&
      frame.includes('Log out Codex OAuth'),
  })

  expect(output).toContain('Provider manager')
  expect(output).toContain('Log out Codex OAuth')
  expect(codexSyncRead).not.toHaveBeenCalled()
  expect(codexAsyncRead).toHaveBeenCalled()
})

test('ProviderManager hides Codex OAuth setup in bare mode', async () => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  mockProviderManagerDependencies()

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const output = await renderProviderManagerFrame(ProviderManager, {
    mode: 'first-run',
    waitForOutput: frame =>
      frame.includes('Set up provider') && frame.includes('OpenAI'),
  })

  expect(output).toContain('Set up provider')
  expect(output).not.toContain('Codex OAuth')
})

test('ProviderManager Bedrock preset collects awsRegion before form', async () => {
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const onDone = mock(() => {})
  const addProviderProfile = mock((payload: {
    provider: string
    name: string
    baseUrl: string
    model: string
    apiKey?: string
    extras?: Record<string, unknown>
  }) => ({
    id: 'provider_bedrock',
    provider: payload.provider,
    name: payload.name,
    baseUrl: payload.baseUrl,
    model: payload.model,
    apiKey: payload.apiKey,
    extras: payload.extras,
  }))

  mockProviderManagerDependencies({
    addProviderProfile: addProviderProfile as unknown as (...args: unknown[]) => unknown,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, {
    mode: 'first-run',
    onDone,
  })

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Set up provider'),
  )

  await navigateToPreset(mounted.stdin, 'AWS Bedrock')
  mounted.stdin.write('\r')

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('AWS Bedrock setup') && frame.includes('AWS region'),
  )

  // Region step is required — submitting empty must surface an error.
  mounted.stdin.write('\r')
  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('AWS region is required.'),
  )

  // Type the region and submit.
  mounted.stdin.write('us-west-2\r')

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Create provider profile'),
  )

  // Walk through name → baseUrl → model → apiKey by accepting prefilled values.
  mounted.stdin.write('\r') // name
  await Bun.sleep(20)
  mounted.stdin.write('\r') // baseUrl
  await Bun.sleep(20)
  mounted.stdin.write('\r') // model
  await Bun.sleep(20)
  mounted.stdin.write('\r') // apiKey (optional, blank ok)

  await waitForCondition(() => onDone.mock.calls.length > 0)

  expect(addProviderProfile).toHaveBeenCalled()
  const payload = addProviderProfile.mock.calls[0]?.[0] as {
    provider: string
    extras?: { awsRegion?: string }
  }
  expect(payload.provider).toBe('bedrock')
  expect(payload.extras?.awsRegion).toBe('us-west-2')

  await mounted.dispose()
})

test('ProviderManager Vertex preset collects gcpProject and gcpRegion', async () => {
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const onDone = mock(() => {})
  const addProviderProfile = mock((payload: {
    provider: string
    extras?: Record<string, unknown>
  }) => ({ id: 'provider_vertex', ...payload }))

  mockProviderManagerDependencies({
    addProviderProfile: addProviderProfile as unknown as (...args: unknown[]) => unknown,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, {
    mode: 'first-run',
    onDone,
  })

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Set up provider'),
  )

  await navigateToPreset(mounted.stdin, 'Google Vertex AI')
  mounted.stdin.write('\r')

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Google Vertex AI setup'),
  )
  mounted.stdin.write('my-proj\r')
  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('GCP region'),
  )
  mounted.stdin.write('us-central1\r')

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Create provider profile'),
  )
  // Accept all prefilled values.
  mounted.stdin.write('\r')
  await Bun.sleep(20)
  mounted.stdin.write('\r')
  await Bun.sleep(20)
  mounted.stdin.write('\r')
  await Bun.sleep(20)
  mounted.stdin.write('\r')

  await waitForCondition(() => onDone.mock.calls.length > 0)

  const payload = addProviderProfile.mock.calls[0]?.[0] as {
    provider: string
    extras?: { gcpProject?: string; gcpRegion?: string }
  }
  expect(payload.provider).toBe('vertex')
  expect(payload.extras?.gcpProject).toBe('my-proj')
  expect(payload.extras?.gcpRegion).toBe('us-central1')

  await mounted.dispose()
})

test('ProviderManager Foundry preset collects azureResource', async () => {
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const onDone = mock(() => {})
  const addProviderProfile = mock((payload: {
    provider: string
    extras?: Record<string, unknown>
  }) => ({ id: 'provider_foundry', ...payload }))

  mockProviderManagerDependencies({
    addProviderProfile: addProviderProfile as unknown as (...args: unknown[]) => unknown,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, {
    mode: 'first-run',
    onDone,
  })

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Set up provider'),
  )

  await navigateToPreset(mounted.stdin, 'Azure AI Foundry')
  mounted.stdin.write('\r')

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Azure AI Foundry setup'),
  )
  mounted.stdin.write('my-foundry-rg\r')

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Create provider profile'),
  )
  mounted.stdin.write('\r')
  await Bun.sleep(20)
  mounted.stdin.write('\r')
  await Bun.sleep(20)
  mounted.stdin.write('\r')
  await Bun.sleep(20)
  mounted.stdin.write('\r')

  await waitForCondition(() => onDone.mock.calls.length > 0)

  const payload = addProviderProfile.mock.calls[0]?.[0] as {
    provider: string
    extras?: { azureResource?: string }
  }
  expect(payload.provider).toBe('foundry')
  expect(payload.extras?.azureResource).toBe('my-foundry-rg')

  await mounted.dispose()
})

test('ProviderManager Anthropic preset shows OAuth vs API-key choice', async () => {
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const onDone = mock(() => {})
  mockProviderManagerDependencies()

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, {
    mode: 'first-run',
    onDone,
  })

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Set up provider'),
  )

  await navigateToPreset(mounted.stdin, 'Anthropic')
  mounted.stdin.write('\r')

  const choiceFrame = await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Anthropic') && frame.includes('Sign in with web'),
  )

  expect(choiceFrame).toContain('Sign in with web')
  expect(choiceFrame).toContain('Use API key')

  await mounted.dispose()
})

test('ProviderManager Anthropic API-key path leads to form', async () => {
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const onDone = mock(() => {})
  mockProviderManagerDependencies()

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, {
    mode: 'first-run',
    onDone,
  })

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Set up provider'),
  )

  await navigateToPreset(mounted.stdin, 'Anthropic')
  mounted.stdin.write('\r')

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Sign in with web'),
  )
  // Move down to "Use API key" and press enter.
  mounted.stdin.write('j')
  await Bun.sleep(25)
  mounted.stdin.write('\r')

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Create provider profile'),
  )

  await mounted.dispose()
})

test('ProviderManager menu shows Import from Claude Code when ~/.claude/ is unmigrated', async () => {
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  mockProviderManagerDependencies()

  // Override only legacyClaudeDirExists; do NOT replace migrateLegacyClaudeDir
  // (binding leaks to commands/provider/migrate.test.tsx) and do NOT mock
  // config.js (that mock leaks into toolResultSummarizer.test.ts).
  mock.module('../utils/claudioMigration.js', () => ({
    ...realClaudioMigrationForPm,
    legacyClaudeDirExists: () => true,
    shouldShowMigrationBanner: () => false,
  }))

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const output = await renderProviderManagerFrame(ProviderManager, {
    waitForOutput: frame =>
      frame.includes('Provider manager') &&
      frame.includes('Import from Claude Code'),
  })

  expect(output).toContain('Provider manager')
  expect(output).toContain('Import from Claude Code')
})

test('ProviderManager menu hides Import from Claude Code when ~/.claude/ is absent', async () => {
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  mockProviderManagerDependencies()

  mock.module('../utils/claudioMigration.js', () => ({
    ...realClaudioMigrationForPm,
    legacyClaudeDirExists: () => false,
    shouldShowMigrationBanner: () => false,
  }))

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const output = await renderProviderManagerFrame(ProviderManager, {
    waitForOutput: frame => frame.includes('Provider manager'),
  })

  expect(output).toContain('Provider manager')
  expect(output).not.toContain('Import from Claude Code')
})

describe('parseCustomHeaders', () => {
  test('parses a single valid line', () => {
    expect(parseCustomHeaders('X-Custom: foo')).toEqual({ 'X-Custom': 'foo' })
  })

  test('splits on the first colon only — preserves URL-shaped values', () => {
    expect(parseCustomHeaders('Forward: https://api.example.com/v1')).toEqual({
      Forward: 'https://api.example.com/v1',
    })
  })

  test('drops invalid lines (no colon, empty key, empty value, blank)', () => {
    const text = 'no-colon-line\n: empty-key\nKey: \n  \n'
    expect(parseCustomHeaders(text)).toEqual({})
  })

  test('trims whitespace from keys and values', () => {
    expect(parseCustomHeaders('  X-Foo  :   bar  ')).toEqual({ 'X-Foo': 'bar' })
  })

  test('handles mixed valid + invalid lines across CRLF and LF separators', () => {
    const text = 'X-A: 1\r\nbroken\nX-B: two\r\n: nope\nX-C:three'
    expect(parseCustomHeaders(text)).toEqual({
      'X-A': '1',
      'X-B': 'two',
      'X-C': 'three',
    })
  })
})
