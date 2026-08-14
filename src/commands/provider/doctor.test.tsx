import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ResolvedProvider } from 'src/services/api/activeProvider.js'

// Capture real modules first so the mock spreads carry every export. Following
// CLAUDE.md mock.module rules — never narrow the namespace shape and restore
// at teardown so the mocks don't bleed into later test files. We snapshot the
// genuine exports into plain objects so the restore in afterAll cannot pick
// up our own overrides through live bindings.
const realActiveProviderNS = { ...(await import('src/services/api/activeProvider.js')) }
const realGeminiAuthNS = { ...(await import('src/services/api/geminiAuth.js')) }
const realProviderDiscoveryNS = { ...(await import('src/services/api/providerDiscovery.js')) }
const realModelNS = { ...(await import('src/utils/model/model.js')) }
const realSideQueryNS = { ...(await import('src/utils/sideQuery.js')) }

const realActiveProvider = { ...realActiveProviderNS }
const realGeminiAuth = { ...realGeminiAuthNS }
const realProviderDiscovery = { ...realProviderDiscoveryNS }
const realModel = { ...realModelNS }
const realSideQuery = { ...realSideQueryNS }

type DoctorMockState = {
  activeProvider: ResolvedProvider | null
  geminiKind: 'api-key' | 'access-token' | 'adc' | 'none'
  ollamaState: 'ready' | 'unreachable' | 'no_models' | 'generation_failed'
  mainLoopModel: string
  probeOk: boolean
}

const state: DoctorMockState = {
  activeProvider: null,
  geminiKind: 'api-key',
  ollamaState: 'ready',
  mainLoopModel: 'gpt-5.4',
  probeOk: true,
}

const fakeProbeMessage = {
  id: 'msg_probe',
  type: 'message',
  role: 'assistant',
  model: 'probe',
  content: state.probeOk
    ? [
        {
          type: 'tool_use',
          id: 'toolu_p',
          name: 'classify_result',
          input: { thinking: 'benign', shouldBlock: false, reason: 'probe' },
        },
      ]
    : [{ type: 'text', text: 'ok' }],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
}

const sideQueryMock = async () => ({
  ...fakeProbeMessage,
  content: state.probeOk
    ? [
        {
          type: 'tool_use',
          id: 'toolu_p',
          name: 'classify_result',
          input: { thinking: 'benign', shouldBlock: false, reason: 'probe' },
        },
      ]
    : [{ type: 'text', text: 'ok' }],
})

mock.module('src/services/api/activeProvider.js', () => ({
  ...realActiveProvider,
  tryGetActiveProvider: () => state.activeProvider,
}))

mock.module('src/utils/model/model.js', () => ({
  ...realModel,
  getMainLoopModel: () => state.mainLoopModel,
}))
mock.module('src/utils/model/model.js', () => ({
  ...realModel,
  getMainLoopModel: () => state.mainLoopModel,
}))

// The doctor check probes via sideQuery; without a mock it would hit the real
// API wrapper and fail on build-time MACROs under bun test. Mock both
// specifier forms so the mock survives cross-file mock pre-application.
mock.module('src/utils/sideQuery.js', () => ({
  ...realSideQuery,
  sideQuery: sideQueryMock,
}))
mock.module('src/utils/sideQuery.js', () => ({
  ...realSideQuery,
  sideQuery: sideQueryMock,
}))

mock.module('src/services/api/geminiAuth.js', () => ({
  ...realGeminiAuth,
  resolveGeminiCredential: async () =>
    state.geminiKind === 'none'
      ? { kind: 'none' as const }
      : state.geminiKind === 'api-key'
        ? { kind: 'api-key' as const, credential: 'k' }
        : { kind: state.geminiKind, credential: 'tok' },
}))

mock.module('src/services/api/providerDiscovery.js', () => ({
  ...realProviderDiscovery,
  probeOllamaGenerationReadiness: async () => ({
    state: state.ollamaState,
    models: [],
    probeModel: 'llama3.1:8b',
    detail: state.ollamaState === 'generation_failed' ? 'mock failure' : undefined,
  }),
}))

afterAll(() => {
  mock.module('src/services/api/activeProvider.js', () => realActiveProvider)
  mock.module('src/services/api/geminiAuth.js', () => realGeminiAuth)
  mock.module('src/services/api/providerDiscovery.js', () => realProviderDiscovery)
  mock.module('src/utils/model/model.js', () => realModel)
  mock.module('src/utils/model/model.js', () => realModel)
  mock.module('src/utils/sideQuery.js', () => realSideQuery)
  mock.module('src/utils/sideQuery.js', () => realSideQuery)
})

const { runProviderDoctor } = await import('./doctor.js')
const { __setClassifierProbeStoreDirForTests } = await import(
  'src/services/permissions/classifierProbeStore.js'
)

