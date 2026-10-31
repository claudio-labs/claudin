/**
 * Characterization of the `/effort` slider, pinned before the "not supported"
 * note learns about Ollama thinking models.
 *
 * Mounted on a real Ink root over throwaway streams (`mountHook`) rather than
 * through `renderToString`: the picker calls `useInput`, which puts stdin in
 * raw mode, and under `renderToString` that is the PROCESS stdin — Ink logs
 * "Raw mode is not supported" and each frame waits out the 3s fallback.
 *
 * The provider is switched through the real resolver (the global config lives
 * in memory under `bun test`) and the model through `AppStateProvider`'s
 * `initialState`. No module is mocked.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as React from 'react'

import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import { type EffortValue, getEffortValueDescription } from 'src/providers/effort/effort.js'
import {
  _resetOllamaModelInfoForTesting,
  _setOllamaModelInfoForTesting,
} from 'src/providers/model/ollamaModelInfo.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { lastFrame, mountHook } from 'src/providers/ui/__testutils__/inkHookHarness.js'
import { EffortPicker } from 'src/providers/ui/EffortPicker.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { type AppState, getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

const LEFT = '\x1B[D'
const RIGHT = '\x1B[C'
const ENTER = '\r'

const ANTHROPIC: ProviderProfile = {
  id: 'ep-anthropic',
  name: 'Anthropic',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-4-8',
}
/** An endpoint no reasoning-catalog row claims: the GPT-5 family keeps its
 * control there, everything else gets none (reasoningEffortInvariant.test.ts). */
const UNCATALOGUED: ProviderProfile = {
  id: 'ep-compat',
  name: 'Some gateway',
  provider: 'openai',
  baseUrl: 'https://llm.example.test/v1',
  model: 'glm-5.3-flash',
  apiKey: 'k',
}

const ENV_KEYS = ['CLAUDIN_ALWAYS_ENABLE_EFFORT', 'CLAUDIN_EFFORT_LEVEL'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

function useProfile(profile: ProviderProfile): void {
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [profile],
    activeProviderProfileId: profile.id,
  }))
  invalidateActiveProviderCache()
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

