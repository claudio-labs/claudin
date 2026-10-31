/**
 * Characterization of the `/model` picker, pinned before its effort line
 * learns about Ollama thinking models.
 *
 * ModelPicker.tsx is checked in as React-Compiler output; these tests drive it
 * as a black box. It mounts a `SearchableSelect`, which puts stdin in raw
 * mode, so it runs on a real Ink root over throwaway streams (`mountHook`)
 * rather than through `renderToString` (see ModelSelection.test.tsx).
 *
 * The provider is switched through the real resolver (global and project
 * config live in memory under `bun test`). No module is mocked.
 *
 * Model choice is deliberate: `claude-opus-5-5` defaults to `medium` on the
 * Anthropic transport whatever the developer's settings say
 * (providerNeutrality.invariant.test.ts), unlike Opus 4.8, whose default
 * reads `codingLoopXhighDefault` from the real user settings.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as React from 'react'

import {
  getCurrentProjectConfig,
  resetGlobalConfigForTests,
  resetProjectConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import type { EffortLevel } from 'src/providers/effort/effort.js'
import {
  _resetOllamaModelInfoForTesting,
  _setOllamaModelInfoForTesting,
} from 'src/providers/model/ollamaModelInfo.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { lastFrame, mountHook } from 'src/providers/ui/__testutils__/inkHookHarness.js'
import { ModelPicker, type Props } from 'src/providers/ui/ModelPicker.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { type AppState, getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

const LEFT = '\x1B[D'
const RIGHT = '\x1B[C'
const DOWN = '\x1B[B'
const ENTER = '\r'

const ANTHROPIC: ProviderProfile = {
  id: 'mp-anthropic',
  name: 'Anthropic',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-5-5',
}
/** An endpoint no reasoning-catalog row claims: glm-5.3-flash gets no effort
 * control there (reasoningEffortInvariant.test.ts). */
const UNCATALOGUED: ProviderProfile = {
  id: 'mp-compat',
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
  resetProjectConfigForTests()
  invalidateActiveProviderCache()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  resetGlobalConfigForTests()
  resetProjectConfigForTests()
  invalidateActiveProviderCache()
})

type Selection = { model: string | null; effort: EffortLevel | undefined }

type Mounted = {
  press: (keys: string) => Promise<void>
  pressEscape: () => Promise<void>
  frame: () => string
  /** Whitespace-collapsed frame, for order/contiguity assertions. */
  flat: () => string
  state: () => AppState
  selected: Selection[]
  cancelled: () => number
  cleanup: () => Promise<void>
}

async function mountPicker(
  props: Partial<Props> & { initial: string | null },
  options: { withCancel?: boolean; columns?: number } = {},
): Promise<Mounted> {
  const initialState = getDefaultAppState()
  let latest = initialState
  const selected: Selection[] = []
  let cancelCount = 0
  const mounted = await mountHook(
    <AppStateProvider
      initialState={initialState}
      onChangeAppState={({ newState }: { newState: AppState }) => {
        latest = newState
      }}
    >
      <KeybindingSetup>
        <ModelPicker
          onSelect={(model, effort) => selected.push({ model, effort })}
          onCancel={options.withCancel === false ? undefined : () => cancelCount++}
          {...props}
        />
      </KeybindingSetup>
    </AppStateProvider>,
    { columns: options.columns ?? 100 },
  )
  // Let the Select's passive-effect key listener attach before the first key
  // (an Enter written earlier is dropped — see the ProviderManager memory).
  await Bun.sleep(60)
  const frame = () => lastFrame(mounted.streams.getOutput())
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
    frame,
    flat: () => frame().replace(/\s+/g, ' '),
    state: () => latest,
    selected,
    cancelled: () => cancelCount,
    cleanup: mounted.cleanup,
  }
}

const DEFAULT_HEADER =
  'Switch between Claude models. Applies to this session and future Claudin sessions. For other/previous model names, specify with --model.'

