import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import * as React from 'react'

import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { useProviderUsageWarning } from 'src/platform/notifications/useProviderUsageWarning.js'
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

/** Shows the toast on screen and the footer's standing line under it. */
function Host(): React.ReactNode {
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

beforeAll(() => {
  const config = getGlobalConfig()
  savedProfiles = config.providerProfiles
  savedActiveId = config.activeProviderProfileId
  saveGlobalConfig(c => ({ ...c, providerProfiles: [CODEX_PROFILE], activeProviderProfileId: 'p-codex' }))
  invalidateActiveProviderCache()
})

afterEach(resetCodexLimitsForTesting)

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