afterEach(() => {
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

type Mounted = {
  press: (keys: string) => Promise<void>
  pressEscape: () => Promise<void>
  frame: () => string
  /** The store as the picker last left it, via `onChangeAppState`. */
  state: () => AppState
  selected: Array<EffortValue | undefined>
  cancelled: () => number
  cleanup: () => Promise<void>
}

async function mountPicker(
  model: string,
  options: { effortValue?: EffortValue; columns?: number; withCancel?: boolean } = {},
): Promise<Mounted> {
  const initialState: AppState = {
    ...getDefaultAppState(),
    mainLoopModel: model,
    mainLoopModelForSession: null,
    effortValue: options.effortValue,
  }
  let latest = initialState
  const selected: Array<EffortValue | undefined> = []
  let cancelCount = 0
  const mounted = await mountHook(
    <AppStateProvider
      initialState={initialState}
      onChangeAppState={({ newState }: { newState: AppState }) => {
        latest = newState
      }}
    >
      <EffortPicker
        onSelect={effort => selected.push(effort)}
        onCancel={options.withCancel === false ? undefined : () => cancelCount++}
      />
    </AppStateProvider>,
    { columns: options.columns ?? 100 },
  )
  await Bun.sleep(40)
  return {
    press: async keys => {
      mounted.streams.stdin.write(keys)
      await Bun.sleep(40)
    },
    // A bare ESC is the prefix of every escape sequence, so the parser only
    // resolves it as Escape after its sequence timeout.
    pressEscape: async () => {
      mounted.streams.stdin.write('\x1B')
      await Bun.sleep(300)
    },
    frame: () => lastFrame(mounted.streams.getOutput()),
    state: () => latest,
    selected,
    cancelled: () => cancelCount,
    cleanup: mounted.cleanup,
  }
}

/** The slider's label row, whitespace-collapsed. */
function labelsRow(frame: string): string | undefined {
  return frame
    .split('\n')
    .map(l => l.trim().replace(/\s+/g, ' '))
    .find(l => /^(low|medium|high|xhigh|max|minimal|none)( |$)/.test(l))
}

/** Column of the `^` marker relative to where the rule starts. */
function markerUnder(frame: string): string | undefined {
  const lines = frame.split('\n')
  const ruleIdx = lines.findIndex(l => l.includes('^') && l.includes('─'))
  if (ruleIdx < 0) return undefined
  const rule = lines[ruleIdx]!
  const labels = lines[ruleIdx + 1] ?? ''
  const col = rule.indexOf('^')
  // The word in the labels row that spans the marker column.
  const match = [...labels.matchAll(/\S+/g)].find(
    m => m.index! <= col && col < m.index! + m[0].length,
  )
  return match?.[0]
}

describe('a model that supports effort (Claude Opus 4.8 on Anthropic)', () => {
  test('draws the slider: header, rule with marker, every level, the focused description', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker('claude-opus-4-8')
    try {
      const frame = ui.frame()
      expect(frame).toContain('Effort')
      expect(frame).not.toContain('Effort not supported')
      expect(frame).toMatch(/Faster\s+Smarter/)
      expect(labelsRow(frame)).toBe('low medium high xhigh max')
      // Never configured → leftmost level, no OpenAI default to look up.
      expect(markerUnder(frame)).toBe('low')
      expect(frame).toMatch(/←\/→ to adjust · Enter to confirm · Esc to cancel/)
    } finally {
      await ui.cleanup()
    }
  })

  test('opens on the saved effort', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker('claude-opus-4-8', { effortValue: 'xhigh' })
    try {
      expect(markerUnder(ui.frame())).toBe('xhigh')
    } finally {
      await ui.cleanup()
    }
  })

  test('an adaptive saved effort opens on the leftmost level', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker('claude-opus-4-8', { effortValue: 'adaptive' })
    try {
      expect(markerUnder(ui.frame())).toBe('low')
    } finally {
      await ui.cleanup()
    }
  })

  test('a saved level the model does not have opens on the level it is displayed as', async () => {
    useProfile(ANTHROPIC)
    // Sonnet 4.6 has low/medium/high only; a saved `max` is shown as `high`.
    const ui = await mountPicker('claude-sonnet-4-6', { effortValue: 'max' })
    try {
      const frame = ui.frame()
      expect(labelsRow(frame)).toBe('low medium high')
      expect(markerUnder(frame)).toBe('high')
    } finally {
      await ui.cleanup()
    }
  })

  test('← → move the focus and clamp at both ends; the description follows', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker('claude-sonnet-4-6')
    try {
      const atLow = ui.frame()
      await ui.press(LEFT)
      expect(markerUnder(ui.frame())).toBe('low')
      await ui.press(RIGHT)
      const atMedium = ui.frame()
      expect(markerUnder(atMedium)).toBe('medium')
      await ui.press(RIGHT)
      await ui.press(RIGHT)
      await ui.press(RIGHT)
      expect(markerUnder(ui.frame())).toBe('high')
      // The description line under the slider follows the focus.
      expect(atLow).toContain(getEffortValueDescription('low'))
      expect(atMedium).toContain(getEffortValueDescription('medium'))
      expect(atMedium).not.toContain(getEffortValueDescription('low'))
    } finally {
      await ui.cleanup()
    }
  })

  test('Enter applies the focused level to the app state and reports it', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker('claude-opus-4-8')
    try {
      await ui.press(RIGHT)
      await ui.press(RIGHT)
      await ui.press(ENTER)
      expect(ui.selected).toEqual(['high'])
      expect(ui.state().effortValue).toBe('high')
    } finally {
      await ui.cleanup()
    }
  })

  test('Esc cancels without selecting', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker('claude-opus-4-8')
    try {
      await ui.pressEscape()
      expect(ui.cancelled()).toBe(1)
      expect(ui.selected).toEqual([])
    } finally {
      await ui.cleanup()
    }
  })

  test('Esc with no onCancel is a no-op', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker('claude-opus-4-8', { withCancel: false })
    try {
      await ui.pressEscape()
      expect(ui.selected).toEqual([])
      expect(ui.frame()).toContain('Effort')
    } finally {
      await ui.cleanup()
    }
  })

  test('a narrow terminal still draws every level on one row', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker('claude-opus-4-8', { columns: 34 })
    try {
      expect(labelsRow(ui.frame())).toBe('low medium high xhigh max')
    } finally {
      await ui.cleanup()
    }
  })
})

