import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ResolvedProvider } from '../../services/api/activeProvider.js'

// Capture real modules first so the mock spreads carry every export. Following
// CLAUDE.md mock.module rules — never narrow the namespace shape and restore
// at teardown so the mocks don't bleed into later test files. We snapshot the
// genuine exports into plain objects so the restore in afterAll cannot pick
// up our own overrides through live bindings.
const realActiveProviderNS = { ...(await import('../../services/api/activeProvider.js')) }
const realGeminiAuthNS = { ...(await import('../../utils/geminiAuth.js')) }
const realProviderDiscoveryNS = { ...(await import('../../utils/providerDiscovery.js')) }

const realActiveProvider = { ...realActiveProviderNS }
const realGeminiAuth = { ...realGeminiAuthNS }
const realProviderDiscovery = { ...realProviderDiscoveryNS }

type DoctorMockState = {
  activeProvider: ResolvedProvider | null
  geminiKind: 'api-key' | 'access-token' | 'adc' | 'none'
  ollamaState: 'ready' | 'unreachable' | 'no_models' | 'generation_failed'
}

const state: DoctorMockState = {
  activeProvider: null,
  geminiKind: 'api-key',
  ollamaState: 'ready',
}

mock.module('../../services/api/activeProvider.js', () => ({
  ...realActiveProvider,
  tryGetActiveProvider: () => state.activeProvider,
}))

mock.module('../../utils/geminiAuth.js', () => ({
  ...realGeminiAuth,
  resolveGeminiCredential: async () =>
    state.geminiKind === 'none'
      ? { kind: 'none' as const }
      : state.geminiKind === 'api-key'
        ? { kind: 'api-key' as const, credential: 'k' }
        : { kind: state.geminiKind, credential: 'tok' },
}))

mock.module('../../utils/providerDiscovery.js', () => ({
  ...realProviderDiscovery,
  probeOllamaGenerationReadiness: async () => ({
    state: state.ollamaState,
    models: [],
    probeModel: 'llama3.1:8b',
    detail: state.ollamaState === 'generation_failed' ? 'mock failure' : undefined,
  }),
}))

afterAll(() => {
  mock.module('../../services/api/activeProvider.js', () => realActiveProvider)
  mock.module('../../utils/geminiAuth.js', () => realGeminiAuth)
  mock.module('../../utils/providerDiscovery.js', () => realProviderDiscovery)
})

const { runProviderDoctor } = await import('./doctor.js')

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
    transport: overrides.transport ?? 'openai_compat',
    baseUrl: overrides.baseUrl ?? 'https://api.example.com/v1',
    model: overrides.model ?? 'gpt-5.4',
    apiKey: overrides.apiKey,
    extras: overrides.extras,
  }
}

beforeEach(() => {
  state.activeProvider = null
  state.geminiKind = 'api-key'
  state.ollamaState = 'ready'
  installFetchMock(async () => makeOkResponse())
})

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
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
