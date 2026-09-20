import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'

import type { ProviderProfile } from 'src/platform/config/config.js'
import { lastFrame, mountHook } from 'src/providers/ui/__testutils__/inkHookHarness.js'
import type {
  ProviderManagerResult,
  Screen,
} from 'src/providers/ui/ProviderManager.types.js'
import type { ProviderPreset } from 'src/providers/presets/providerProfiles.js'
import {
  AnthropicAuthChoiceScreen,
  AnthropicOAuthScreen,
  KimiAuthChoiceScreen,
} from 'src/providers/ui/screens/AuthChoice.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'

const ENTER = '\r'
const DOWN = 'j'

const ANTHROPIC_DEFAULTS = {
  provider: 'anthropic' as const,
  name: 'Anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-6',
  apiKey: '',
}

// Snapshot the reals as PLAIN OBJECTS before anything mocks them. A live
// `import *` namespace re-applies whatever stub is installed, so restoring
// from one would hand the next file this file's mock (testing.md).
const realProviderProfiles = {
  ...(await import('src/providers/presets/providerProfiles.js')),
}
const realConsoleOAuthFlow = {
  ...(await import('src/providers/ui/ConsoleOAuthFlow.js')),
}

function wrap(node: React.ReactNode): React.ReactNode {
  return (
    <AppStateProvider>
      <KeybindingSetup>{node}</KeybindingSetup>
    </AppStateProvider>
  )
}

/**
 * A real root rather than `renderToString`: these screens mount a `Select`,
 * which puts stdin in raw mode, and the process stdin under `bun test` does
 * not support it.
 */
async function mountScreen(node: React.ReactNode): Promise<{
  press: (keys: string) => Promise<void>
  pressEscape: () => Promise<void>
  frame: () => string
  cleanup: () => Promise<void>
}> {
  const mounted = await mountHook(wrap(node), { columns: 100 })
  await Bun.sleep(40)
  return {
    press: async (keys: string) => {
      mounted.streams.stdin.write(keys)
      await Bun.sleep(40)
    },
    pressEscape: async () => {
      mounted.streams.stdin.write('\x1B')
      await Bun.sleep(300)
    },
    frame: () => lastFrame(mounted.streams.getOutput()),
    cleanup: mounted.cleanup,
  }
}

function makeAnthropicChoiceDeps() {
  return { setScreen: mock((_screen: Screen) => {}) }
}

function makeKimiChoiceDeps() {
  return {
    setScreen: mock((_screen: Screen) => {}),
    startCreateFromPreset: mock((_preset: ProviderPreset) => {}),
  }
}

describe('AnthropicAuthChoiceScreen', () => {
  test('routes each row to its own screen', async () => {
    const targets: Screen[] = ['anthropic-oauth', 'form', 'select-preset']

    for (let row = 0; row < targets.length; row++) {
      const deps = makeAnthropicChoiceDeps()
      const ui = await mountScreen(<AnthropicAuthChoiceScreen {...deps} />)
      try {
        for (let i = 0; i < row; i++) await ui.press(DOWN)
        await ui.press(ENTER)
      } finally {
        await ui.cleanup()
      }

      expect(deps.setScreen.mock.calls).toEqual([[targets[row]]])
    }
  })

  test('the API key row goes straight to the form, never through the OAuth screen', async () => {
    const deps = makeAnthropicChoiceDeps()
    const ui = await mountScreen(<AnthropicAuthChoiceScreen {...deps} />)
    try {
      await ui.press(DOWN)
      await ui.press(ENTER)
    } finally {
      await ui.cleanup()
    }

    // Anthropic's key path has no preset step of its own — this is the only
    // thing that distinguishes it from Kimi's.
    expect(deps.setScreen.mock.calls).toEqual([['form']])
  })

  test('Esc backs out to the preset list', async () => {
    const deps = makeAnthropicChoiceDeps()
    const ui = await mountScreen(<AnthropicAuthChoiceScreen {...deps} />)
    try {
      await ui.pressEscape()
    } finally {
      await ui.cleanup()
    }

    expect(deps.setScreen.mock.calls).toEqual([['select-preset']])
  })
})

describe('KimiAuthChoiceScreen', () => {
  test('the OAuth row opens the device flow', async () => {
    const deps = makeKimiChoiceDeps()
    const ui = await mountScreen(<KimiAuthChoiceScreen {...deps} />)
    try {
      await ui.press(ENTER)
    } finally {
      await ui.cleanup()
    }

    expect(deps.setScreen.mock.calls).toEqual([['kimi-oauth']])
    expect(deps.startCreateFromPreset).not.toHaveBeenCalled()
  })

  test('the API key row creates the preset draft instead of switching screen', async () => {
    const deps = makeKimiChoiceDeps()
    const ui = await mountScreen(<KimiAuthChoiceScreen {...deps} />)
    try {
      await ui.press(DOWN)
      await ui.press(ENTER)
    } finally {
      await ui.cleanup()
    }

    // Unlike Anthropic, Kimi's key path seeds the draft from the preset, so
    // the form arrives pre-filled; setScreen is startCreateFromPreset's job.
    expect(deps.startCreateFromPreset.mock.calls).toEqual([['moonshotai']])
    expect(deps.setScreen).not.toHaveBeenCalled()
  })

  test('the back row returns to the preset list', async () => {
    const deps = makeKimiChoiceDeps()
    const ui = await mountScreen(<KimiAuthChoiceScreen {...deps} />)
    try {
      await ui.press(DOWN)
      await ui.press(DOWN)
      await ui.press(ENTER)
    } finally {
      await ui.cleanup()
    }

    expect(deps.setScreen.mock.calls).toEqual([['select-preset']])
    expect(deps.startCreateFromPreset).not.toHaveBeenCalled()
  })
})

