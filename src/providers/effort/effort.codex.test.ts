import { afterAll, afterEach, expect, mock, test } from 'bun:test'

const realProviders = { ...(await import('src/providers/model/providers.js')) }
const realModelSupportOverrides = { ...(await import('src/providers/model/modelSupportOverrides.js')) }
const realProviderConfig = { ...(await import('src/providers/presets/providerConfig.js')) }
const realActiveProvider = { ...(await import('src/providers/presets/activeProvider.js')) }

afterAll(() => {
  mock.module('src/providers/model/providers.js', () => realProviders)
  mock.module('src/providers/model/modelSupportOverrides.js', () => realModelSupportOverrides)
  mock.module('src/providers/presets/providerConfig.js', () => realProviderConfig)
  mock.module('src/providers/presets/activeProvider.js', () => realActiveProvider)
})

async function importFreshEffortModule(options: {
  provider: 'codex' | 'openai'
  supportsCodexReasoningEffort: boolean
}) {
  mock.module('src/providers/model/providers.js', () => ({
    getAPIProvider: () => options.provider,
    // The effort gate asks whether the request leaves through the OpenAI shim
    // before consulting the reasoning catalog; both providers under test do.
    activeTransportUsesOpenAiShim: () => true,
  }))
  mock.module('src/providers/model/modelSupportOverrides.js', () => ({
    get3PModelCapabilityOverride: () => undefined,
  }))
  mock.module('src/providers/presets/providerConfig.js', () => ({
    supportsCodexReasoningEffort: () => options.supportsCodexReasoningEffort,
    isOpenAICodexShortcut: () => false,
  }))
  // No profile: the catalog has no endpoint to key on, so these cases land on
  // the GPT-5 family fallback — which is the scenario they describe. Pinning it
  // also keeps the run off whatever provider the developer has configured.
  mock.module('src/providers/presets/activeProvider.js', () => ({
    tryGetActiveProvider: () => undefined,
  }))

  return import(`./effort.js?ts=${Date.now()}-${Math.random()}`)
}

test('gpt-5.4 on the ChatGPT Codex backend supports effort selection', async () => {
  const { getAvailableEffortLevels, modelSupportsEffort } =
    await importFreshEffortModule({
      provider: 'codex',
      supportsCodexReasoningEffort: true,
    })

  expect(modelSupportsEffort('gpt-5.4')).toBe(true)
  expect(getAvailableEffortLevels('gpt-5.4')).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
  ])
})

test('gpt-5.4 on the OpenAI provider still supports effort selection', async () => {
  const { getAvailableEffortLevels, modelSupportsEffort } =
    await importFreshEffortModule({
      provider: 'openai',
      supportsCodexReasoningEffort: true,
    })

  expect(modelSupportsEffort('gpt-5.4')).toBe(true)
  expect(getAvailableEffortLevels('gpt-5.4')).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
  ])
})

test('gpt-5.3-codex-spark stays without effort controls', async () => {
  const { getAvailableEffortLevels, modelSupportsEffort } =
    await importFreshEffortModule({
      provider: 'codex',
      supportsCodexReasoningEffort: false,
    })

  expect(modelSupportsEffort('gpt-5.3-codex-spark')).toBe(false)
  expect(getAvailableEffortLevels('gpt-5.3-codex-spark')).toEqual([])
})
