import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { AUTO_COMPACT_WINDOW_ENV } from 'src/agent/compact/autoCompactWindow.js'
import {
  applyAutoCompactWindow,
  AUTO_COMPACT_DISABLED_NOTE,
  AUTO_COMPACT_EXPLANATION,
  autoCompactStatusText,
  describeConfiguredWindow,
  ENV_PRECEDENCE,
  initialDialogValue,
  parseAutoCompactWindow,
  saveAutoCompactWindow,
  stepAutoCompactWindow,
  type UserSettingsStore,
} from 'src/commands/autocompact/setting.ts'
import { setFlagSettingsInline } from 'src/platform/bootstrap/state/sessionFlags.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import type { SettingsJson } from 'src/platform/settings/types.js'
import { renderModelName } from 'src/providers/model/model.js'

// 200k context window (autoCompact.test.ts leans on the same fact).
const MODEL = 'claude-sonnet-4'

function setSettings(settings: Record<string, unknown> | null): void {
  setFlagSettingsInline(settings)
  resetSettingsCache()
}

const savedEnv = process.env[AUTO_COMPACT_WINDOW_ENV]
beforeEach(() => {
  delete process.env[AUTO_COMPACT_WINDOW_ENV]
})
afterEach(() => {
  setSettings(null)
  if (savedEnv === undefined) delete process.env[AUTO_COMPACT_WINDOW_ENV]
  else process.env[AUTO_COMPACT_WINDOW_ENV] = savedEnv
})

describe('parseAutoCompactWindow', () => {
  test('auto and its aliases', () => {
    for (const raw of ['auto', 'RESET', ' unset ', 'default']) expect(parseAutoCompactWindow(raw)).toBe('auto')
  })

  test('suffixed, plain and bare-thousands counts inside 100k–1M', () => {
    expect(parseAutoCompactWindow('500k')).toBe(500_000)
    expect(parseAutoCompactWindow('1M')).toBe(1_000_000)
    expect(parseAutoCompactWindow('150.5k')).toBe(150_500)
    expect(parseAutoCompactWindow('200000')).toBe(200_000)
    expect(parseAutoCompactWindow('200')).toBe(200_000)
    expect(parseAutoCompactWindow('1000')).toBe(1_000_000)
  })

  test('nothing outside the range or unparsable', () => {
    for (const raw of ['50k', '99', '99999', '2m', '1000001', 'abc', '', 'k', '150xyzk', '200kk', '1e5', ' 2 00k', '0x30000']) {
      expect(parseAutoCompactWindow(raw)).toBeUndefined()
    }
  })
})

