import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import axios from 'axios'

const originalEnv = { ...process.env }

async function importFreshModule() {
  return import(`./officialRegistry.ts?ts=${Date.now()}-${Math.random()}`)
}

beforeEach(() => {
  process.env = { ...originalEnv }
})

afterEach(() => {
  process.env = { ...originalEnv }
})

describe('prefetchOfficialMcpUrls', () => {
  test('does not fetch registry when using OpenAI mode', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    mock.module('../../utils/model/providers.js', () => ({
      getAPIProvider: () => 'openai',
    }))
    const getSpy = mock(() => Promise.resolve({ data: { servers: [] } }))
    axios.get = getSpy as typeof axios.get

    const { prefetchOfficialMcpUrls } = await importFreshModule()
    await prefetchOfficialMcpUrls()

    expect(getSpy).not.toHaveBeenCalled()
  })

  test('does not fetch registry when using Gemini mode', async () => {
    process.env.CLAUDE_CODE_USE_GEMINI = '1'
    mock.module('../../utils/model/providers.js', () => ({
      getAPIProvider: () => 'gemini',
    }))
    const getSpy = mock(() => Promise.resolve({ data: { servers: [] } }))
    axios.get = getSpy as typeof axios.get

    const { prefetchOfficialMcpUrls } = await importFreshModule()
    await prefetchOfficialMcpUrls()

    expect(getSpy).not.toHaveBeenCalled()
  })

  test('fetches registry in first-party mode', async () => {
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.CLAUDE_CODE_USE_GITHUB
    // The registry prefetch is nonessential startup traffic, suppressed under
    // Claudin's default essential-traffic privacy level. Opt back in so this
    // test can exercise the actual fetch path.
    process.env.ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC = '0'

    mock.module('../../utils/model/providers.js', () => ({
      getAPIProvider: () => 'firstParty',
    }))
    const getSpy = mock(() =>
      Promise.resolve({
        data: {
          servers: [{ server: { remotes: [{ url: 'https://example.com/mcp' }] } }],
        },
      }),
    )
    axios.get = getSpy as typeof axios.get

    const { prefetchOfficialMcpUrls, isOfficialMcpUrl } = await importFreshModule()
    await prefetchOfficialMcpUrls()

    expect(getSpy).toHaveBeenCalledTimes(1)
    expect(isOfficialMcpUrl('https://example.com/mcp')).toBe(true)
  })
})
