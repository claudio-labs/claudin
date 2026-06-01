import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import stripAnsi from 'strip-ansi'

import { AppStateProvider } from '../state/AppState.js'
import { renderToString } from '../utils/staticRender.js'

// MACRO is a build-time replacement; in unit tests there's no bundler, so the
// banner reads from globalThis.MACRO at runtime. Mirror what other tests do.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: 'test-version' }

// detectProvider reads from getActiveProvider(). Spread the real module so
// other consumers' shapes survive Bun's process-global mock; restore in
// afterAll to avoid leaks.
const realActiveProvider = { ...(await import('../services/api/activeProvider.js')) }
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
    const { buildStartupBannerLines } = await import('./StartupScreen.js')
    const lines = buildStartupBannerLines('claude-sonnet-4-6')
    const text = stripAnsi(lines.join('\n'))

    expect(text).toContain('Claudio')
    expect(text).toContain('vtest-version')
    expect(text).toContain('Not configured')
    expect(text).toContain('claude-sonnet-4-6')
  })

  it('uses the em-dash placeholder for the model when nothing is configured', async () => {
    const { buildStartupBannerLines } = await import('./StartupScreen.js')
    const lines = buildStartupBannerLines()
    const text = stripAnsi(lines.join('\n'))

    expect(text).toContain('Not configured')
    expect(text).toContain('—')
    expect(text).not.toContain('api.anthropic.com')
  })

  it('renders the OpenAI provider with model name', async () => {
    resolvedOverride = {
      transport: 'openai_compat',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      apiKey: 'test',
    }

    const { buildStartupBannerLines } = await import('./StartupScreen.js')
    const lines = buildStartupBannerLines()
    const text = stripAnsi(lines.join('\n'))

    expect(text).toContain('OpenAI')
    expect(text).toContain('gpt-4o')
  })

  it('shows reasoning effort as a separate token when set', async () => {
    resolvedOverride = {
      transport: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
      apiKey: 'test',
      extras: { reasoningEffort: 'high' },
    }

    const { buildStartupBannerLines } = await import('./StartupScreen.js')
    const lines = buildStartupBannerLines()
    const text = stripAnsi(lines.join('\n'))

    expect(text).toContain('Anthropic')
    expect(text).toContain('claude-sonnet-4-6')
    expect(text).toContain('● high')
  })

  it('still resolves local providers without crashing', async () => {
    resolvedOverride = {
      transport: 'openai_compat',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3',
    }

    const { buildStartupBannerLines } = await import('./StartupScreen.js')
    const lines = buildStartupBannerLines()
    const text = stripAnsi(lines.join('\n'))

    expect(text).toContain('llama3')
  })

  it('includes the current working directory', async () => {
    const { buildStartupBannerLines } = await import('./StartupScreen.js')
    const lines = buildStartupBannerLines()
    const text = stripAnsi(lines.join('\n'))

    // cwd is rendered as ~/... when under home, or absolute otherwise.
    // Either way, the path string must appear.
    const home = (await import('os')).homedir()
    const cwd = process.cwd()
    const expected = cwd === home || cwd.startsWith(home + '/')
      ? '~' + cwd.slice(home.length)
      : cwd
    expect(text).toContain(expected)
  })

  it('returns a stable line count for snapshot-style assertions', async () => {
    const { buildStartupBannerLines } = await import('./StartupScreen.js')
    const lines = buildStartupBannerLines('claude-sonnet-4-6')
    // Banner shape: 4 logo rows (no leading/trailing blank).
    expect(lines.length).toBe(4)
  })

  it('appends an update-available notice when one is passed', async () => {
    const { buildStartupBannerLines } = await import('./StartupScreen.js')
    const lines = buildStartupBannerLines('claude-sonnet-4-6', {
      latest: '9.9.9',
    })
    const text = stripAnsi(lines.join('\n'))
    expect(text).toContain('▲ New version 9.9.9 available')
    expect(text).toContain('claudio update')
    // Adds exactly one extra line vs. the no-notice case.
    expect(lines.length).toBe(5)
  })

  it('omits the notice line when none is provided', async () => {
    const { buildStartupBannerLines } = await import('./StartupScreen.js')
    const lines = buildStartupBannerLines('claude-sonnet-4-6')
    const text = stripAnsi(lines.join('\n'))
    expect(text).not.toContain('New version')
    expect(text).not.toContain('claudio update')
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
    const output = await renderToString(
      <AppStateProvider>
        <StartupBanner modelOverride="claude-sonnet-4-6" />
      </AppStateProvider>,
      100,
    )

    expect(output).toContain('Claudio')
    expect(output).toContain('Not configured')
    expect(output).toContain('claude-sonnet-4-6')
  })
})
