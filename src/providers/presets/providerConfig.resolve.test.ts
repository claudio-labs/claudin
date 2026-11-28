/**
 * resolveProviderRequest and the helpers around it, driven through the real
 * active-provider resolver: under `bun test` the global config lives in
 * memory, so a profile written with saveGlobalConfig is the one
 * tryGetActiveProvider resolves. No module is mocked.
 *
 * The Codex credential cases stay on the paths that never reach secure
 * storage: an explicit env, an explicit auth.json, or bare mode
 * (CLAUDIN_SIMPLE), under which readCodexCredentials() answers undefined.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getGlobalConfig,
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import { CODEX_DEFAULT_MODEL } from 'src/providers/model/codexModelCatalog.js'
import {
  invalidateActiveProviderCache,
  tryGetActiveProvider,
} from 'src/providers/presets/activeProvider.js'
import {
  DEFAULT_CODEX_BASE_URL,
  DEFAULT_GITHUB_MODELS_API_MODEL,
  DEFAULT_OPENAI_BASE_URL,
  GITHUB_COPILOT_BASE_URL,
  getAdditionalModelOptionsCacheScope,
  getCodexAliasModel,
  getGithubEndpointType,
  getLocalProviderRetryBaseUrls,
  getReasoningEffortForModel,
  isCodexAlias,
  isCodexBaseUrl,
  isDirectOpenAIProvider,
  isLocalProviderUrl,
  isOpenAICodexShortcut,
  normalizeGithubCopilotModel,
  resolveCodexApiCredentials,
  resolveCodexAuthPath,
  resolveProviderRequest,
  resolveRuntimeCodexCredentials,
  resolveStoredCodexCredentials,
  shouldAttemptLocalToollessRetry,
  shouldUseCodexTransport,
  transportSendsStrictToolSchemas,
} from 'src/providers/presets/providerConfig.js'

const DEFAULT_AUTH_PATH = join(homedir(), '.codex', 'auth.json')

let savedProfiles: ProviderProfile[] | undefined
let savedActiveId: string | undefined
let savedSimple: string | undefined

beforeAll(() => {
  const config = getGlobalConfig()
  savedProfiles = config.providerProfiles
  savedActiveId = config.activeProviderProfileId
  savedSimple = process.env.CLAUDIN_SIMPLE
  clearProfile()
})

function clearProfile(): void {
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [],
    activeProviderProfileId: undefined,
  }))
  invalidateActiveProviderCache()
}

afterEach(() => {
  clearProfile()
  if (savedSimple === undefined) delete process.env.CLAUDIN_SIMPLE
  else process.env.CLAUDIN_SIMPLE = savedSimple
})

afterAll(() => {
  resetGlobalConfigForTests()
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: savedProfiles ?? [],
    activeProviderProfileId: savedActiveId,
  }))
  invalidateActiveProviderCache()
})

function useProfile(overrides: Partial<ProviderProfile>): void {
  const profile: ProviderProfile = {
    id: 'resolve-test',
    name: 'Resolve test',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    ...overrides,
  }
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [profile],
    activeProviderProfileId: profile.id,
  }))
  invalidateActiveProviderCache()
}

function useCopilot(model: string, baseUrl = 'https://api.githubcopilot.com'): void {
  useProfile({ baseUrl, model, extras: { githubToken: 'gh-test' } })
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

function accountJwt(accountId: string): string {
  return makeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })
}

function withAuthJson<T>(content: string, run: (authPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'claudin-provider-config-auth-'))
  const authPath = join(dir, 'auth.json')
  writeFileSync(authPath, content, 'utf8')
  try {
    return run(authPath)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}

describe('the harness drives the real resolver', () => {
  test('a saved profile is the active provider, and clearing it leaves none', () => {
    useProfile({ model: 'gpt-4.1' })
    expect(tryGetActiveProvider()?.model).toBe('gpt-4.1')
    clearProfile()
    expect(tryGetActiveProvider()).toBeNull()
  })
})

describe('resolveProviderRequest — no profile', () => {
  test('defaults to gpt-4o on the OpenAI base URL over chat completions', () => {
    expect(resolveProviderRequest()).toEqual({
      transport: 'chat_completions',
      requestedModel: 'gpt-4o',
      resolvedModel: 'gpt-4o',
      baseUrl: DEFAULT_OPENAI_BASE_URL,
      reasoning: undefined,
    })
  })

  test('uses the fallback model when neither the caller nor a profile names one', () => {
    expect(resolveProviderRequest({ fallbackModel: '  gpt-4.1 ' }).requestedModel).toBe('gpt-4.1')
  })

  test('an explicit model wins over the fallback model', () => {
    expect(
      resolveProviderRequest({ model: 'gpt-4o-mini', fallbackModel: 'gpt-4.1' }).requestedModel,
    ).toBe('gpt-4o-mini')
  })

  test('a codexplan shortcut with no base URL goes to the Codex backend', () => {
    const r = resolveProviderRequest({ model: 'codexplan' })
    expect(r.transport).toBe('codex_responses')
    expect(r.baseUrl).toBe(DEFAULT_CODEX_BASE_URL)
    expect(r.resolvedModel).toBe(CODEX_DEFAULT_MODEL)
    expect(r.reasoning).toEqual({ effort: 'medium' })
  })

  test('a codexplan shortcut with the default OpenAI URL still counts as unset', () => {
    const r = resolveProviderRequest({ model: 'codexspark', baseUrl: DEFAULT_OPENAI_BASE_URL })
    expect(r.transport).toBe('codex_responses')
    expect(r.baseUrl).toBe(DEFAULT_CODEX_BASE_URL)
    expect(r.resolvedModel).toBe('gpt-5.3-codex-spark')
    expect(r.reasoning).toBeUndefined()
  })

  test('a codex shortcut with a user-set base URL keeps that URL and the chat transport', () => {
    const r = resolveProviderRequest({ model: 'codexplan', baseUrl: 'https://proxy.example/v1' })
    expect(r.transport).toBe('chat_completions')
    expect(r.baseUrl).toBe('https://proxy.example/v1')
  })

  test('an explicit Codex base URL selects the Codex transport for any model', () => {
    const r = resolveProviderRequest({ model: 'some-model', baseUrl: `${DEFAULT_CODEX_BASE_URL}/` })
    expect(r.transport).toBe('codex_responses')
    expect(r.baseUrl).toBe(DEFAULT_CODEX_BASE_URL)
  })

  test('trailing slashes are trimmed from the base URL', () => {
    expect(resolveProviderRequest({ baseUrl: 'https://example.com/v1///' }).baseUrl).toBe(
      'https://example.com/v1',
    )
  })

  test('a literal "undefined" base URL (Windows shells) counts as unset', () => {
    expect(resolveProviderRequest({ baseUrl: 'undefined' }).baseUrl).toBe(DEFAULT_OPENAI_BASE_URL)
    expect(resolveProviderRequest({ baseUrl: '   ' }).baseUrl).toBe(DEFAULT_OPENAI_BASE_URL)
  })
})

describe('resolveProviderRequest — reasoning effort', () => {
  test('a Codex alias carries its default effort', () => {
    expect(resolveProviderRequest({ model: 'gpt-5.4', baseUrl: 'https://x.example/v1' }).reasoning)
      .toEqual({ effort: 'high' })
  })

  test('a ?reasoning= suffix overrides the alias default and is stripped from the model', () => {
    const r = resolveProviderRequest({ model: 'gpt-5.4?reasoning=LOW', baseUrl: 'https://x.example/v1' })
    expect(r.reasoning).toEqual({ effort: 'low' })
    expect(r.resolvedModel).toBe('gpt-5.4')
    expect(r.requestedModel).toBe('gpt-5.4?reasoning=LOW')
  })

  test('an unknown ?reasoning= value falls back to the alias default', () => {
    const r = resolveProviderRequest({ model: 'gpt-5.6?reasoning=turbo', baseUrl: 'https://x.example/v1' })
    expect(r.resolvedModel).toBe('gpt-5.6-sol')
    expect(r.reasoning).toEqual({ effort: 'high' })
  })

  test('a non-alias model with a ?reasoning= suffix keeps its own name', () => {
    const r = resolveProviderRequest({ model: 'my-model ?reasoning=max', baseUrl: 'https://x.example/v1' })
    expect(r.resolvedModel).toBe('my-model')
    expect(r.reasoning).toEqual({ effort: 'max' })
  })

  test('a non-alias model with an empty query has no effort', () => {
    expect(resolveProviderRequest({ model: 'my-model?', baseUrl: 'https://x.example/v1' }).reasoning)
      .toBeUndefined()
  })

  test('the caller override beats the descriptor', () => {
    expect(
      resolveProviderRequest({
        model: 'gpt-5.4?reasoning=low',
        baseUrl: 'https://x.example/v1',
        reasoningEffortOverride: 'xhigh',
      }).reasoning,
    ).toEqual({ effort: 'xhigh' })
  })

  test('the profile extras answer when the model carries no effort', () => {
    useProfile({ model: 'gpt-4.1', extras: { reasoningEffort: 'low' } })
    expect(resolveProviderRequest().reasoning).toEqual({ effort: 'low' })
  })

  test('the descriptor beats the profile extras', () => {
    useProfile({ model: 'gpt-5.4', extras: { reasoningEffort: 'low' } })
    expect(resolveProviderRequest().reasoning).toEqual({ effort: 'high' })
  })
})

describe('resolveProviderRequest — OpenAI-compatible profile', () => {
  test('a GPT-5 alias on api.openai.com takes the Responses API, not the Codex path', () => {
    useProfile({ model: 'gpt-5.4' })
    expect(resolveProviderRequest()).toMatchObject({
      transport: 'openai_responses',
      resolvedModel: 'gpt-5.4',
      baseUrl: DEFAULT_OPENAI_BASE_URL,
    })
  })

  test('the caller model wins over the profile model', () => {
    useProfile({ model: 'gpt-4.1' })
    expect(resolveProviderRequest({ model: 'gpt-4o-mini' }).requestedModel).toBe('gpt-4o-mini')
  })

  test('the caller base URL wins over the profile base URL', () => {
    useProfile({ baseUrl: 'https://profile.example/v1' })
    expect(resolveProviderRequest({ baseUrl: 'https://caller.example/v1' }).baseUrl).toBe(
      'https://caller.example/v1',
    )
  })

  test('a codexplan profile on the default OpenAI URL goes to the Codex backend', () => {
    useProfile({ model: 'codexplan' })
    expect(tryGetActiveProvider()?.transport).toBe('codex_responses')
    expect(resolveProviderRequest()).toMatchObject({
      transport: 'codex_responses',
      baseUrl: DEFAULT_CODEX_BASE_URL,
      resolvedModel: CODEX_DEFAULT_MODEL,
    })
  })

  test('the model a codexplan profile resolves to keeps the Codex route when passed back in', () => {
    useProfile({ model: 'codexplan' })
    expect(resolveProviderRequest({ model: CODEX_DEFAULT_MODEL })).toMatchObject({
      transport: 'codex_responses',
      baseUrl: DEFAULT_CODEX_BASE_URL,
    })
  })

  test('a different model on a codexplan profile does not inherit the Codex base URL', () => {
    useProfile({ model: 'codexplan' })
    const r = resolveProviderRequest({ model: 'gpt-4.1' })
    expect(r.transport).toBe('chat_completions')
    expect(r.baseUrl).toBe(DEFAULT_OPENAI_BASE_URL)
  })

  test('a profile on the Codex base URL is Codex whatever the model is called', () => {
    useProfile({ baseUrl: DEFAULT_CODEX_BASE_URL, model: 'gpt-5.6-terra' })
    expect(resolveProviderRequest()).toMatchObject({
      transport: 'codex_responses',
      baseUrl: DEFAULT_CODEX_BASE_URL,
      resolvedModel: 'gpt-5.6-terra',
    })
  })
})

describe('resolveProviderRequest — GitHub profile', () => {
  test.each([
    ['gpt-5', 'codex_responses'],
    ['gpt-5.5', 'codex_responses'],
    ['gpt-6-luna', 'codex_responses'],
    ['gpt-10', 'codex_responses'],
    ['my-codex-preview', 'codex_responses'],
    ['gpt-5-mini', 'chat_completions'],
    ['gpt-5-mini-2026-01-01', 'chat_completions'],
    ['gpt-4.1', 'chat_completions'],
    ['claude-sonnet-4.6', 'chat_completions'],
    ['o3', 'chat_completions'],
  ] as const)('Copilot endpoint: %s → %s', (model, transport) => {
    useCopilot(model)
    expect(resolveProviderRequest().transport).toBe(transport)
  })

  test('the Copilot endpoint strips the github: and vendor prefixes', () => {
    useCopilot('github:openai/gpt-4.1')
    expect(resolveProviderRequest().resolvedModel).toBe('gpt-4.1')
  })

  test('the bare copilot alias resolves to the default Copilot model', () => {
    useCopilot('copilot')
    expect(resolveProviderRequest().resolvedModel).toBe(DEFAULT_GITHUB_MODELS_API_MODEL)
  })

  test('a plan-scoped Copilot endpoint keeps its own URL on the Responses route', () => {
    useCopilot('gpt-5.5', 'https://api.business.githubcopilot.com/')
    expect(resolveProviderRequest()).toMatchObject({
      transport: 'codex_responses',
      baseUrl: 'https://api.business.githubcopilot.com',
    })
  })

  test('the GitHub Models endpoint keeps the vendor prefix and never uses Responses', () => {
    useCopilot('github:openai/gpt-5', 'https://models.github.ai/inference')
    expect(resolveProviderRequest()).toMatchObject({
      transport: 'chat_completions',
      resolvedModel: 'openai/gpt-5',
      baseUrl: 'https://models.github.ai/inference',
    })
  })

  test('a custom GitHub endpoint keeps a non-alias model on that endpoint', () => {
    useCopilot('github:gpt-5', 'https://ghe-proxy.example/v1')
    expect(resolveProviderRequest()).toMatchObject({
      transport: 'chat_completions',
      resolvedModel: 'gpt-5',
      baseUrl: 'https://ghe-proxy.example/v1',
    })
  })

  test('a Codex alias on a custom GitHub endpoint is sent to the Copilot API instead', () => {
    useCopilot('gpt-5.4', 'https://ghe-proxy.example/v1')
    expect(resolveProviderRequest()).toMatchObject({
      transport: 'codex_responses',
      resolvedModel: 'gpt-5.4',
      baseUrl: GITHUB_COPILOT_BASE_URL,
    })
  })

  test('an explicit caller base URL is never dropped for a Codex alias', () => {
    useCopilot('gpt-5.4', 'https://ghe-proxy.example/v1')
    expect(resolveProviderRequest({ baseUrl: 'https://caller.example/v1' }).baseUrl).toBe(
      'https://caller.example/v1',
    )
  })

  test('a codexplan model on GitHub does not jump to the Codex backend', () => {
    useCopilot('codexplan')
    const r = resolveProviderRequest()
    expect(r.baseUrl).toBe(GITHUB_COPILOT_BASE_URL)
    expect(r.resolvedModel).toBe(CODEX_DEFAULT_MODEL)
  })
})

describe('shouldUseCodexTransport', () => {
  test('a Codex base URL wins, with or without a trailing slash', () => {
    expect(shouldUseCodexTransport('gpt-4o', DEFAULT_CODEX_BASE_URL)).toBe(true)
    expect(shouldUseCodexTransport('gpt-4o', `${DEFAULT_CODEX_BASE_URL}//`)).toBe(true)
  })

  test('a Codex alias needs the base URL to be unset', () => {
    expect(shouldUseCodexTransport('gpt-5.4', undefined)).toBe(true)
    expect(shouldUseCodexTransport('GPT-5.4?reasoning=low', '')).toBe(true)
    expect(shouldUseCodexTransport('gpt-5.4', 'undefined')).toBe(true)
    expect(shouldUseCodexTransport('gpt-5.4', DEFAULT_OPENAI_BASE_URL)).toBe(false)
  })

  test('a non-alias model without a Codex URL does not', () => {
    expect(shouldUseCodexTransport('gpt-4o', undefined)).toBe(false)
  })
})

describe('isCodexBaseUrl', () => {
  test.each([
    ['https://chatgpt.com/backend-api/codex', true],
    ['https://chatgpt.com/backend-api/codex/', true],
    ['https://chatgpt.com/backend-api', false],
    ['https://chatgpt.com/backend-api/codex/responses', false],
    ['https://evil.chatgpt.com/backend-api/codex', false],
    ['not a url', false],
    [undefined, false],
  ] as const)('%s → %s', (url, expected) => {
    expect(isCodexBaseUrl(url)).toBe(expected)
  })
})

describe('transportSendsStrictToolSchemas', () => {
  test('a plain OpenAI-compatible chat profile does not', () => {
    useProfile({ model: 'gpt-4.1' })
    expect(transportSendsStrictToolSchemas()).toBe(false)
  })

  test('a Codex profile does', () => {
    useProfile({ baseUrl: DEFAULT_CODEX_BASE_URL, model: 'gpt-5.5' })
    expect(transportSendsStrictToolSchemas()).toBe(true)
  })

  test('the model passed in decides, not the profile primary', () => {
    useProfile({ model: 'codexplan' })
    expect(transportSendsStrictToolSchemas()).toBe(true)
    expect(transportSendsStrictToolSchemas('gpt-4.1')).toBe(false)
  })

  test('every GitHub profile does, even on a chat-routed model (400 fallback)', () => {
    useCopilot('gpt-4.1', 'https://models.github.ai/inference')
    expect(resolveProviderRequest().transport).toBe('chat_completions')
    expect(transportSendsStrictToolSchemas()).toBe(true)
  })

  test('GPT-5 on api.openai.com rides the Responses API with strict tools', () => {
    useProfile({ model: 'gpt-5.5' })
    expect(resolveProviderRequest().transport).toBe('openai_responses')
    expect(transportSendsStrictToolSchemas()).toBe(true)
  })
})

describe('getAdditionalModelOptionsCacheScope', () => {
  test('no profile is first party', () => {
    expect(getAdditionalModelOptionsCacheScope()).toBe('firstParty')
  })

  test('an Anthropic profile is first party', () => {
    useProfile({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' })
    expect(getAdditionalModelOptionsCacheScope()).toBe('firstParty')
  })

  test.each([
    ['gemini', 'https://generativelanguage.googleapis.com/v1beta', 'gemini-3-flash-preview'],
    ['mistral', 'https://api.mistral.ai/v1', 'devstral-latest'],
    ['bedrock', 'https://bedrock-runtime.us-east-1.amazonaws.com', 'claude-opus-5-5'],
  ] as const)('a %s profile has no scope', (provider, baseUrl, model) => {
    useProfile({ provider, baseUrl, model })
    expect(getAdditionalModelOptionsCacheScope()).toBeNull()
  })

  test('a GitHub profile has no scope', () => {
    useCopilot('gpt-4.1')
    expect(getAdditionalModelOptionsCacheScope()).toBeNull()
  })

  test('a Codex profile on the Responses route has no scope', () => {
    useProfile({ baseUrl: DEFAULT_CODEX_BASE_URL, model: 'gpt-5.5' })
    expect(getAdditionalModelOptionsCacheScope()).toBeNull()
  })

  test('a Codex-shortcut profile on a custom URL is scoped by that URL', () => {
    useProfile({ baseUrl: 'https://proxy.example/v1', model: 'codexplan' })
    expect(tryGetActiveProvider()?.transport).toBe('codex_responses')
    expect(getAdditionalModelOptionsCacheScope()).toBe('openai:https://proxy.example/v1')
  })

  test('the scope is the lowercased base URL without a trailing slash', () => {
    useProfile({ baseUrl: 'https://API.Example.com/V1/', model: 'gpt-4.1' })
    expect(getAdditionalModelOptionsCacheScope()).toBe('openai:https://api.example.com/v1')
  })

  test('GPT-5 on api.openai.com keeps the scope of its base URL on the Responses API', () => {
    useProfile({ model: 'gpt-5.5' })
    expect(getAdditionalModelOptionsCacheScope()).toBe('openai:https://api.openai.com/v1')
  })
})

describe('isDirectOpenAIProvider', () => {
  test('no profile resolves to the default OpenAI URL', () => {
    expect(isDirectOpenAIProvider()).toBe(true)
  })

  test('a GPT-5 profile on api.openai.com is direct, on the Responses API too', () => {
    useProfile({ model: 'gpt-5.5' })
    expect(isDirectOpenAIProvider()).toBe(true)
  })

  test.each([
    ['https://api.openai.com/v1', true],
    ['https://API.OPENAI.COM/v1', true],
    ['https://api.openai.com.evil.example/v1', false],
    ['https://evil.example/api.openai.com/v1', false],
    ['https://openrouter.ai/api/v1', false],
    ['not-a-url', false],
  ] as const)('profile on %s → %s', (baseUrl, expected) => {
    useProfile({ baseUrl, model: 'gpt-4.1' })
    expect(isDirectOpenAIProvider()).toBe(expected)
  })

  test('a Codex profile is not the direct OpenAI API', () => {
    useProfile({ model: 'codexplan' })
    expect(isDirectOpenAIProvider()).toBe(false)
  })
})

describe('isLocalProviderUrl — edges', () => {
  test.each([
    ['http://172.15.0.1:8000/v1', false],
    ['http://172.32.0.1:8000/v1', false],
    ['http://172.31.255.1:8000/v1', true],
    ['http://192.169.0.1:8000/v1', false],
    ['http://LOCALHOST:8000/v1', true],
    ['http://[fc00::1]:8000/v1', true],
    ['http://[fec0::1]:8000/v1', false],
    ['not a url', false],
    ['', false],
    [undefined, false],
  ] as const)('%s → %s', (url, expected) => {
    expect(isLocalProviderUrl(url)).toBe(expected)
  })
})

describe('getLocalProviderRetryBaseUrls — edges', () => {
  test('a localhost URL already on /v1 only adds the loopback IP once', () => {
    expect(getLocalProviderRetryBaseUrls('http://localhost:11434/v1')).toEqual([
      'http://127.0.0.1:11434/v1',
    ])
  })

  test('a sub-path gains /v1 and the query string is dropped', () => {
    expect(getLocalProviderRetryBaseUrls('http://127.0.0.1:1234/api/?x=1')).toEqual([
      'http://127.0.0.1:1234/api/v1',
    ])
  })

  test('a /V1 suffix in any case counts as already versioned', () => {
    expect(getLocalProviderRetryBaseUrls('http://10.0.0.5:8000/V1')).toEqual([])
  })

  test('an IPv6 loopback falls back to 127.0.0.1', () => {
    expect(getLocalProviderRetryBaseUrls('http://[::1]:8000/v1')).toEqual(['http://127.0.0.1:8000/v1'])
  })
})

describe('shouldAttemptLocalToollessRetry — edges', () => {
  test('a remote Ollama-looking host is not retried', () => {
    expect(
      shouldAttemptLocalToollessRetry({ baseUrl: 'https://ollama.example.com/v1', hasTools: true }),
    ).toBe(false)
  })

  test('a local host is Ollama by name or path as well as by port', () => {
    expect(
      shouldAttemptLocalToollessRetry({ baseUrl: 'http://ollama.local:8080/v1', hasTools: true }),
    ).toBe(true)
    expect(
      shouldAttemptLocalToollessRetry({ baseUrl: 'http://localhost:8080/ollama/v1', hasTools: true }),
    ).toBe(true)
  })
})

describe('GitHub model normalization', () => {
  test.each([
    ['github:copilot', DEFAULT_GITHUB_MODELS_API_MODEL],
    ['github:', DEFAULT_GITHUB_MODELS_API_MODEL],
    ['COPILOT', DEFAULT_GITHUB_MODELS_API_MODEL],
    ['github:openai/gpt-4.1', 'gpt-4.1'],
    ['anthropic/claude-sonnet-4.6?reasoning=high', 'claude-sonnet-4.6'],
    ['gpt-4o', 'gpt-4o'],
  ] as const)('normalizeGithubCopilotModel(%s) → %s', (input, expected) => {
    expect(normalizeGithubCopilotModel(input)).toBe(expected)
  })

  test('an unparseable endpoint counts as Copilot, a missing one too', () => {
    expect(getGithubEndpointType('not a url')).toBe('copilot')
    expect(getGithubEndpointType(undefined)).toBe('copilot')
    expect(getGithubEndpointType('https://eu.github.ai/inference')).toBe('models')
  })
})

describe('Codex alias helpers', () => {
  test('isOpenAICodexShortcut only names codexplan and codexspark', () => {
    expect(isOpenAICodexShortcut('codexplan')).toBe(true)
    expect(isOpenAICodexShortcut(' CodexSpark?reasoning=high ')).toBe(true)
    expect(isOpenAICodexShortcut('gpt-5.4')).toBe(false)
  })

  test('isCodexAlias reads the id under case and a query', () => {
    expect(isCodexAlias(' GPT-5.6-Luna?reasoning=low ')).toBe(true)
    expect(isCodexAlias('gpt-4o')).toBe(false)
  })

  test('getCodexAliasModel resolves an alias and passes anything else through verbatim', () => {
    expect(getCodexAliasModel('codexplan')).toBe(CODEX_DEFAULT_MODEL)
    expect(getCodexAliasModel('GPT-5.6?reasoning=low')).toBe('gpt-5.6-sol')
    expect(getCodexAliasModel('My-Model')).toBe('My-Model')
  })

  test('getReasoningEffortForModel answers the alias default only', () => {
    expect(getReasoningEffortForModel('gpt-5.4-mini')).toBe('medium')
    expect(getReasoningEffortForModel('gpt-5.3-codex-spark')).toBeUndefined()
    expect(getReasoningEffortForModel('gpt-4o')).toBeUndefined()
  })
})

describe('resolveCodexAuthPath', () => {
  test('the profile path wins over both envs', () => {
    expect(
      resolveCodexAuthPath(
        { CODEX_AUTH_JSON_PATH: '/env/auth.json', CODEX_HOME: '/codex-home' } as NodeJS.ProcessEnv,
        { extras: { codexAuthPath: ' /profile/auth.json ' } },
      ),
    ).toBe('/profile/auth.json')
  })

  test('CODEX_AUTH_JSON_PATH wins over CODEX_HOME', () => {
    expect(
      resolveCodexAuthPath({ CODEX_AUTH_JSON_PATH: '/env/auth.json', CODEX_HOME: '/codex-home' } as NodeJS.ProcessEnv, {}),
    ).toBe('/env/auth.json')
  })

  test('CODEX_HOME points at its auth.json', () => {
    expect(resolveCodexAuthPath({ CODEX_HOME: '/codex-home' } as NodeJS.ProcessEnv, {})).toBe(
      join('/codex-home', 'auth.json'),
    )
  })

  test('blank envs fall through to ~/.codex/auth.json', () => {
    expect(resolveCodexAuthPath({ CODEX_AUTH_JSON_PATH: '  ', CODEX_HOME: '' } as NodeJS.ProcessEnv, {})).toBe(
      DEFAULT_AUTH_PATH,
    )
  })

  test('without a profile argument the active profile answers', () => {
    useProfile({ baseUrl: DEFAULT_CODEX_BASE_URL, model: 'gpt-5.5', extras: { codexAuthPath: '/active/auth.json' } })
    expect(resolveCodexAuthPath({} as NodeJS.ProcessEnv)).toBe('/active/auth.json')
  })

  test('a named profile is read instead of the active one', () => {
    useProfile({ baseUrl: DEFAULT_CODEX_BASE_URL, model: 'gpt-5.5', extras: { codexAuthPath: '/active/auth.json' } })
    expect(resolveCodexAuthPath({ CODEX_HOME: '/codex-home' } as NodeJS.ProcessEnv, {})).toBe(
      join('/codex-home', 'auth.json'),
    )
  })
})

describe('resolveCodexApiCredentials — env and explicit auth.json', () => {
  test('CODEX_API_KEY is used, with the account id from CODEX_ACCOUNT_ID', () => {
    expect(
      resolveCodexApiCredentials(
        { CODEX_API_KEY: ' env-key ', CODEX_ACCOUNT_ID: 'acct_codex', CHATGPT_ACCOUNT_ID: 'acct_chatgpt' } as NodeJS.ProcessEnv,
        {},
      ),
    ).toEqual({ apiKey: 'env-key', accountId: 'acct_codex', source: 'env' })
  })

  test('the profile account id beats every env account id', () => {
    const r = resolveCodexApiCredentials(
      { CODEX_API_KEY: 'env-key', CODEX_ACCOUNT_ID: 'acct_codex' } as NodeJS.ProcessEnv,
      { extras: { codexAccountId: 'acct_profile' } },
    )
    expect(r.accountId).toBe('acct_profile')
  })

  test('CHATGPT_ACCOUNT_ID is the last env account id', () => {
    const r = resolveCodexApiCredentials(
      { CODEX_API_KEY: 'env-key', CHATGPT_ACCOUNT_ID: 'acct_chatgpt' } as NodeJS.ProcessEnv,
      {},
    )
    expect(r.accountId).toBe('acct_chatgpt')
  })

  test('an opaque CODEX_API_KEY with no account id leaves it unset', () => {
    expect(resolveCodexApiCredentials({ CODEX_API_KEY: 'opaque' } as NodeJS.ProcessEnv, {}).accountId)
      .toBeUndefined()
  })

  test('reads a nested tokens.access_token and tokens.account_id', () => {
    withAuthJson(
      JSON.stringify({ tokens: { access_token: 'nested-token', account_id: 'acct_nested' } }),
      authPath => {
        expect(resolveCodexApiCredentials({ CODEX_AUTH_JSON_PATH: authPath } as NodeJS.ProcessEnv, {})).toEqual({
          apiKey: 'nested-token',
          accountId: 'acct_nested',
          authPath,
          source: 'auth.json',
        })
      },
    )
  })

  test('skips non-string and non-object entries to find the next candidate', () => {
    withAuthJson(
      JSON.stringify({ access_token: 42, tokens: 'flat', auth: { accessToken: '  auth-token  ' } }),
      authPath => {
        const r = resolveCodexApiCredentials({ CODEX_AUTH_JSON_PATH: authPath } as NodeJS.ProcessEnv, {})
        expect(r.apiKey).toBe('auth-token')
        expect(r.source).toBe('auth.json')
      },
    )
  })

  test('the account id falls back to the access token JWT, then the id token JWT', () => {
    withAuthJson(JSON.stringify({ accessToken: accountJwt('acct_from_access') }), authPath => {
      expect(resolveCodexApiCredentials({ CODEX_AUTH_JSON_PATH: authPath } as NodeJS.ProcessEnv, {}).accountId)
        .toBe('acct_from_access')
    })
    withAuthJson(
      JSON.stringify({ access_token: 'opaque', tokens: { id_token: accountJwt('acct_from_id') } }),
      authPath => {
        expect(resolveCodexApiCredentials({ CODEX_AUTH_JSON_PATH: authPath } as NodeJS.ProcessEnv, {}).accountId)
          .toBe('acct_from_id')
      },
    )
  })

  test('an id token alone is never used as the bearer credential', () => {
    withAuthJson(JSON.stringify({ id_token: accountJwt('acct_id_only') }), authPath => {
      expect(resolveCodexApiCredentials({ CODEX_AUTH_JSON_PATH: authPath } as NodeJS.ProcessEnv, {})).toEqual({
        apiKey: '',
        accountId: 'acct_id_only',
        authPath,
        source: 'none',
      })
    })
  })

  test.each([
    ['malformed JSON', '{not json'],
    ['a JSON null', 'null'],
    ['a JSON string', '"token"'],
  ])('%s in auth.json yields no credentials but keeps the path', (_label, content) => {
    withAuthJson(content, authPath => {
      expect(resolveCodexApiCredentials({ CODEX_AUTH_JSON_PATH: authPath } as NodeJS.ProcessEnv, {})).toEqual({
        apiKey: '',
        authPath,
        source: 'none',
      })
    })
  })

  test('the active profile auth path is honoured when no profile is named', () => {
    withAuthJson(JSON.stringify({ openai_api_key: 'profile-file-key' }), authPath => {
      useProfile({ baseUrl: DEFAULT_CODEX_BASE_URL, model: 'gpt-5.5', extras: { codexAuthPath: authPath } })
      const r = resolveCodexApiCredentials({} as NodeJS.ProcessEnv)
      expect(r.apiKey).toBe('profile-file-key')
      expect(r.authPath).toBe(authPath)
    })
  })

  test('bare mode with no explicit source falls to the default auth.json, never secure storage', () => {
    process.env.CLAUDIN_SIMPLE = '1'
    const r = resolveCodexApiCredentials({} as NodeJS.ProcessEnv, {})
    expect(r.authPath).toBe(DEFAULT_AUTH_PATH)
    expect(r.source).not.toBe('secure-storage')
  })
})

describe('resolveStoredCodexCredentials', () => {
  test('prefers the stored API key over the access token', () => {
    expect(
      resolveStoredCodexCredentials({
        storedCredentials: { apiKey: 'stored-key', accessToken: 'stored-access', accountId: 'acct_stored' },
      }),
    ).toEqual({ apiKey: 'stored-key', accountId: 'acct_stored', source: 'secure-storage' })
  })

  test('the env account id beats the stored one', () => {
    expect(
      resolveStoredCodexCredentials({
        storedCredentials: { accessToken: 'stored-access', accountId: 'acct_stored' },
        envAccountId: 'acct_env',
      }).accountId,
    ).toBe('acct_env')
  })

  test('the account id falls back to the id token, then the access token', () => {
    expect(
      resolveStoredCodexCredentials({
        storedCredentials: { accessToken: accountJwt('acct_access'), idToken: accountJwt('acct_id') },
      }).accountId,
    ).toBe('acct_id')
    expect(
      resolveStoredCodexCredentials({ storedCredentials: { accessToken: accountJwt('acct_access') } }).accountId,
    ).toBe('acct_access')
  })
})

describe('resolveRuntimeCodexCredentials', () => {
  test('CODEX_API_KEY beats stored credentials', () => {
    expect(
      resolveRuntimeCodexCredentials({
        env: { CODEX_API_KEY: 'env-key' } as NodeJS.ProcessEnv,
        storedCredentials: { accessToken: 'stored-access' },
        profile: {},
      }),
    ).toMatchObject({ apiKey: 'env-key', source: 'env' })
  })

  test('stored credentials take the profile account id first', () => {
    expect(
      resolveRuntimeCodexCredentials({
        env: { CODEX_ACCOUNT_ID: 'acct_env' } as NodeJS.ProcessEnv,
        storedCredentials: { accessToken: 'stored-access', accountId: 'acct_stored' },
        profile: { extras: { codexAccountId: 'acct_profile' } },
      }),
    ).toEqual({ apiKey: 'stored-access', accountId: 'acct_profile', source: 'secure-storage' })
  })

  test('stored credentials take an env account id over the stored one', () => {
    expect(
      resolveRuntimeCodexCredentials({
        env: { CHATGPT_ACCOUNT_ID: 'acct_chatgpt' } as NodeJS.ProcessEnv,
        storedCredentials: { accessToken: 'stored-access', accountId: 'acct_stored' },
        profile: {},
      }).accountId,
    ).toBe('acct_chatgpt')
  })

  test('a profile auth path is explicit and beats stored credentials', () => {
    withAuthJson(JSON.stringify({ openai_api_key: 'profile-file-key' }), authPath => {
      expect(
        resolveRuntimeCodexCredentials({
          env: {} as NodeJS.ProcessEnv,
          storedCredentials: { accessToken: 'stored-access' },
          profile: { extras: { codexAuthPath: authPath } },
        }),
      ).toMatchObject({ apiKey: 'profile-file-key', source: 'auth.json', authPath })
    })
  })

  test('CODEX_HOME counts as an explicit path even when its auth.json is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claudin-provider-config-home-'))
    try {
      expect(
        resolveRuntimeCodexCredentials({
          env: { CODEX_HOME: dir } as NodeJS.ProcessEnv,
          storedCredentials: { accessToken: 'stored-access' },
          profile: {},
        }),
      ).toEqual({ apiKey: '', authPath: join(dir, 'auth.json'), source: 'none' })
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test('an explicitly empty stored credential falls to the default auth.json, not secure storage', () => {
    const r = resolveRuntimeCodexCredentials({
      env: {} as NodeJS.ProcessEnv,
      storedCredentials: undefined,
      profile: {},
    })
    expect(r.authPath).toBe(DEFAULT_AUTH_PATH)
    expect(r.source).not.toBe('secure-storage')
  })

  test('without a stored-credentials option it resolves like resolveCodexApiCredentials', () => {
    process.env.CLAUDIN_SIMPLE = '1'
    const r = resolveRuntimeCodexCredentials({ env: {} as NodeJS.ProcessEnv, profile: {} })
    expect(r.authPath).toBe(DEFAULT_AUTH_PATH)
    expect(r.source).not.toBe('secure-storage')
  })
})
