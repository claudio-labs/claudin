import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

// Control the value getOpenAIContextWindow reads from the provider's /models
// discovery, keeping every other export real. afterAll puts the real module
// back: a getter left answering undefined hides every window discovery
// records for the rest of the run (context.test.ts read 128k for a 262k one).
const realDiscovery = { ...(await import('src/providers/model/openaiModelDiscovery.ts')) }
let mockDiscovered: number | undefined
mock.module('./openaiModelDiscovery.js', () => ({
  ...realDiscovery,
  getDiscoveredContextWindow: (_model: string) => mockDiscovered,
}))

afterAll(() => {
  mock.module('./openaiModelDiscovery.js', () => realDiscovery)
})

// Imported after the mock is registered. getOpenAIContextWindow only requires
// the discovery module lazily, so the mock is in place before the first call.
import {
  getOpenAIContextWindow,
  getOpenAIMaxOutputTokens,
} from 'src/providers/model/openaiContextWindows.ts'
import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import {
  _setCopilotCatalogForTesting,
  getCatalogCopilotContextWindow,
} from 'src/providers/model/copilotModelCatalog.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'

const COPILOT: ProviderProfile = {
  id: 'windows-copilot',
  name: 'Copilot',
  provider: 'openai',
  baseUrl: 'https://api.githubcopilot.com',
  model: 'gpt-5.6-sol',
  extras: { githubToken: 'gh-windows' },
}

describe('getOpenAIContextWindow — the live Copilot catalog', () => {
  afterEach(() => {
    _setCopilotCatalogForTesting(null)
    resetGlobalConfigForTests()
    invalidateActiveProviderCache()
  })

  // gpt-5.6-sol is 1.05M in the bare table (the OpenAI API's window). The
  // account's catalog is what Copilot actually serves, and it is smaller.
  test('wins over the bare table for the model Copilot serves', () => {
    saveGlobalConfig(current => ({
      ...current,
      providerProfiles: [COPILOT],
      activeProviderProfileId: COPILOT.id,
    }))
    invalidateActiveProviderCache()
    _setCopilotCatalogForTesting([
      {
        model: {
          id: 'gpt-5.6-sol',
          name: 'GPT-5.6 Sol',
          family: 'gpt',
          attachment: false,
          reasoning: true,
          tool_call: true,
          temperature: false,
          knowledge: '',
          release_date: '',
          last_updated: '',
          modalities: { input: ['text'], output: ['text'] },
          open_weights: false,
          cost: { input: 0, output: 0 },
          limit: { context: 400_000, output: 64_000 },
        },
        supportedEndpoints: ['/responses'],
        pickerEnabled: true,
      },
    ])
    mockDiscovered = undefined
    // Precondition: the seeded catalog answers for this profile.
    expect(getCatalogCopilotContextWindow('gpt-5.6-sol')).toBe(400_000)
    expect(getOpenAIContextWindow('gpt-5.6-sol')).toBe(400_000)
    expect(getOpenAIMaxOutputTokens('gpt-5.6-sol')).toBe(64_000)
  })

  test('answers nothing once Copilot is not the active provider', () => {
    // No Copilot profile: the bare table, as before.
    mockDiscovered = undefined
    expect(getOpenAIContextWindow('gpt-5.6-sol')).toBe(1_050_000)
    expect(getOpenAIMaxOutputTokens('gpt-5.6-sol')).toBe(128_000)
  })
})

describe('getOpenAIContextWindow — discovery precedence', () => {
  test('prefers the provider-reported window over the hardcoded table', () => {
    // gpt-4o is 128k in the hardcoded table. A router serving a truncated
    // 32k variant under the same id must win via its own /models report.
    mockDiscovered = 32_000
    expect(getOpenAIContextWindow('gpt-4o')).toBe(32_000)
  })

  test('falls back to the hardcoded table when the provider reports nothing', () => {
    mockDiscovered = undefined
    // gpt-4o's curated 128k entry still resolves (regression guard for the
    // real-OpenAI case, whose /models endpoint omits context_length).
    expect(getOpenAIContextWindow('gpt-4o')).toBe(128_000)
  })
})

describe('getOpenAIContextWindow — an explicit CLAUDIN_OPENAI_CONTEXT_WINDOWS pin', () => {
  // The pin is read once at module load, so a fresh instance is loaded after
  // the variable is set; the query string makes Bun evaluate the module anew.
  async function loadWithPin(pin: Record<string, number>): Promise<typeof getOpenAIContextWindow> {
    const saved = process.env.CLAUDIN_OPENAI_CONTEXT_WINDOWS
    process.env.CLAUDIN_OPENAI_CONTEXT_WINDOWS = JSON.stringify(pin)
    try {
      const specifier = `./openaiContextWindows.ts?pin=${Object.keys(pin).join(',')}`
      const fresh = (await import(specifier)) as { getOpenAIContextWindow: typeof getOpenAIContextWindow }
      return fresh.getOpenAIContextWindow
    } finally {
      if (saved === undefined) delete process.env.CLAUDIN_OPENAI_CONTEXT_WINDOWS
      else process.env.CLAUDIN_OPENAI_CONTEXT_WINDOWS = saved
    }
  }

  test('wins over the hardcoded table when the provider reports nothing', async () => {
    const lookup = await loadWithPin({ 'gpt-4o': 999_999 })
    mockDiscovered = undefined
    expect(lookup('gpt-4o')).toBe(999_999)
  })

  test('wins over the window the provider reports', async () => {
    const lookup = await loadWithPin({ 'gpt-4o': 999_999 })
    mockDiscovered = 32_000
    expect(lookup('gpt-4o')).toBe(999_999)
    mockDiscovered = undefined
  })
})
