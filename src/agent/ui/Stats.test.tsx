import { afterAll, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'

import type { ClaudeCodeStats } from 'src/platform/stats.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { createRoot } from 'src/terminal/ink.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'

function modelUsage(input: number, output: number, read: number, write: number) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: read,
    cacheCreationInputTokens: write,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  }
}

const FIXTURE: ClaudeCodeStats = {
  totalSessions: 12,
  totalMessages: 340,
  totalDays: 30,
  activeDays: 9,
  streaks: {
    currentStreak: 3,
    longestStreak: 5,
    currentStreakStart: '2026-08-30',
    longestStreakStart: '2026-08-01',
    longestStreakEnd: '2026-08-05',
  },
  dailyActivity: [
    { date: '2026-09-01', messageCount: 40, sessionCount: 2, toolCallCount: 9 },
    { date: '2026-09-02', messageCount: 12, sessionCount: 1, toolCallCount: 3 },
  ],
  dailyModelTokens: [
    { date: '2026-09-01', tokensByModel: { 'model-alpha': 900 } },
    { date: '2026-09-02', tokensByModel: { 'model-beta': 300 } },
  ],
  longestSession: {
    sessionId: 'abc',
    duration: 3_600_000,
    messageCount: 80,
    timestamp: '2026-09-01T10:00:00.000Z',
  },
  modelUsage: {
    'model-alpha': modelUsage(1_000_000, 20_000_000, 4_000_000_000, 150_000_000),
    'model-beta': modelUsage(1_800_000, 18_100_000, 2_900_000_000, 103_600_000),
  },
  firstSessionDate: '2026-08-01',
  lastSessionDate: '2026-09-02',
  peakActivityDay: '2026-09-01',
  peakActivityHour: 14,
  totalSpeculationTimeSavedMs: 0,
}

// Snapshot the reals as plain objects BEFORE mocking (a live `import *`
// namespace re-applies the stub), so afterAll can hand them back.
const realStatsModule = { ...(await import('src/platform/stats.js')) }
const realClipboardModule = {
  ...(await import('src/platform/ide/screenshotClipboard.js')),
}

let copiedText = ''

mock.module('src/platform/stats.js', () => ({
  ...realStatsModule,
  aggregateClaudeCodeStatsForRange: async () => FIXTURE,
}))
mock.module('src/platform/ide/screenshotClipboard.js', () => ({
  ...realClipboardModule,
  copyAnsiToClipboard: async (text: string) => {
    copiedText = text
    return { success: true }
  },
}))

const { OverviewTab, Stats, sumTokenBreakdown } = await import(
  'src/agent/ui/Stats.js'
)

afterAll(() => {
  mock.module('src/platform/stats.js', () => realStatsModule)
  mock.module('src/platform/ide/screenshotClipboard.js', () => realClipboardModule)
})

describe('sumTokenBreakdown', () => {
  test('adds the four counters across every model', () => {
    expect(sumTokenBreakdown(FIXTURE.modelUsage)).toEqual({
      input: 2_800_000,
      output: 38_100_000,
      cacheRead: 6_900_000_000,
      cacheWrite: 253_600_000,
    })
  })

  test('is zero for an empty snapshot', () => {
    expect(sumTokenBreakdown({})).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })
})

describe('OverviewTab', () => {
  test('renders the token breakdown as one contiguous line', async () => {
    const output = await renderToString(
      <OverviewTab
        stats={FIXTURE}
        allTimeStats={FIXTURE}
        dateRange="all"
        isLoading={false}
      />,
      100,
    )

    // Assert on contiguity and order: a bare toContain on each number passes
    // even when the row is split into independently wrapping columns.
    expect(output.replace(/\s+/g, ' ')).toContain(
      'Input 2.8m · Output 38.1m · Cache read 6.9b · Cache write 253.6m',
    )
  })
})

// --- interactive harness (mirrors ProviderManager.test.tsx) -----------------

function createTestStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  getOutput: () => string
} {
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }

  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  return { stdout, stdin, getOutput: () => output }
}

// DEC synchronized update markers: Ink wraps every frame in them, and the
// PassThrough keeps all of them, so a naive substring check sees stale frames.
const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

function lastFrame(output: string): string {
  let frame: string | null = null
  let cursor = 0
  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) break
    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) break
    const candidate = output.slice(contentStart, end)
    if (candidate.trim().length > 0) frame = candidate
    cursor = end + SYNC_END.length
  }
  return stripAnsi(frame ?? output)
}

async function waitFor(
  read: () => string,
  predicate: (value: string) => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (predicate(read())) return
    await Bun.sleep(20)
  }
  throw new Error(`Timed out waiting for ${label}. Last value:\n${read().slice(-1500)}`)
}

// Ink paints a frame from a microtask scheduled in `resetAfterCommit`
// (ink/ink.tsx), but the commit's `useInput` handlers only subscribe to the
// input emitter in a passive effect (ink/hooks/use-input.ts), and
// `App.processInput` emits with no buffering — so a key written the instant a
// frame appears is parsed and dropped when the subtree that would handle it has
// not subscribed yet. Re-send the key until its effect shows instead of
// one-shotting it; the per-press window is wide enough that a press which DID
// land is always observed before the next one (which, with two tabs, would
// switch back).
async function pressUntil(
  write: (sequence: string) => void,
  sequence: string,
  read: () => string,
  predicate: (value: string) => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    write(sequence)
    const settle = Date.now() + 1000
    while (Date.now() < settle) {
      await Bun.sleep(20)
      if (predicate(read())) return
    }
  }
  throw new Error(`Timed out waiting for ${label}. Last value:\n${read().slice(-1500)}`)
}

describe('Stats keyboard handling', () => {
  test('ctrl+s copies the tab that ← switched to, not the one it started on', async () => {
    copiedText = ''
    const { stdout, stdin, getOutput } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <Stats />
        </KeybindingSetup>
      </AppStateProvider>,
    )

    try {
      // Overview is the tab Stats opens on.
      await waitFor(
        () => lastFrame(getOutput()),
        frame => frame.includes('Favorite model'),
        'the Overview tab',
      )

      // ← switches the inner tabs without ever passing through the `tab` key,
      // which is exactly what used to leave activeTab pointing at Overview.
      await pressUntil(
        sequence => stdin.write(sequence),
        '\x1b[D',
        () => lastFrame(getOutput()),
        frame => frame.includes('Tokens per Day'),
        'the Models tab',
      )

      await pressUntil(
        sequence => stdin.write(sequence),
        '\x13', // ctrl+s
        () => copiedText,
        text => text.length > 0,
        'the clipboard write',
      )

      const copied = stripAnsi(copiedText)
      expect(copied).toContain('Total:')
      expect(copied).toContain('In:')
      expect(copied).not.toContain('Longest streak')
      expect(copied).not.toContain('Cache write')
    } finally {
      root.unmount()
    }
  }, 30_000)
})