const ORIGINAL_FETCH = globalThis.fetch
function installFetchMock(impl: () => Promise<Response>): void {
  globalThis.fetch = impl as unknown as typeof globalThis.fetch
}

function makeOkResponse(): Response {
  return new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function makeStatusResponse(status: number, body = ''): Response {
  return new Response(body, { status })
}

function profile(overrides: Partial<ResolvedProvider>): ResolvedProvider {
  return {
    name: overrides.name ?? 'test-profile',
    transport: overrides.transport ?? 'openai_compat',
    baseUrl: overrides.baseUrl ?? 'https://api.example.com/v1',
    model: overrides.model ?? 'gpt-5.4',
    apiKey: overrides.apiKey,
    extras: overrides.extras,
  }
}

let probeStoreDir: string

beforeEach(() => {
  state.activeProvider = null
  state.geminiKind = 'api-key'
  state.ollamaState = 'ready'
  state.mainLoopModel = 'gpt-5.4'
  state.probeOk = true
  installFetchMock(async () => makeOkResponse())
  // runProviderDoctor probes non-Claude models and persists the result —
  // point the store at a tmpdir so tests never touch the real ~/.claudin cache.
  probeStoreDir = mkdtempSync(join(tmpdir(), 'doctor-probe-store-'))
  __setClassifierProbeStoreDirForTests(probeStoreDir)
})

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  __setClassifierProbeStoreDirForTests(undefined)
  rmSync(probeStoreDir, { recursive: true, force: true })
})

describe('runProviderDoctor — no active profile', () => {
  test('returns the explicit no-profile message', async () => {
    state.activeProvider = null
    const out = await runProviderDoctor()
    expect(out).toContain('No active /provider profile')
    expect(out).toContain('/provider')
  })
})

describe('runProviderDoctor — transport branches', () => {
  test('anthropic transport reports profile + reachability', async () => {
    state.activeProvider = profile({
      transport: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
      apiKey: 'sk-ant',
    })
    const out = await runProviderDoctor()
    expect(out).toContain('Active profile transport: anthropic')
    expect(out).toContain('Anthropic API key')
    expect(out).toContain('[OK] Reachability')
  })

  test('anthropic transport without api key falls back to OAuth message', async () => {
    state.activeProvider = profile({
      transport: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
    })
    const out = await runProviderDoctor()
    expect(out).toContain('relying on OAuth/login')
  })

  test('gemini transport reports auth + models endpoint', async () => {
    state.activeProvider = profile({
      transport: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-3-flash-preview',
    })
    state.geminiKind = 'api-key'
    const out = await runProviderDoctor()
    expect(out).toContain('Active profile transport: gemini')
    expect(out).toContain('Gemini auth')
    expect(out).toContain('kind=api-key')
    expect(out).toContain('Models endpoint')
  })

  test('gemini transport with no credentials surfaces FAIL', async () => {
    state.activeProvider = profile({
      transport: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-3-flash-preview',
    })
    state.geminiKind = 'none'
    const out = await runProviderDoctor()
    expect(out).toContain('[FAIL] Gemini auth')
  })

  test('mistral transport reaches the models endpoint', async () => {
    state.activeProvider = profile({
      transport: 'mistral',
      baseUrl: 'https://api.mistral.ai/v1',
      model: 'devstral-latest',
      apiKey: 'sk-m',
    })
    const out = await runProviderDoctor()
    expect(out).toContain('Active profile transport: mistral')
    expect(out).toContain('[OK] Models endpoint')
  })

  test('github_copilot transport detects token and probes endpoint', async () => {
    state.activeProvider = profile({
      transport: 'github_copilot',
      baseUrl: 'https://api.githubcopilot.com',
      model: 'github:copilot',
      extras: { githubToken: 'ghp_xxx' },
    })
    const out = await runProviderDoctor()
    expect(out).toContain('Active profile transport: github_copilot')
    expect(out).toContain('GitHub Copilot token')
    expect(out).toContain('[OK] GitHub Copilot token')
  })

  test('github_copilot transport without token surfaces FAIL', async () => {
    state.activeProvider = profile({
      transport: 'github_copilot',
      baseUrl: 'https://api.githubcopilot.com',
      model: 'github:copilot',
    })
    const out = await runProviderDoctor()
    expect(out).toContain('[FAIL] GitHub Copilot token')
  })

  test('codex_responses transport reports the resolved model', async () => {
    state.activeProvider = profile({
      transport: 'codex_responses',
      baseUrl: 'https://api.openai.com/v1',
      model: 'codexplan',
      apiKey: 'sk-codex',
    })
    const out = await runProviderDoctor()
    expect(out).toContain('Active profile transport: codex_responses')
    expect(out).toContain('Codex transport')
    expect(out).toContain('codexplan')
  })

  test('openai_compat transport hits the models endpoint by default', async () => {
    state.activeProvider = profile({
      transport: 'openai_compat',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4',
      apiKey: 'sk-x',
    })
    const out = await runProviderDoctor()
    expect(out).toContain('Active profile transport: openai_compat')
    expect(out).toContain('[OK] Models endpoint')
  })

  test('openai_compat transport routed to ollama probe for localhost:11434', async () => {
    state.activeProvider = profile({
      transport: 'openai_compat',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.1:8b',
    })
    state.ollamaState = 'ready'
    const out = await runProviderDoctor()
    expect(out).toContain('[OK] Ollama generation')
  })

  test('openai_compat transport reports unreachable Ollama backend', async () => {
    state.activeProvider = profile({
      transport: 'openai_compat',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.1:8b',
    })
    state.ollamaState = 'unreachable'
    const out = await runProviderDoctor()
    expect(out).toContain('[FAIL] Ollama reachability')
  })

  test('bedrock transport defers to AWS SDK chains without probing', async () => {
    state.activeProvider = profile({
      transport: 'bedrock',
      baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      model: 'claude-sonnet-4-6',
      extras: { awsRegion: 'us-east-1' },
    })
    const out = await runProviderDoctor()
    expect(out).toContain('Active profile transport: bedrock')
    expect(out).toContain('Cloud transport')
    expect(out).toContain('AWS/GCP/Azure SDK')
  })

  test('vertex transport defers to GCP SDK chains', async () => {
    state.activeProvider = profile({
      transport: 'vertex',
      baseUrl: 'https://us-central1-aiplatform.googleapis.com',
      model: 'claude-sonnet-4-6',
      extras: { gcpProject: 'p', gcpRegion: 'us-central1' },
    })
    const out = await runProviderDoctor()
    expect(out).toContain('Active profile transport: vertex')
    expect(out).toContain('Cloud transport')
  })

  test('foundry transport defers to Azure SDK chains', async () => {
    state.activeProvider = profile({
      transport: 'foundry',
      baseUrl: 'https://my-foundry.services.ai.azure.com',
      model: 'claude-sonnet-4-6',
      extras: { azureResource: 'my-foundry' },
    })
    const out = await runProviderDoctor()
    expect(out).toContain('Active profile transport: foundry')
    expect(out).toContain('Cloud transport')
  })
})

