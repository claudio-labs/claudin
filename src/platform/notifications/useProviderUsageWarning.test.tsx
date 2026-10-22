import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as React from 'react'
import { useReducer } from 'react'

import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { useProviderUsageWarning } from 'src/platform/notifications/useProviderUsageWarning.js'
import { currentLimits, emitStatusChange, type ClaudeAILimits } from 'src/providers/claudeAiLimits.js'
import { recordCodexLimits, resetCodexLimitsForTesting } from 'src/providers/codexLimits.js'
import { useLiveLimits } from 'src/providers/liveLimitsHook.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import {
  lastFrame,
  mountHook,
  waitForCondition,
} from 'src/providers/ui/__testutils__/inkHookHarness.js'
import type { CodexUsageData } from 'src/providers/usage/codexUsage.js'
import { Text } from 'src/terminal/ink.js'
import { AppStateProvider, useAppState } from 'src/terminal/state/AppState.js'

const CODEX_PROFILE = {
  id: 'p-codex',
  name: 'Codex OAuth',
  provider: 'openai' as const,
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  model: 'codexplan',
}
const ANTHROPIC_PROFILE = {
  id: 'p-anthropic',
  name: 'Anthropic',
  provider: 'anthropic' as const,
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
}

function codex(primary: number): CodexUsageData {
  return {
    snapshots: [
      {
        limitName: 'codex',
        primary: {
          usedPercent: primary,
          windowMinutes: 300,
          resetsAt: new Date(Date.now() + 72 * 60_000).toISOString(),
        },
      },
    ],
  }
}

let rerender: () => void = () => {}

/** Shows the toast on screen and the footer's standing line under it. */
function Host(): React.ReactNode {
  const [, force] = useReducer((x: number) => x + 1, 0)
  rerender = force
  useProviderUsageWarning()
  const { standing } = useLiveLimits()
  const current = useAppState(s => s.notifications.current)
  return (
    <>
      {current && 'jsx' in current ? current.jsx : <Text>{current?.text ?? 'no toast'}</Text>}
      <Text>{`standing: ${standing ?? 'none'}`}</Text>
      <Text>{`toast key: ${current?.key ?? 'none'}`}</Text>
    </>
  )
}

let savedProfiles: ReturnType<typeof getGlobalConfig>['providerProfiles']
let savedActiveId: string | undefined
const savedClaudeLimits: ClaudeAILimits = { ...currentLimits }

function activate(id: string): void {
  saveGlobalConfig(c => ({ ...c, activeProviderProfileId: id }))
  invalidateActiveProviderCache()
}

beforeAll(() => {
  const config = getGlobalConfig()
  savedProfiles = config.providerProfiles
  savedActiveId = config.activeProviderProfileId
  saveGlobalConfig(c => ({ ...c, providerProfiles: [CODEX_PROFILE, ANTHROPIC_PROFILE] }))
  activate('p-codex')
})

afterEach(() => {
  resetCodexLimitsForTesting()
  emitStatusChange(savedClaudeLimits)
  activate('p-codex')
})

afterAll(() => {
  saveGlobalConfig(c => ({ ...c, providerProfiles: savedProfiles, activeProviderProfileId: savedActiveId }))
  invalidateActiveProviderCache()
})

async function mount() {
  const mounted = await mountHook(
    <AppStateProvider>
      <Host />
    </AppStateProvider>,
    { columns: 120 },
  )
  const frame = () => lastFrame(mounted.streams.getOutput())
  return {
    frame,
    until: (predicate: (f: string) => boolean, label: string) =>
      waitForCondition(() => predicate(frame()), { label, timeoutMs: 3000 }).catch(err => {
        throw new Error(`${(err as Error).message}\nLast frame:\n${frame()}`)
      }),
    cleanup: mounted.cleanup,
  }
}

describe('useProviderUsageWarning (Codex active)', () => {
  test('nothing below the first threshold', async () => {
    const ui = await mount()
    try {
      recordCodexLimits(codex(50))
      await ui.until(f => f.includes('standing: none'), 'the first frame')
      await Bun.sleep(100)
      expect(ui.frame()).toContain('no toast')
    } finally {
      await ui.cleanup()
    }
  })

  test('a crossed threshold toasts once, provider first with the bar, and stays in the footer', async () => {
    const ui = await mount()
    try {
      recordCodexLimits(codex(80))
      await ui.until(f => f.includes('Codex OAuth · 5h ▰▰▰▰▰▰▰▰▱▱ 80% · resets'), 'the 75% toast')
      expect(ui.frame()).toContain('(in 1h 12m)')
      expect(ui.frame()).toContain('toast key: rate-limit-warning')
      expect(ui.frame()).toContain('standing: Codex OAuth 5h 80%')

      // Same threshold, higher number: the footer follows, no new toast.
      recordCodexLimits(codex(85))
      await ui.until(f => f.includes('standing: Codex OAuth 5h 85%'), 'the footer update')
      expect(ui.frame()).toContain('80% · resets')

      recordCodexLimits(codex(91))
      await ui.until(f => f.includes('▰▰▰▰▰▰▰▰▰▱ 91%'), 'the 90% toast')
    } finally {
      await ui.cleanup()
    }
  })
})

describe('useProviderUsageWarning across a /provider switch', () => {
  test('switching back to a provider does not re-toast its old crossing', async () => {
    const ui = await mount()
    try {
      recordCodexLimits(codex(80))
      await ui.until(f => f.includes('Codex OAuth · 5h'), 'the Codex toast')

      activate('p-anthropic')
      emitStatusChange({
        status: 'allowed_warning',
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
        rateLimitType: 'seven_day',
        utilization: 0.92,
        surpassedThreshold: 0.9,
        resetsAt: Math.floor(Date.now() / 1000) + 2 * 86_400,
      })
      rerender()
      await ui.until(f => f.includes('Anthropic · weekly'), 'the Anthropic toast')

      // Back to Codex: nothing new has crossed, so nothing new is said.
      activate('p-codex')
      rerender()
      await ui.until(f => f.includes('standing: Codex OAuth 5h 80%'), 'the Codex footer')
      await Bun.sleep(200)
      expect(ui.frame()).not.toContain('Codex OAuth · 5h')
    } finally {
      await ui.cleanup()
    }
  })
})

test('the REPL runs the warning hook, and the footer reads the same live limits', () => {
  const repl = readFileSync('src/agent/repl/REPL.tsx', 'utf8')
  const footer = readFileSync('src/terminal/prompt-input/Notifications.tsx', 'utf8')
  expect(repl).toContain('useProviderUsageWarning();')
  expect(footer).toContain('useLiveLimits()')
})