describe('the OpenAI effort family', () => {
  test('xhigh is labelled max, and opens on the profile default reasoning effort', async () => {
    // gpt-5.4 carries `reasoningEffort: 'high'` in providerConfig's alias
    // table, which is where the picker lands when nothing is saved.
    useProfile({
      id: 'ep-openai',
      name: 'OpenAI',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4',
      apiKey: 'k',
    })
    const ui = await mountPicker('gpt-5.4')
    try {
      const frame = ui.frame()
      expect(labelsRow(frame)).toBe('low medium high max')
      expect(markerUnder(frame)).toBe('high')
      // The label says max, the applied value stays the raw level.
      for (let i = 0; i < 6; i++) await ui.press(RIGHT)
      expect(markerUnder(ui.frame())).toBe('max')
      await ui.press(ENTER)
      expect(ui.selected).toEqual(['xhigh'])
      expect(ui.state().effortValue).toBe('xhigh')
    } finally {
      await ui.cleanup()
    }
  })
})

describe('a model that does not support effort', () => {
  test('says "Effort not supported for this model" and draws no slider', async () => {
    useProfile(UNCATALOGUED)
    const ui = await mountPicker('glm-5.3-flash')
    try {
      const frame = ui.frame()
      expect(frame).toContain('Effort not supported for this model')
      expect(frame).not.toContain('Faster')
      expect(frame).not.toContain('^')
      expect(labelsRow(frame)).toBeUndefined()
      expect(frame).toMatch(/←\/→ to adjust · Enter to confirm · Esc to cancel/)
    } finally {
      await ui.cleanup()
    }
  })

  test('Enter does nothing when there is no level to select', async () => {
    useProfile(UNCATALOGUED)
    const ui = await mountPicker('glm-5.3-flash')
    try {
      await ui.press(RIGHT)
      await ui.press(ENTER)
      expect(ui.selected).toEqual([])
      expect(ui.state().effortValue).toBeUndefined()
    } finally {
      await ui.cleanup()
    }
  })
})

describe('an Ollama model whose thinking only turns on or off', () => {
  const OLLAMA: ProviderProfile = {
    id: 'ep-ollama',
    name: 'Ollama',
    provider: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    model: 'mgraffam/qwen3.8-35B-A3B-empero:latest',
  }

  afterEach(() => {
    _resetOllamaModelInfoForTesting()
  })

  test('points at the Thinking toggle instead of "Effort not supported"', async () => {
    _setOllamaModelInfoForTesting(OLLAMA.model, { thinking: true, thinkingLevels: false })
    useProfile(OLLAMA)
    const ui = await mountPicker(OLLAMA.model)
    try {
      const frame = ui.frame()
      expect(frame).toContain('Thinking only turns on or off for this model · /config → Thinking')
      expect(frame).not.toContain('Effort not supported')
    } finally {
      await ui.cleanup()
    }
  })

  test('gpt-oss has real levels: the slider is drawn', async () => {
    _setOllamaModelInfoForTesting('gpt-oss:20b', { thinking: true, thinkingLevels: true })
    useProfile({ ...OLLAMA, model: 'gpt-oss:20b' })
    const ui = await mountPicker('gpt-oss:20b')
    try {
      expect(labelsRow(ui.frame())).toBe('low medium high')
    } finally {
      await ui.cleanup()
    }
  })
})
