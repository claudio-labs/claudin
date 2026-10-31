/**
 * Characterization of the <SessionTokensIndicator> row as it renders today,
 * before the Ollama footer work changes it.
 *
 * The sibling `SessionTokensIndicator.test.ts` stubs Ink and the trackers to
 * pin the pure formatters; this file drives the REAL trackers
 * (`addToTotalCostState`, `recordRequest`), the real active-provider resolver
 * (a profile saved into the in-memory global config) and the real renderer.
 * Nerd Font detection is forced through `CLAUDIN_NERD_FONT`, which
 * `hasNerdFontGlyphs` reads before any terminal heuristic.
 *
 * The 2 s poll is driven by hand: `setInterval` is spied so the indicator's
 * callback (the only 2000 ms interval) is captured and fired synchronously,
 * which is how `snapshotEqual` and the reset-to-zero branch are reached
 * without waiting on a real timer.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as React from 'react'

import { createAssistantMessage } from 'src/agent/messages/factories.js'
import { addToTotalCostState, resetCostState } from 'src/platform/bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import type { ProviderProfile } from 'src/platform/config/config.js'
import { recordRequest, resetSessionCacheStats } from 'src/providers/cache/cacheStatsTracker.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { lastFrame, mountHook, waitForCondition } from 'src/providers/ui/__testutils__/inkHookHarness.js'
import { readSnapshot, SessionTokensIndicator } from 'src/providers/ui/SessionTokensIndicator.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { Box, Text } from 'src/terminal/ink.js'
import { AppStateProvider, getDefaultAppState } from 'src/terminal/state/AppState.js'
import type { Message } from 'src/shared/types/message.js'

const MODEL = 'claude-opus-4-7'

const ANTHROPIC: ProviderProfile = {
  id: 'sti-anthropic',
  name: 'Anthropic',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: MODEL,
}

// Ollama's default port: its own cache bucket, ahead of the private-URL
// check, because Ollama reports its KV cache in cached_tokens.
const OLLAMA: ProviderProfile = {
  id: 'sti-ollama',
  name: 'Ollama',
  provider: 'openai',
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen3:8b',
}

let savedProfiles: ReturnType<typeof getGlobalConfig>['providerProfiles']
let savedActiveProfileId: string | undefined
const savedNerdFont = process.env.CLAUDIN_NERD_FONT

function useProfile(profile: ProviderProfile | null): void {
  saveGlobalConfig(c => ({
    ...c,
    providerProfiles: profile ? [profile] : [],
    activeProviderProfileId: profile?.id,
  }))
  invalidateActiveProviderCache()
}

function setNerdFont(on: boolean): void {
  process.env.CLAUDIN_NERD_FONT = on ? '1' : '0'
}

function spend(input: number, output: number, cost = 0): void {
  addToTotalCostState(
    cost,
    {
      inputTokens: input,
      outputTokens: output,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: cost,
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
    },
    MODEL,
  )
}

function cache(read: number, created: number): void {
  const total = read + created
  recordRequest({ read, created, total, hitRate: total > 0 ? read / total : null, supported: true }, MODEL)
}

/** An assistant message carrying real (non-synthetic) usage, as the loop stores it. */
function assistantWithUsage(input: number, output: number, cacheRead: number, cacheCreation: number): Message {
  const msg = createAssistantMessage({
    content: 'ok',
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreation,
    } as never,
  })
  msg.message.model = MODEL
  return msg as Message
}

function withAppState(node: React.ReactNode): React.ReactNode {
  return <AppStateProvider initialState={{ ...getDefaultAppState(), mainLoopModel: MODEL }}>{node}</AppStateProvider>
}

async function renderRow(messages?: Message[]): Promise<string> {
  const out = await renderToString(withAppState(<SessionTokensIndicator messages={messages} />), 120)
  return out.replace(/\s+/g, ' ').trim()
}

function resetTrackers(): void {
  resetCostState()
  resetSessionCacheStats()
}