type ProfilesMockOptions = {
  getProviderProfiles?: () => ProviderProfile[]
  addProviderProfile?: (...args: never[]) => unknown
  updateProviderProfile?: (...args: never[]) => unknown
  setActiveProviderProfile?: (...args: never[]) => unknown
}

function mockProviderProfiles(options: ProfilesMockOptions): void {
  mock.module('src/providers/presets/providerProfiles.js', () => ({
    ...realProviderProfiles,
    getProviderPresetDefaults: () => ANTHROPIC_DEFAULTS,
    getProviderProfiles: options.getProviderProfiles ?? (() => []),
    addProviderProfile: options.addProviderProfile ?? (() => null),
    updateProviderProfile: options.updateProviderProfile ?? (() => null),
    setActiveProviderProfile: options.setActiveProviderProfile ?? (() => null),
  }))
}

/**
 * ConsoleOAuthFlow is reached through a render-time `require` that exists to
 * break an import cycle, so the stub has to be installed on the module and not
 * injected. It completes immediately: everything under test lives in the
 * `onDone` the screen hands it.
 */
function mockConsoleOAuthFlow(): void {
  mock.module('src/providers/ui/ConsoleOAuthFlow.js', () => ({
    ...realConsoleOAuthFlow,
    ConsoleOAuthFlow: ({ onDone }: { onDone: () => void }) => {
      const fired = React.useRef(false)
      React.useEffect(() => {
        if (fired.current) return
        fired.current = true
        onDone()
      }, [onDone])
      return null
    },
  }))
}

function makeOAuthDeps(mode: 'first-run' | 'manage', activeProfileId?: string) {
  return {
    mode,
    activeProfileId,
    onDone: mock((_result?: ProviderManagerResult) => {}),
    setErrorMessage: mock((_message: string | undefined) => {}),
    setScreen: mock((_screen: Screen) => {}),
    setStatusMessage: mock((_message: string | undefined) => {}),
    refreshProfiles: mock(() => {}),
    returnToMenu: mock(() => {}),
  }
}

const SAVED_PROFILE = {
  id: 'prof-anthropic',
  name: 'Anthropic',
  provider: 'anthropic',
  baseUrl: ANTHROPIC_DEFAULTS.baseUrl,
  model: ANTHROPIC_DEFAULTS.model,
} as unknown as ProviderProfile

/** Matches findAnthropicOAuthProfile: anthropic transport, same base URL, no key. */
const EXISTING_KEYLESS = {
  id: 'prof-existing',
  name: 'Anthropic',
  provider: 'anthropic',
  baseUrl: ANTHROPIC_DEFAULTS.baseUrl,
  model: ANTHROPIC_DEFAULTS.model,
} as unknown as ProviderProfile

async function runOAuthScreen(
  deps: ReturnType<typeof makeOAuthDeps>,
): Promise<void> {
  const mounted = await mountHook(wrap(<AnthropicOAuthScreen {...deps} />), {
    columns: 100,
  })
  try {
    await Bun.sleep(60)
  } finally {
    await mounted.cleanup()
  }
}

// Declared with their real parameters so `.mock.calls` keeps its tuple shape;
// `mock(() => X)` infers a zero-arg signature and makes every call assertion
// a type error.
function mockAdd() {
  return mock(
    (_payload: unknown, _options?: { makeActive?: boolean }) => SAVED_PROFILE,
  )
}

function mockUpdate(result: ProviderProfile) {
  return mock((_id: string, _payload: unknown) => result)
}

function mockActivate(result: ProviderProfile | null) {
  return mock((_id: string) => result)
}

