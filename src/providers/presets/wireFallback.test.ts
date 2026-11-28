// Two requests of one host and model in flight before the first answer: the
// endpoint rejects the new wire for both, and both are answered over chat.
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { resetGlobalConfigForTests, saveGlobalConfig, type ProviderProfile } from 'src/platform/config/config.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { _resetWireFallbackForTesting } from 'src/providers/presets/wireFallback.js'
import { getAnthropicClient } from 'src/providers/transport/client.js'

const g = globalThis as Record<string, unknown>
const savedMacro = g.MACRO
g.MACRO = { VERSION: '99.0.0', DISPLAY_VERSION: '0.0.0-test' }
const originalFetch = globalThis.fetch

const CHAT_BODY = {
  id: 'c1',
  object: 'chat.completion',
  model: 'x',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi from chat' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

function stubFetch(rejectPath: string): string[] {
  const seen: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    seen.push(url)
    if (url.includes(rejectPath)) {
      await new Promise(resolve => setTimeout(resolve, 50))
      return new Response(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(CHAT_BODY), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return seen
}

function useProfile(profile: ProviderProfile): void {
  saveGlobalConfig(current => ({ ...current, providerProfiles: [profile], activeProviderProfileId: profile.id }))
  invalidateActiveProviderCache()
}

beforeEach(() => {
  resetGlobalConfigForTests()
  _resetWireFallbackForTesting()
})
afterEach(() => {
  globalThis.fetch = originalFetch
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
  _resetWireFallbackForTesting()
})
afterAll(() => {
  g.MACRO = savedMacro
})

async function twoAtOnce(model: string): Promise<PromiseSettledResult<unknown>[]> {
  const client = await getAnthropicClient({ maxRetries: 0, model })
  const call = () =>
    client.beta.messages.create({
      model,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    } as never)
  return Promise.allSettled([call(), call()])
}

test('vendor wire: both concurrent first requests fall back to chat', async () => {
  useProfile({ id: 'mm', name: 'MiniMax', provider: 'openai', baseUrl: 'https://api.minimax.io/v1', model: 'MiniMax-M3', apiKey: 'k' })
  stubFetch('/anthropic/')
  const results = await twoAtOnce('MiniMax-M3')
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
})

test('responses wire: both concurrent first requests fall back to chat', async () => {
  useProfile({ id: 'oa', name: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5', apiKey: 'k' })
  stubFetch('/responses')
  const results = await twoAtOnce('gpt-5.5')
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
})