beforeAll(() => {
  const global = getGlobalConfig()
  savedProfiles = global.providerProfiles
  savedActiveProfileId = global.activeProviderProfileId
})

beforeEach(() => {
  resetTrackers()
})

afterEach(() => {
  resetTrackers()
  if (savedNerdFont === undefined) delete process.env.CLAUDIN_NERD_FONT
  else process.env.CLAUDIN_NERD_FONT = savedNerdFont
})

afterAll(() => {
  saveGlobalConfig(c => ({
    ...c,
    providerProfiles: savedProfiles,
    activeProviderProfileId: savedActiveProfileId,
  }))
  invalidateActiveProviderCache()
})

describe('<SessionTokensIndicator> — provider with cache metrics (Anthropic)', () => {
  beforeEach(() => useProfile(ANTHROPIC))

  test('Nerd Font: cache groups take the write/read icons', async () => {
    setNerdFont(true)
    spend(500, 200)
    cache(116_000, 63_800)
    expect(await renderRow()).toBe('\u{F163E} 64k · \u{F163B} 116k')
  })

  test('no Nerd Font: cache groups fall back to wrt:/rd:', async () => {
    setNerdFont(false)
    spend(500, 200)
    cache(116_000, 63_800)
    expect(await renderRow()).toBe('wrt: 64k · rd: 116k')
  })

  test('a zero cache counter is omitted, not shown as a placeholder', async () => {
    setNerdFont(false)
    spend(500, 200)
    cache(0, 4_000)
    expect(await renderRow()).toBe('wrt: 4k')
  })

  test('cost is appended after a divider when above zero', async () => {
    setNerdFont(false)
    spend(500, 200, 0.42)
    cache(116_000, 63_800)
    expect(await renderRow()).toBe('wrt: 64k · rd: 116k · $0.4200')
  })

  test('context gauge + unlabelled context size when messages carry usage (Nerd Font)', async () => {
    setNerdFont(true)
    spend(500, 200)
    cache(90_000, 9_000)
    // 1k + 99k + 0 output = 100k of the 200k opus-4-7 window → half circle.
    const row = await renderRow([assistantWithUsage(1_000, 0, 90_000, 9_000)])
    expect(row).toBe('\u{F0AA1} 100k · \u{F163E} 9k · \u{F163B} 90k')
  })

  test('context gauge fills to 7/8 past 80% of the window', async () => {
    setNerdFont(true)
    spend(500, 200)
    cache(160_000, 9_000)
    const row = await renderRow([assistantWithUsage(1_000, 0, 160_000, 9_000)])
    expect(row.startsWith('\u{F0AA4} 170k · ')).toBe(true)
  })

  test('no gauge without a Nerd Font, but the context size is still shown', async () => {
    setNerdFont(false)
    spend(500, 200)
    cache(90_000, 9_000)
    const row = await renderRow([assistantWithUsage(1_000, 0, 90_000, 9_000)])
    expect(row).toBe('100k · wrt: 9k · rd: 90k')
  })

  test('messages with no real usage leave the context group out', async () => {
    setNerdFont(true)
    spend(500, 200)
    cache(90_000, 9_000)
    const synthetic = createAssistantMessage({ content: 'no usage' }) as Message
    expect(await renderRow([synthetic])).toBe('\u{F163E} 9k · \u{F163B} 90k')
  })
})

describe('<SessionTokensIndicator> — Ollama: its KV cache in the Anthropic layout', () => {
  beforeEach(() => useProfile(OLLAMA))

  test('readSnapshot reports supportsCache=true through the real resolver', () => {
    expect(readSnapshot().supportsCache).toBe(true)
  })

  test('the prefill is the write icon, the reused prefix the read icon', async () => {
    setNerdFont(true)
    spend(0, 800)
    cache(21_000, 1_300)
    expect(await renderRow()).toBe('\u{F163E} 1k · \u{F163B} 21k')
  })

  test('with the context gauge, the row reads like the Anthropic one', async () => {
    setNerdFont(true)
    spend(0, 800)
    cache(21_000, 1_300)
    const row = await renderRow([assistantWithUsage(0, 0, 21_000, 1_300)])
    expect(row.endsWith('22k · \u{F163E} 1k · \u{F163B} 21k')).toBe(true)
  })

  test('the row shows whatever cost the tracker holds (modelCost makes a local endpoint free)', async () => {
    setNerdFont(false)
    spend(0, 800)
    cache(21_000, 1_300)
    expect(await renderRow()).toBe('wrt: 1k · rd: 21k')
  })
})

