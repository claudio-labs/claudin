import { PassThrough } from 'node:stream'

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import stripAnsi from 'strip-ansi'

import { createRoot } from '../ink.js'
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

// Anthropic-transport effort is driven by the /effort slider setting
// (getInitialEffortSetting), not provider.extras — see #61. Override it here
// so the "effort token" test can exercise a non-default level deterministically.
const realEffort = { ...(await import('../utils/effort.js')) }
const realEffortSnapshot = { ...realEffort }
let effortOverride: ReturnType<typeof realEffort.getInitialEffortSetting> | undefined

mock.module('../services/api/activeProvider.js', () => ({
  ...realActiveProviderSnapshot,
  tryGetActiveProvider: () => resolvedOverride,
}))

mock.module('../utils/effort.js', () => ({
  ...realEffortSnapshot,
  getInitialEffortSetting: () =>
    effortOverride ?? realEffortSnapshot.getInitialEffortSetting(),
}))

afterAll(() => {
  mock.module('../services/api/activeProvider.js', () => realActiveProviderSnapshot)
  mock.module('../utils/effort.js', () => realEffortSnapshot)
  mock.module('src/utils/effort.js', () => realEffortSnapshot)
})

describe('buildStartupBannerLines', () => {
  beforeEach(() => {
    resolvedOverride = null
    effortOverride = undefined
  })

  afterEach(() => {
    resolvedOverride = null
    effortOverride = undefined
  })

  it('renders a "Not configured" banner when no provider profile exists', async () => {
    const { buildStartupBannerLines } = await import('./StartupScreen.js')
    const lines = buildStartupBannerLines('claude-sonnet-4-6')
    const text = stripAnsi(lines.join('\n'))

    expect(text).toContain('Claudin')
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
    // Anthropic effort is sourced from the /effort slider, not provider.extras.
    effortOverride = 'high'

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
    expect(text).toContain('▲ New version available (v9.9.9)')
    expect(text).toContain('claudin update')
    // Adds exactly one extra line vs. the no-notice case.
    expect(lines.length).toBe(5)
  })

  it('wraps only (vX.Y.Z) in green; the rest of the notice is DIM', async () => {
    const { buildStartupBannerLines } = await import('./StartupScreen.js')
    const lines = buildStartupBannerLines('claude-sonnet-4-6', {
      latest: '9.9.9',
    })
    const noticeLine = lines[4]
    expect(noticeLine).toBeDefined()
    // GREEN = ESC[32m wraps "(v9.9.9)" exactly, terminated by RESET.
    expect(noticeLine).toMatch(/\x1b\[32m\(v9\.9\.9\)\x1b\[0m/)
    // Lead-in and trailing copy stay DIM (ESC[2m) so the version pops.
    expect(noticeLine).toMatch(/\x1b\[2m▲ New version available /)
    expect(noticeLine).toMatch(/\x1b\[2m, please run: claudin update\x1b\[0m/)
  })

  it('omits the notice line when none is provided', async () => {
    const { buildStartupBannerLines } = await import('./StartupScreen.js')
    const lines = buildStartupBannerLines('claude-sonnet-4-6')
    const text = stripAnsi(lines.join('\n'))
    expect(text).not.toContain('New version')
    expect(text).not.toContain('claudin update')
  })
})

describe('<StartupBanner />', () => {
  beforeEach(() => {
    resolvedOverride = null
    effortOverride = undefined
  })

  afterEach(() => {
    resolvedOverride = null
    effortOverride = undefined
  })

  it('renders the banner content when mounted in the Ink tree', async () => {
    const { StartupBanner } = await import('./StartupBanner.js')
    const output = await renderToString(
      <AppStateProvider>
        <StartupBanner modelOverride="claude-sonnet-4-6" />
      </AppStateProvider>,
      100,
    )

    expect(output).toContain('Claudin')
    expect(output).toContain('Not configured')
    expect(output).toContain('claude-sonnet-4-6')
  })

  it('calls subscribeLatestVersion on mount (kills "delete useEffect" mutation)', async () => {
    // Spy on the boundary: mock the cache module so we can observe that
    // mounting the banner actually subscribes. If a future refactor
    // deletes the useEffect or the import, subscribeCalls stays 0 and
    // this test fails — unlike a string-equality "contract" check.
    const realCache = { ...(await import('../utils/latestVersionCache.js')) }
    let subscribeCalls = 0
    let unsubscribeCalls = 0
    mock.module('../utils/latestVersionCache.js', () => ({
      ...realCache,
      subscribeLatestVersion: (_listener: unknown) => {
        subscribeCalls += 1
        return () => {
          unsubscribeCalls += 1
        }
      },
    }))
    try {
      const { StartupBanner } = await import('./StartupBanner.js')
      await renderToString(
        <AppStateProvider>
          <StartupBanner modelOverride="claude-sonnet-4-6" />
        </AppStateProvider>,
        100,
      )
      expect(subscribeCalls).toBeGreaterThanOrEqual(1)
      // renderToString is single-shot — cleanup may or may not fire here.
      // The mount-time subscribe is the proof of wiring; unmount cleanup
      // is asserted at the pub/sub layer (latestVersionCache.test.ts).
      expect(unsubscribeCalls).toBeGreaterThanOrEqual(0)
    } finally {
      // Restore by re-asserting the real shape. mock.restore() would also
      // dispose the activeProvider top-level mock (registered outside any
      // describe block) and break sibling tests in this file.
      mock.module('../utils/latestVersionCache.js', () => realCache)
    }
  })

  it('subscriber callback updates the rendered notice on the SAME mounted instance (kills "callback is a no-op" mutation)', async () => {
    // Real test for D2: fire the subscriber callback against a persistent
    // React root and assert the next frame contains the new notice. The
    // previous renderToString-based version re-mounted on the second call,
    // so the useState initializer alone (which calls resolveUpdateNotice
    // again on the fresh mount) passed the assertion even when the
    // subscribe-listener body was deleted. Persistent root → mount once →
    // captured() → wait for re-render → assert.
    const realCache = { ...(await import('../utils/latestVersionCache.js')) }
    const realScreen = { ...(await import('./StartupScreen.js')) }
    let captured: (() => void) | null = null
    let resolveReturn: { latest: string } | undefined
    mock.module('../utils/latestVersionCache.js', () => ({
      ...realCache,
      subscribeLatestVersion: (listener: () => void) => {
        captured = listener
        return () => {}
      },
    }))
    mock.module('./StartupScreen.js', () => ({
      ...realScreen,
      resolveUpdateNotice: () => resolveReturn,
    }))

    // Stream + frame helpers mirror MigrationBanner.test.tsx's pattern.
    const SYNC_START = '\x1B[?2026h'
    const SYNC_END = '\x1B[?2026l'
    const extractLastFrame = (output: string): string => {
      let lastFrame: string | null = null
      let cursor = 0
      while (cursor < output.length) {
        const start = output.indexOf(SYNC_START, cursor)
        if (start === -1) break
        const contentStart = start + SYNC_START.length
        const end = output.indexOf(SYNC_END, contentStart)
        if (end === -1) break
        const frame = output.slice(contentStart, end)
        if (frame.trim().length > 0) lastFrame = frame
        cursor = end + SYNC_END.length
      }
      return lastFrame ?? output
    }
    const waitForFrame = async (
      getOutput: () => string,
      predicate: (frame: string) => boolean,
      timeoutMs = 2000,
    ): Promise<string> => {
      const startedAt = Date.now()
      while (Date.now() - startedAt < timeoutMs) {
        const frame = stripAnsi(extractLastFrame(getOutput()))
        if (predicate(frame)) return frame
        await Bun.sleep(10)
      }
      throw new Error(
        `Timed out waiting for predicate; last output:\n${stripAnsi(extractLastFrame(getOutput()))}`,
      )
    }

    let output = ''
    const stdout = new PassThrough()
    ;(stdout as unknown as { columns: number }).columns = 100
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const getOutput = () => output

    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })

    try {
      const { StartupBanner } = await import('./StartupBanner.js')

      // Initial state: no notice.
      resolveReturn = undefined
      root.render(
        <AppStateProvider>
          <StartupBanner modelOverride="claude-sonnet-4-6" />
        </AppStateProvider>,
      )
      const before = await waitForFrame(getOutput, frame =>
        frame.includes('Claudin'),
      )
      expect(before).not.toContain('New version available')
      expect(captured).not.toBeNull()

      // Flip the resolver and fire the captured callback. The component
      // is still mounted on the same root, so this exercises exactly:
      // listener → setNotice(resolveUpdateNotice()) → React re-render.
      // If the callback body is deleted (D2 mutation), notice never
      // appears and waitForFrame times out.
      resolveReturn = { latest: '9.9.9' }
      captured!()
      const after = await waitForFrame(getOutput, frame =>
        frame.includes('New version available'),
      )
      expect(after).toContain('9.9.9')
    } finally {
      root.unmount()
      stdout.end()
      await Bun.sleep(0)
      mock.module('../utils/latestVersionCache.js', () => realCache)
      mock.module('./StartupScreen.js', () => realScreen)
    }
  })

})