describe('AnthropicOAuthScreen', () => {
  beforeEach(() => {
    mockConsoleOAuthFlow()
  })

  afterAll(() => {
    // Re-install the reals under the same specifiers this file mocked, or the
    // stubs stay live for every file bun runs after this one.
    mock.module('src/providers/presets/providerProfiles.js', () => ({
      ...realProviderProfiles,
    }))
    mock.module('src/providers/ui/ConsoleOAuthFlow.js', () => ({
      ...realConsoleOAuthFlow,
    }))
  })

  test('a brand new profile in manage mode is saved without being activated', async () => {
    const addProviderProfile = mockAdd()
    mockProviderProfiles({ addProviderProfile })
    const deps = makeOAuthDeps('manage')

    await runOAuthScreen(deps)

    expect(addProviderProfile.mock.calls).toEqual([
      [
        {
          provider: 'anthropic',
          name: ANTHROPIC_DEFAULTS.name,
          baseUrl: ANTHROPIC_DEFAULTS.baseUrl,
          model: ANTHROPIC_DEFAULTS.model,
        },
        { makeActive: false },
      ],
    ])
    expect(deps.setStatusMessage.mock.calls).toEqual([
      ['Anthropic OAuth configured: Anthropic'],
    ])
    expect(deps.returnToMenu).toHaveBeenCalledTimes(1)
    expect(deps.onDone).not.toHaveBeenCalled()
  })

  test('first-run asks addProviderProfile to make the new profile active', async () => {
    const addProviderProfile = mockAdd()
    mockProviderProfiles({ addProviderProfile })
    const deps = makeOAuthDeps('first-run')

    await runOAuthScreen(deps)

    expect(addProviderProfile.mock.calls[0]?.[1]).toEqual({ makeActive: true })
    expect(deps.onDone.mock.calls).toEqual([
      [
        {
          action: 'saved',
          activeProfileId: SAVED_PROFILE.id,
          message: 'Anthropic OAuth configured: Anthropic',
        },
      ],
    ])
    // first-run hands control back to the caller instead of the menu.
    expect(deps.returnToMenu).not.toHaveBeenCalled()
    expect(deps.setStatusMessage).not.toHaveBeenCalled()
  })

  test('a re-login updates the keyless profile instead of appending a duplicate', async () => {
    const addProviderProfile = mockAdd()
    const updateProviderProfile = mockUpdate(EXISTING_KEYLESS)
    mockProviderProfiles({
      getProviderProfiles: () => [EXISTING_KEYLESS],
      addProviderProfile,
      updateProviderProfile,
    })
    const deps = makeOAuthDeps('manage')

    await runOAuthScreen(deps)

    expect(updateProviderProfile.mock.calls[0]?.[0]).toBe(EXISTING_KEYLESS.id)
    expect(addProviderProfile).not.toHaveBeenCalled()
    expect(deps.refreshProfiles).toHaveBeenCalledTimes(1)
  })

  test('first-run re-activates the updated profile when it is not already active', async () => {
    const setActiveProviderProfile = mockActivate(EXISTING_KEYLESS)
    mockProviderProfiles({
      getProviderProfiles: () => [EXISTING_KEYLESS],
      updateProviderProfile: () => EXISTING_KEYLESS,
      setActiveProviderProfile,
    })
    const deps = makeOAuthDeps('first-run', 'some-other-profile')

    await runOAuthScreen(deps)

    // updateProviderProfile leaves the active pointer alone, so the screen has
    // to move it itself.
    expect(setActiveProviderProfile.mock.calls).toEqual([[EXISTING_KEYLESS.id]])
    expect(deps.onDone).toHaveBeenCalledTimes(1)
  })

  test('an already-active profile is not re-activated', async () => {
    const setActiveProviderProfile = mockActivate(EXISTING_KEYLESS)
    mockProviderProfiles({
      getProviderProfiles: () => [EXISTING_KEYLESS],
      updateProviderProfile: () => EXISTING_KEYLESS,
      setActiveProviderProfile,
    })
    const deps = makeOAuthDeps('first-run', EXISTING_KEYLESS.id)

    await runOAuthScreen(deps)

    expect(setActiveProviderProfile).not.toHaveBeenCalled()
    expect(deps.onDone).toHaveBeenCalledTimes(1)
  })

  test('a refused save reports it and drops back to the preset list', async () => {
    mockProviderProfiles({ addProviderProfile: () => null })
    const deps = makeOAuthDeps('manage')

    await runOAuthScreen(deps)

    expect(deps.setErrorMessage.mock.calls).toEqual([
      ['OAuth completed, but the Anthropic profile could not be saved.'],
    ])
    expect(deps.setScreen.mock.calls).toEqual([['select-preset']])
    // The failure path must not claim success by refreshing and returning.
    expect(deps.refreshProfiles).not.toHaveBeenCalled()
    expect(deps.returnToMenu).not.toHaveBeenCalled()
  })

  test('a refused activation is reported separately from a refused save', async () => {
    mockProviderProfiles({
      getProviderProfiles: () => [EXISTING_KEYLESS],
      updateProviderProfile: () => EXISTING_KEYLESS,
      setActiveProviderProfile: () => null,
    })
    const deps = makeOAuthDeps('first-run', 'some-other-profile')

    await runOAuthScreen(deps)

    expect(deps.setErrorMessage.mock.calls).toEqual([
      [
        'OAuth completed, but the Anthropic profile could not be set as the startup provider.',
      ],
    ])
    expect(deps.setScreen.mock.calls).toEqual([['select-preset']])
    expect(deps.onDone).not.toHaveBeenCalled()
  })
})