describe('<SessionTokensIndicator> — empty session', () => {
  test('an all-zero snapshot renders nothing, cache layout or not', async () => {
    setNerdFont(true)
    useProfile(ANTHROPIC)
    expect(await renderRow()).toBe('')
    // The no-cache layout would print `in: 0 · out: 0` if the row rendered.
    // (Not Ollama: it reports its KV cache and has the cache layout now.)
    useProfile(null)
    expect(await renderRow()).toBe('')
  })

  test('no active profile at all: the no-cache layout', async () => {
    useProfile(null)
    setNerdFont(false)
    spend(10, 5)
    expect(await renderRow()).toBe('in: 10 · out: 5')
  })

  test('no cache data under a Nerd Font: arrows instead of in:/out:', async () => {
    useProfile(null)
    setNerdFont(true)
    spend(11_000, 800)
    expect(await renderRow()).toBe('\u{F0737} 11k · \u{F072E} 800')
  })
})

describe('<SessionTokensIndicator> — the 2 s poll (snapshotEqual)', () => {
  const POLL_MS = 2000

  test('an unchanged poll keeps the frame; a changed one repaints; a reset to zero unmounts the row', async () => {
    useProfile(ANTHROPIC)
    setNerdFont(false)
    spend(500, 200)
    cache(10_000, 2_000)

    const realSetInterval = globalThis.setInterval
    const polls: Array<() => void> = []
    const spy = spyOn(globalThis, 'setInterval').mockImplementation(((
      handler: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (ms === POLL_MS) {
        polls.push(handler)
        return realSetInterval(() => {}, 1 << 30)
      }
      return realSetInterval(handler, ms, ...rest)
    }) as typeof setInterval)

    // Brackets around the row keep a frame non-empty when the row renders
    // null (Ink writes no frame for an empty screen), and the Profiler counts
    // commits, which is how an equal poll (no re-render) is told apart.
    let commits = 0
    const mounted = await mountHook(
      withAppState(
        <React.Profiler id="sti" onRender={() => { commits++ }}>
          <Box flexDirection="column">
            <Text>[</Text>
            <SessionTokensIndicator />
            <Text>]</Text>
          </Box>
        </React.Profiler>,
      ),
    )
    try {
      const frame = () => lastFrame(mounted.streams.getOutput()).replace(/\s+/g, ' ').trim()
      await waitForCondition(() => frame() === '[ wrt: 2k · rd: 10k ]', { label: 'first frame' })
      expect(polls).toHaveLength(1)
      const poll = polls[0]!

      // Same totals: snapshotEqual hands back the previous snapshot → no commit.
      await Bun.sleep(20)
      const settled = commits
      poll()
      await Bun.sleep(50)
      expect(commits).toBe(settled)
      expect(frame()).toBe('[ wrt: 2k · rd: 10k ]')

      // New totals: the poll swaps in the fresh snapshot.
      cache(30_000, 0)
      poll()
      await waitForCondition(() => frame() === '[ wrt: 2k · rd: 40k ]', { label: 'repaint after poll' })
      expect(commits).toBeGreaterThan(settled)

      // Session reset: the last non-zero snapshot is dropped, the row renders null.
      resetTrackers()
      poll()
      await waitForCondition(() => frame() === '[ ]', { label: 'row cleared after reset' })
    } finally {
      await mounted.cleanup()
      spy.mockRestore()
    }
  })
})