describe('applyAutoCompactWindow', () => {
  function store(saved: SettingsJson | null = null) {
    const writes: SettingsJson[] = []
    const s: UserSettingsStore = {
      read: () => saved,
      save: (_source, settings) => {
        writes.push(settings)
        return { error: null }
      },
    }
    return { store: s, writes }
  }
  const name = renderModelName(MODEL)

  test('saves the window under the model and says so, with the model cap when it applies', () => {
    const { store: s, writes } = store()
    expect(applyAutoCompactWindow('150k', MODEL, s)).toBe(`Auto-compact window for ${name} set to 150k tokens`)
    expect(writes).toEqual([{ modelSettings: { [MODEL]: { autoCompactWindow: 150_000 } } }])
    expect(applyAutoCompactWindow('500k', MODEL, s)).toBe(
      `Auto-compact window for ${name} set to 500k tokens (capped to model limit of 200k)`,
    )
    expect(applyAutoCompactWindow('200k', MODEL, s)).toBe(`Auto-compact window for ${name} set to 200k tokens`)
  })

  test('auto drops the window, its entry, and modelSettings, each only once nothing else is in it', () => {
    const alone = store({ modelSettings: { [MODEL]: { autoCompactWindow: 150_000 } } })
    expect(applyAutoCompactWindow('auto', MODEL, alone.store)).toBe(`Auto-compact window for ${name} set to auto`)
    // The keys have to be present: updateSettingsForSource deletes on an explicit undefined.
    expect(alone.writes).toHaveLength(1)
    expect(Object.entries(alone.writes[0]!)).toEqual([['modelSettings', undefined] as never])

    const bare = store({ modelSettings: { [MODEL]: { autoCompactWindow: 150_000 }, other: { autoCompactWindow: 1 } } })
    expect(applyAutoCompactWindow('auto', MODEL, bare.store)).toBe(`Auto-compact window for ${name} set to auto`)
    expect(Object.entries(bare.writes[0]!.modelSettings!)).toEqual([[MODEL, undefined] as never])

    const shared = store({ modelSettings: { [MODEL]: { autoCompactWindow: 150_000, other: 1 } } } as SettingsJson)
    applyAutoCompactWindow('reset', MODEL, shared.store)
    expect(shared.writes).toEqual([{ modelSettings: { [MODEL]: { autoCompactWindow: undefined } } }])
  })

  test('refuses while the env var decides, and on an unparsable value, without saving', () => {
    const { store: s, writes } = store()
    expect(applyAutoCompactWindow('50k', MODEL, s)).toBe(
      "Couldn't parse '50k'. Expected 'auto' or 100k–1M tokens (e.g. 500k, 200000, or 200 as shorthand)",
    )
    process.env[AUTO_COMPACT_WINDOW_ENV] = '300000'
    expect(applyAutoCompactWindow('500k', MODEL, s)).toBe(ENV_PRECEDENCE)
    expect(writes).toEqual([])
  })

  test('reports a failed save', () => {
    const failing: UserSettingsStore = { read: () => null, save: () => ({ error: new Error('read-only') }) }
    expect(applyAutoCompactWindow('200k', MODEL, failing)).toBe("Couldn't save setting: read-only")
  })

  test('a choice from the dialog is saved as is, without a parse', () => {
    const { store: s, writes } = store()
    expect(saveAutoCompactWindow(250_000, MODEL, s)).toBe(
      `Auto-compact window for ${name} set to 250k tokens (capped to model limit of 200k)`,
    )
    expect(writes).toEqual([{ modelSettings: { [MODEL]: { autoCompactWindow: 250_000 } } }])
  })

  test('says so when a project, local or policy setting overrides the choice', () => {
    // Flag settings stand in for the higher-priority sources; userSettings is the lowest.
    setSettings({ modelSettings: { [MODEL]: { autoCompactWindow: 150_000 } } })
    const { store: s } = store()
    expect(applyAutoCompactWindow('auto', MODEL, s)).toBe(
      `Auto-compact window for ${name} set to auto in settings, but a higher-priority override is active (150k tokens)`,
    )
    expect(applyAutoCompactWindow('180k', MODEL, s)).toBe(
      `Auto-compact window for ${name} set to 180k tokens, but a higher-priority override is active (150k tokens)`,
    )
  })

  test('no override when the window in effect is the user settings one', () => {
    setSettings({ modelSettings: { [MODEL]: { autoCompactWindow: 150_000 } } })
    const { store: s } = store({ modelSettings: { [MODEL]: { autoCompactWindow: 150_000 } } })
    expect(applyAutoCompactWindow('auto', MODEL, s)).toBe(`Auto-compact window for ${name} set to auto`)
  })
})

describe('status', () => {
  test('auto, a saved window, the env var, and the model cap', () => {
    expect(describeConfiguredWindow(MODEL)).toBe('auto')
    setSettings({ modelSettings: { [MODEL]: { autoCompactWindow: 150_000 } } })
    expect(describeConfiguredWindow(MODEL)).toBe('150k tokens (from settings)')
    setSettings({ modelSettings: { [MODEL]: { autoCompactWindow: 500_000 } } })
    expect(describeConfiguredWindow(MODEL)).toBe('500k tokens (from settings) · capped to 200k by model')
    setSettings({ modelSettings: { [MODEL]: { autoCompactWindow: 200_000 } } })
    expect(describeConfiguredWindow(MODEL)).toBe('200k tokens (from settings)')
    process.env[AUTO_COMPACT_WINDOW_ENV] = '120000'
    expect(describeConfiguredWindow(MODEL)).toBe(`120k tokens (from ${AUTO_COMPACT_WINDOW_ENV})`)
  })

  test('the status text adds the disabled note only when auto-compact is off', () => {
    expect(autoCompactStatusText(MODEL, true)).toBe(
      `Auto-compact window for ${renderModelName(MODEL)}: auto\n${AUTO_COMPACT_EXPLANATION}`,
    )
    expect(autoCompactStatusText(MODEL, false).split('\n')).toEqual([
      `Auto-compact window for ${renderModelName(MODEL)}: auto`,
      AUTO_COMPACT_DISABLED_NOTE,
      AUTO_COMPACT_EXPLANATION,
    ])
  })
})

describe('the dialog value', () => {
  test('starts at auto, or at the configured window snapped to the 100k grid', () => {
    expect(initialDialogValue({ source: 'auto' })).toBe('auto')
    expect(initialDialogValue({ source: 'settings', window: 260_000 })).toBe(300_000)
    expect(initialDialogValue({ source: 'env', window: 40_000 })).toBe(100_000)
    expect(initialDialogValue({ source: 'env', window: 3_000_000 })).toBe(1_000_000)
  })

  test('steps by 100k, with auto past both ends', () => {
    expect(stepAutoCompactWindow('auto', 1)).toBe(100_000)
    expect(stepAutoCompactWindow('auto', -1)).toBe(1_000_000)
    expect(stepAutoCompactWindow(300_000, 1)).toBe(400_000)
    expect(stepAutoCompactWindow(100_000, -1)).toBe('auto')
    expect(stepAutoCompactWindow(1_000_000, 1)).toBe('auto')
  })
})