describe('runProviderDoctor — failure surfaces', () => {
  test('open-ai-compat 401 maps to Auth FAIL', async () => {
    state.activeProvider = profile({
      transport: 'openai_compat',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-5.4',
      apiKey: 'wrong',
    })
    installFetchMock(async () => makeStatusResponse(401, 'unauthorized'))
    const out = await runProviderDoctor()
    expect(out).toContain('[FAIL] Auth')
    expect(out).toContain('check(s) failed')
  })

  test('summary tail reflects all-pass when no FAILs are present', async () => {
    state.activeProvider = profile({
      transport: 'openai_compat',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4',
      apiKey: 'sk-x',
    })
    const out = await runProviderDoctor()
    expect(out).toContain('All checks passed.')
  })
})

// feature('TRANSCRIPT_CLASSIFIER') is false under bun test (folded only at
// build time), so modelSupportsAutoMode needs the test hatch to exercise the
// real name-gate logic.
const { __setAutoModeEnabledForTests } = await import('src/services/api/betas.js')

describe('runProviderDoctor — auto mode classifier probe', () => {
  beforeEach(() => {
    __setAutoModeEnabledForTests(true)
  })
  afterEach(() => {
    __setAutoModeEnabledForTests(undefined)
  })

  test('non-Claude model gets a forced tool-choice probe check', async () => {
    state.mainLoopModel = 'gpt-5.4'
    state.activeProvider = profile({
      transport: 'openai_compat',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-5.4',
      apiKey: 'sk-x',
    })
    const out = await runProviderDoctor()
    expect(out).toContain('[OK] Auto mode classifier probe')
    expect(out).toContain('forced tool-choice honored')
  })

  test('failed probe surfaces FAIL with the detail', async () => {
    state.probeOk = false
    state.mainLoopModel = 'gpt-5.4'
    state.activeProvider = profile({
      transport: 'openai_compat',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-5.4',
      apiKey: 'sk-x',
    })
    const out = await runProviderDoctor()
    expect(out).toContain('[FAIL] Auto mode classifier probe')
    expect(out).toContain('no tool_use block')
  })

  test('Claude auto-mode model skips the probe (gated by name)', async () => {
    state.mainLoopModel = 'claude-sonnet-4-6'
    state.activeProvider = profile({
      transport: 'openai_compat',
      baseUrl: 'https://api.example.com/v1',
      model: 'claude-sonnet-4-6',
      apiKey: 'sk-x',
    })
    const out = await runProviderDoctor()
    expect(out).toContain('[OK] Auto mode classifier')
    expect(out).toContain('gated by model name')
    expect(out).not.toContain('Auto mode classifier probe')
  })
})
