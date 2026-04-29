import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import stripAnsi from 'strip-ansi'

import { renderToString } from '../utils/staticRender.js'

// MACRO is a build-time replacement; in unit tests there's no bundler, so the
// banner reads from globalThis.MACRO at runtime. Mirror what other tests do.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: 'test-version' }

// detectProvider reads from getActiveProvider(). Spread the real module so
// other consumers' shapes survive Bun's process-global mock; restore in
// afterAll to avoid leaks.
const realActiveProvider = await import('../services/api/activeProvider.js')
const realActiveProviderSnapshot = { ...realActiveProvider }

type ResolvedProvider = ReturnType<typeof realActiveProvider.getActiveProvider> | null

let resolvedOverride: ResolvedProvider = null

mock.module('../services/api/activeProvider.js', () => ({
  ...realActiveProviderSnapshot,
  tryGetActiveProvider: () => resolvedOverride,
}))

afterAll(() => {
  mock.module('../services/api/activeProvider.js', () => realActiveProviderSnapshot)
})

describe('buildStartupBannerLines', () => {
  beforeEach(() => {
    resolvedOverride = null
  })

  afterEach(() => {
    resolvedOverride = null
  })

  it('renders a "Not configured" banner when no provider profile exists', async () => {
    const { buildStartupBannerLines, STARTUP_BANNER_WIDTH } = await import('./StartupScreen.js')
    const lines = buildStartupBannerLines('claude-sonnet-4-6')
    const text = stripAnsi(lines.join('\n'))

    expect(text).toContain('Provider')
    expect(text).toContain('Not configured')
    expect(text).toContain('Model')
    expect(text).toContain('claude-sonnet-4-6')
    expect(text).toContain('Endpoint')
    expect(text).toContain('Ready')
    expect(text).toContain('/help')

    // Box rows must stay exactly STARTUP_BANNER_WIDTH cells wide so the
    // border doesn't break with the placeholder values.
    for (const line of lines) {
      const stripped = stripAnsi(line)
      if (stripped.startsWith('│') && stripped.endsWith('│')) {
        expect(stripped.length).toBe(STARTUP_BANNER_WIDTH)
      }
    }
  })

  it('renders an em-dash placeholder for endpoint and model when nothing is configured', async () => {
    const { buildStartupBannerLines } = await import('./StartupScreen.js')
    const lines = buildStartupBannerLines()
    const text = stripAnsi(lines.join('\n'))

    expect(text).toContain('Not configured')
    expect(text).toContain('—')
    expect(text).not.toContain('api.anthropic.com')
  })

  it('renders the OpenAI provider with a custom endpoint', async () => {
    resolvedOverride = {
      transport: 'openai_compat',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      apiKey: 'test',
    }

    const { buildStartupBannerLines } = await import('./StartupScreen.js')
    const lines = buildStartupBannerLines()
    const text = stripAnsi(lines.join('\n'))

    expect(text).toContain('Provider')
    expect(text).toContain('OpenAI')
    expect(text).toContain('gpt-4o')
    expect(text).toContain('https://api.openai.com/v1')
  })

  it('marks local provider URLs as local (not cloud)', async () => {
    resolvedOverride = {
      transport: 'openai_compat',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3',
    }

    const { buildStartupBannerLines } = await import('./StartupScreen.js')
    const lines = buildStartupBannerLines()
    const text = stripAnsi(lines.join('\n'))

    expect(text).toContain('llama3')
    // The status row swaps "cloud" → "local" when isLocalProviderUrl matches.
    expect(text).toContain('local')
    expect(text).not.toContain('cloud  ')
  })

  it('returns a stable line count for snapshot-style assertions', async () => {
    const { buildStartupBannerLines } = await import('./StartupScreen.js')
    const lines = buildStartupBannerLines('claude-sonnet-4-6')
    // Banner shape (1 + 13 logo block + 1 + 1 tagline + 1 + 1 top + 3 info
    // rows + 1 separator + 1 status row + 1 bottom + 1 version + 1 trailer
    // = 26 lines). Hard-coded so visual changes require an explicit test
    // update.
    expect(lines.length).toBe(26)
  })
})

describe('<StartupBanner />', () => {
  beforeEach(() => {
    resolvedOverride = null
  })

  afterEach(() => {
    resolvedOverride = null
  })

  it('renders the banner content when mounted in the Ink tree', async () => {
    const { StartupBanner } = await import('./StartupBanner.js')
    const output = await renderToString(<StartupBanner modelOverride="claude-sonnet-4-6" />, 100)

    expect(output).toContain('Provider')
    expect(output).toContain('Not configured')
    expect(output).toContain('claude-sonnet-4-6')
    expect(output).toContain('Ready')
  })
})