describe('a model that supports effort (Opus 5.5 on Anthropic)', () => {
  test('the effort line names the default level and how to adjust it', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker({ initial: 'claude-opus-5-5' })
    try {
      const flat = ui.flat()
      expect(flat).toContain('Select model')
      expect(flat).toContain(DEFAULT_HEADER)
      expect(flat).toContain('⌕ Search models…')
      expect(flat).toContain('Medium effort (default) ← → to adjust')
      expect(flat).not.toContain('Effort not supported')
      // Not a standalone command: no pane rule, no footer hints.
      expect(flat).not.toContain('Esc to exit')
      expect(ui.frame()).not.toContain('────')
    } finally {
      await ui.cleanup()
    }
  })

  test('→ and ← step the effort for the focused model; off the default it drops "(default)"', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker({ initial: 'claude-opus-5-5' })
    try {
      await ui.press(RIGHT)
      expect(ui.flat()).toMatch(/● High effort ← → to adjust/)
      await ui.press(LEFT)
      await ui.press(LEFT)
      expect(ui.flat()).toMatch(/Low effort ← → to adjust/)
      expect(ui.flat()).not.toContain('(default)')
    } finally {
      await ui.cleanup()
    }
  })

  // `initial: 'claude-opus-5-5'` focuses the `opus` alias row (same canonical
  // name), so that alias is what Enter reports.
  test('Enter after a toggle reports the model and effort, and pins the effort for the project', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker({ initial: 'claude-opus-5-5' })
    try {
      await ui.press(RIGHT)
      await ui.press(ENTER)
      expect(ui.selected).toEqual([{ model: 'opus', effort: 'high' }])
      expect(ui.state().effortValue).toBe('high')
      expect(getCurrentProjectConfig().activeEffortForProject).toBe('high')
    } finally {
      await ui.cleanup()
    }
  })

  test('Enter without a toggle reports no effort', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker({ initial: 'claude-opus-5-5' })
    try {
      await ui.press(ENTER)
      expect(ui.selected).toEqual([{ model: 'opus', effort: undefined }])
    } finally {
      await ui.cleanup()
    }
  })

  test('skipSettingsWrite leaves the project pin and the app state alone', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker({ initial: 'claude-opus-5-5', skipSettingsWrite: true })
    try {
      await ui.press(RIGHT)
      await ui.press(ENTER)
      expect(ui.selected).toEqual([{ model: 'opus', effort: 'high' }])
      expect(getCurrentProjectConfig().activeEffortForProject).toBeUndefined()
      expect(ui.state().effortValue).toBeUndefined()
    } finally {
      await ui.cleanup()
    }
  })

  test('a null initial focuses "Default (recommended)" and Enter reports null', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker({ initial: null })
    try {
      expect(ui.frame()).toMatch(/❯ 1\. Default \(recommended\)/)
      // "No preference" resolves to the default main-loop model, Opus 5.5.
      expect(ui.flat()).toContain('Medium effort (default) ← → to adjust')
      await ui.press(ENTER)
      expect(ui.selected).toEqual([{ model: null, effort: undefined }])
    } finally {
      await ui.cleanup()
    }
  })

  test('↓ moves the focus, and the effort line follows the focused model', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker({ initial: null })
    try {
      await ui.press(DOWN)
      // Row 2 reads "Sonnet 5.5" in isolation and "Sonnet" in the full run (an
      // earlier suite changes the label); either way it is the Sonnet 5.5 row.
      expect(ui.frame()).toMatch(/❯ 2\. Sonnet/)
      expect(ui.flat()).toContain('Medium effort (default) ← → to adjust')
    } finally {
      await ui.cleanup()
    }
  })

  test('an effort toggled in the picker survives moving the focus', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker({ initial: null })
    try {
      await ui.press(RIGHT)
      expect(ui.flat()).toContain('High effort ← → to adjust')
      await ui.press(DOWN)
      // Row 2 reads "Sonnet 5.5" in isolation and "Sonnet" in the full run (an
      // earlier suite changes the label); either way it is the Sonnet 5.5 row.
      expect(ui.frame()).toMatch(/❯ 2\. Sonnet/)
      expect(ui.flat()).toContain('High effort ← → to adjust')
      await ui.press(ENTER)
      expect(ui.selected).toEqual([{ model: 'sonnet', effort: 'high' }])
    } finally {
      await ui.cleanup()
    }
  })

  test('Esc calls onCancel', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker({ initial: 'claude-opus-5-5' })
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
    const ui = await mountPicker({ initial: 'claude-opus-5-5' }, { withCancel: false })
    try {
      await ui.pressEscape()
      expect(ui.selected).toEqual([])
      expect(ui.flat()).toContain('Select model')
    } finally {
      await ui.cleanup()
    }
  })
})

describe('header, session line, standalone chrome', () => {
  test('headerText replaces the default header line', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker({ initial: 'claude-opus-5-5', headerText: 'Pick one for the wizard.' })
    try {
      expect(ui.flat()).toContain('Pick one for the wizard.')
      expect(ui.flat()).not.toContain('Switch between Claude models')
    } finally {
      await ui.cleanup()
    }
  })

  test('a session model from plan mode is announced', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker({ initial: 'claude-opus-5-5', sessionModel: 'claude-sonnet-5-5' })
    try {
      expect(ui.flat()).toMatch(
        /Currently using \S.* for this session \(set by plan mode\)\. Selecting a model will undo this\./,
      )
    } finally {
      await ui.cleanup()
    }
  })

  test('as a standalone command it is framed in a pane with the confirm/exit hints', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker({ initial: 'claude-opus-5-5', isStandaloneCommand: true })
    try {
      expect(ui.frame()).toContain('────')
      expect(ui.flat()).toContain('Medium effort (default) ← → to adjust Enter to confirm · Esc to exit')
    } finally {
      await ui.cleanup()
    }
  })

  test('an initial model the list does not carry is added as "Current model"', async () => {
    useProfile(ANTHROPIC)
    const ui = await mountPicker({ initial: 'my-private-finetune' })
    try {
      expect(ui.flat()).toMatch(/my-private-finetune ✔ Current model/)
    } finally {
      await ui.cleanup()
    }
  })
})

describe('a model that does not support effort (glm-5.3-flash on an uncatalogued gateway)', () => {
  test('says "Effort not supported for <model>"', async () => {
    useProfile(UNCATALOGUED)
    const ui = await mountPicker({ initial: 'glm-5.3-flash' })
    try {
      expect(ui.flat()).toContain('○ Effort not supported for glm-5.3-flash')
      expect(ui.flat()).not.toContain('← → to adjust')
    } finally {
      await ui.cleanup()
    }
  })

  test('← → do nothing, and Enter reports no effort', async () => {
    useProfile(UNCATALOGUED)
    const ui = await mountPicker({ initial: 'glm-5.3-flash' })
    try {
      await ui.press(RIGHT)
      await ui.press(LEFT)
      expect(ui.flat()).toContain('○ Effort not supported for glm-5.3-flash')
      await ui.press(ENTER)
      expect(ui.selected).toEqual([{ model: 'glm-5.3-flash', effort: undefined }])
    } finally {
      await ui.cleanup()
    }
  })
})

describe('an Ollama model whose thinking only turns on or off', () => {
  const OLLAMA: ProviderProfile = {
    id: 'mp-ollama',
    name: 'Ollama',
    provider: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    model: 'mgraffam/qwen3.8-35B-A3B-empero:latest',
  }

  beforeEach(() => {
    _setOllamaModelInfoForTesting(OLLAMA.model, { thinking: true, thinkingLevels: false })
  })

  afterEach(() => {
    _resetOllamaModelInfoForTesting()
  })

  test('says how to turn it on or off instead of "Effort not supported"', async () => {
    useProfile(OLLAMA)
    const ui = await mountPicker({ initial: OLLAMA.model })
    try {
      expect(ui.flat()).toContain(`Thinking only turns on or off for ${OLLAMA.model} · /config → Thinking`)
      expect(ui.flat()).not.toContain('Effort not supported')
    } finally {
      await ui.cleanup()
    }
  })
})
