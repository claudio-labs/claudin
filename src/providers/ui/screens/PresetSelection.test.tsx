import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'

import type { ProviderProfile } from 'src/platform/config/config.js'
import { lastFrame, mountHook } from 'src/providers/ui/__testutils__/inkHookHarness.js'
import type { ProviderPreset } from 'src/providers/presets/providerProfiles.js'
import type {
  ProviderManagerResult,
  Screen,
} from 'src/providers/ui/ProviderManager.types.js'
import { PresetSelectionScreen } from 'src/providers/ui/screens/PresetSelection.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'

const ENTER = '\r'
const SEARCH = '/'

// Snapshot the reals as PLAIN OBJECTS before anything mocks them — a live
// `import *` namespace re-applies whatever stub is installed (testing.md).
const realClaudinMigration = {
  ...(await import('src/platform/config/claudinMigration.js')),
}
const realProviderProfiles = {
  ...(await import('src/providers/presets/providerProfiles.js')),
}

// `isBareMode()` reads this, and a sibling file that leaves it set would hide
// the two OAuth rows from every test here. Clear what is already leaked.
const LEAKED_SIMPLE = process.env.CLAUDIN_SIMPLE
delete process.env.CLAUDIN_SIMPLE

function setBareMode(on: boolean): void {
  if (on) process.env.CLAUDIN_SIMPLE = '1'
  else delete process.env.CLAUDIN_SIMPLE
}

afterEach(() => {
  setBareMode(false)
})

afterAll(() => {
  // Never `= LEAKED_SIMPLE` when it may be undefined — that stores the literal
  // string "undefined", which is truthy to isEnvTruthy.
  if (LEAKED_SIMPLE === undefined) delete process.env.CLAUDIN_SIMPLE
  else process.env.CLAUDIN_SIMPLE = LEAKED_SIMPLE

  mock.module('src/platform/config/claudinMigration.js', () => ({
    ...realClaudinMigration,
  }))
  mock.module('src/providers/presets/providerProfiles.js', () => ({
    ...realProviderProfiles,
  }))
})

function makeDeps(mode: 'first-run' | 'manage' = 'manage') {
  return {
    mode,
    canImportLegacyClaude: false,
    onDone: mock((_result?: ProviderManagerResult) => {}),
    setScreen: mock((_screen: Screen) => {}),
    setCanImportLegacyClaude: mock((_value: boolean) => {}),
    setErrorMessage: mock((_message: string | undefined) => {}),
    setStatusMessage: mock((_message: string | undefined) => {}),
    closeWithCancelled: mock((_message: string) => {}),
    refreshProfiles: mock(() => {}),
    returnToMenu: mock(() => {}),
    startCreateFromPreset: mock((_preset: ProviderPreset) => {}),
  }
}

function wrap(node: React.ReactNode): React.ReactNode {
  return (
    <AppStateProvider>
      <KeybindingSetup>{node}</KeybindingSetup>
    </AppStateProvider>
  )
}

type Ui = {
  press: (keys: string) => Promise<void>
  pressEscape: () => Promise<void>
  frame: () => string
  cleanup: () => Promise<void>
}

/**
 * A real root rather than `renderToString`: `SearchableSelect` puts stdin in
 * raw mode, which the process stdin under `bun test` does not support.
 */
async function mountScreen(
  deps: ReturnType<typeof makeDeps>,
  columns = 110,
): Promise<Ui> {
  const mounted = await mountHook(wrap(<PresetSelectionScreen {...deps} />), {
    columns,
  })
  await Bun.sleep(60)
  return {
    press: async (keys: string) => {
      mounted.streams.stdin.write(keys)
      await Bun.sleep(50)
    },
    pressEscape: async () => {
      mounted.streams.stdin.write('\x1B')
      await Bun.sleep(300)
    },
    frame: () => lastFrame(mounted.streams.getOutput()),
    cleanup: mounted.cleanup,
  }
}

/**
 * Pick a row by label instead of by index. The list is 30+ rows and its exact
 * composition is what half of these tests are about, so counting `j` presses
 * would couple every selection test to every composition change.
 *
 * `/` opens the query, the first Enter leaves search mode keeping the filter,
 * the second selects the only remaining row.
 */
async function selectByQuery(ui: Ui, query: string, label: string): Promise<void> {
  await ui.press(SEARCH)
  await ui.press(query)
  await ui.press(ENTER)
  expect(ui.frame()).toContain(label)
  await ui.press(ENTER)
}

/**
 * Sibling `<Text>` in a row Box wrap as independent columns, so a bare
 * `toContain` passes on a render whose fragments got interleaved across rows.
 */
function expectInOrder(frame: string, fragments: string[]): void {
  let rest = frame.replace(/\s+/g, ' ')
  for (const fragment of fragments) {
    expect(rest).toContain(fragment)
    rest = rest.slice(rest.indexOf(fragment) + fragment.length)
  }
}

describe('PresetSelectionScreen composition', () => {
  test('bare mode drops the two browser-OAuth presets', async () => {
    const withBrowser = await mountScreen(makeDeps())
    let openFrame: string
    try {
      await withBrowser.press(SEARCH)
      await withBrowser.press('OAuth')
      openFrame = withBrowser.frame()
    } finally {
      await withBrowser.cleanup()
    }
    expect(openFrame).toContain('Codex OAuth')
    expect(openFrame).toContain('xAI / Grok (OAuth)')

    setBareMode(true)
    const bare = await mountScreen(makeDeps())
    let bareFrame: string
    try {
      await bare.press(SEARCH)
      await bare.press('OAuth')
      bareFrame = bare.frame()
    } finally {
      await bare.cleanup()
    }
    // Both rows are gated on `!isBareMode()`; the Moonshot row is not, so its
    // "OAuth sign-in" description proves the query still ran.
    expect(bareFrame).not.toContain('Codex OAuth')
    expect(bareFrame).not.toContain('xAI / Grok (OAuth)')
    expect(bareFrame).toContain('Moonshot AI')
  })

  test('the legacy-import row is first when it is offered, and absent otherwise', async () => {
    const offered = await mountScreen({
      ...makeDeps(),
      canImportLegacyClaude: true,
    })
    let frame: string
    try {
      frame = offered.frame()
    } finally {
      await offered.cleanup()
    }
    // Ahead of the alphabetical list, not merged into it.
    expectInOrder(frame, ['Reuse Claude Code sign-in', 'Alibaba Coding Plan'])

    const hidden = await mountScreen(makeDeps())
    try {
      expect(hidden.frame()).not.toContain('Reuse Claude Code sign-in')
    } finally {
      await hidden.cleanup()
    }
  })

  test('only first-run offers the skip row, and the heading follows the mode', async () => {
    const firstRun = await mountScreen(makeDeps('first-run'))
    try {
      await firstRun.press(SEARCH)
      await firstRun.press('Skip')
      expect(firstRun.frame()).toContain('Skip for now')
    } finally {
      await firstRun.cleanup()
    }

    const manage = await mountScreen(makeDeps('manage'))
    try {
      await manage.press(SEARCH)
      await manage.press('Skip')
      expect(manage.frame()).not.toContain('Skip for now')
      expect(manage.frame()).toContain('No matches for')
    } finally {
      await manage.cleanup()
    }
  })

  test('the heading names the wizard in first-run and the menu action otherwise', async () => {
    const firstRun = await mountScreen(makeDeps('first-run'))
    try {
      expect(firstRun.frame()).toContain('Set up provider')
      expect(firstRun.frame()).not.toContain('Choose provider preset')
    } finally {
      await firstRun.cleanup()
    }

    const manage = await mountScreen(makeDeps('manage'))
    try {
      expect(manage.frame()).toContain('Choose provider preset')
      expect(manage.frame()).not.toContain('Set up provider')
    } finally {
      await manage.cleanup()
    }
  })

  test('Custom is pinned last, after the alphabetical tail', async () => {
    for (const columns of [110, 70]) {
      const ui = await mountScreen(makeDeps(), columns)
      try {
        await ui.press(SEARCH)
        await ui.press('OpenAI-compatible provider')
        const frame = ui.frame()
        // The query matches Custom's description only; Z.AI sorts before it
        // and would come first if Custom were merged alphabetically.
        expect(frame).toContain('Custom')
        expect(frame).not.toContain('Z.AI')
      } finally {
        await ui.cleanup()
      }
    }
  })
})

describe('PresetSelectionScreen routing', () => {
  test('the four hand-off presets open a screen instead of seeding a draft', async () => {
    const cases: Array<[string, string, Screen]> = [
      ['Codex', 'Codex OAuth', 'codex-oauth'],
      ['Grok', 'xAI / Grok (OAuth)', 'xai-oauth'],
      ['Moonshot', 'Moonshot AI', 'kimi-auth-choice'],
      ['Copilot', 'GitHub Copilot', 'github-onboard'],
    ]

    for (const [query, label, screen] of cases) {
      const deps = makeDeps()
      const ui = await mountScreen(deps)
      try {
        await selectByQuery(ui, query, label)
      } finally {
        await ui.cleanup()
      }

      expect(deps.setScreen.mock.calls).toEqual([[screen]])
      expect(deps.startCreateFromPreset).not.toHaveBeenCalled()
    }
  })

  test('an ordinary preset is forwarded to startCreateFromPreset by value', async () => {
    const deps = makeDeps()
    const ui = await mountScreen(deps)
    try {
      await selectByQuery(ui, 'Groq', 'Groq')
    } finally {
      await ui.cleanup()
    }

    // The row's `value`, not its label — they differ for most of the list.
    expect(deps.startCreateFromPreset.mock.calls).toEqual([['groq']])
    expect(deps.setScreen).not.toHaveBeenCalled()
  })

  test('skip closes the wizard as cancelled', async () => {
    const deps = makeDeps('first-run')
    const ui = await mountScreen(deps)
    try {
      await selectByQuery(ui, 'Skip', 'Skip for now')
    } finally {
      await ui.cleanup()
    }

    expect(deps.closeWithCancelled.mock.calls).toEqual([
      ['Provider setup skipped'],
    ])
    expect(deps.startCreateFromPreset).not.toHaveBeenCalled()
  })

  test('Esc closes the wizard in first-run but only returns to the menu in manage', async () => {
    const firstRun = makeDeps('first-run')
    const firstRunUi = await mountScreen(firstRun)
    try {
      await firstRunUi.pressEscape()
    } finally {
      await firstRunUi.cleanup()
    }
    expect(firstRun.closeWithCancelled.mock.calls).toEqual([
      ['Provider setup skipped'],
    ])
    expect(firstRun.returnToMenu).not.toHaveBeenCalled()

    const manage = makeDeps('manage')
    const manageUi = await mountScreen(manage)
    try {
      await manageUi.pressEscape()
    } finally {
      await manageUi.cleanup()
    }
    expect(manage.returnToMenu).toHaveBeenCalledTimes(1)
    expect(manage.closeWithCancelled).not.toHaveBeenCalled()
  })
})

type MigrationReport = { errors: string[] }

function mockMigration(options: {
  report: MigrationReport
  summary: string
  stillExists?: boolean
}): void {
  mock.module('src/platform/config/claudinMigration.js', () => ({
    ...realClaudinMigration,
    migrateLegacyClaudeDir: async () => options.report,
    legacyClaudeDirExists: () => options.stillExists ?? false,
    formatMigrationReport: () => options.summary,
  }))
}

function mockActiveProfile(profile: ProviderProfile | null): void {
  mock.module('src/providers/presets/providerProfiles.js', () => ({
    ...realProviderProfiles,
    getActiveProviderProfile: () => profile,
  }))
}

const MIGRATED_PROFILE = {
  id: 'prof-imported',
  name: 'Imported Anthropic',
  model: 'claude-sonnet-4-6',
} as unknown as ProviderProfile

describe('PresetSelectionScreen legacy import', () => {
  async function importLegacy(deps: ReturnType<typeof makeDeps>): Promise<void> {
    const ui = await mountScreen({ ...deps, canImportLegacyClaude: true })
    try {
      await selectByQuery(ui, 'Reuse', 'Reuse Claude Code sign-in')
      await Bun.sleep(80)
    } finally {
      await ui.cleanup()
    }
  }

  test('a report carrying errors surfaces the summary as an error and stops', async () => {
    mockMigration({
      report: { errors: ['could not read ~/.claude/.credentials.json'] },
      summary: 'Imported 0 of 3 items.',
      stillExists: true,
    })
    mockActiveProfile(MIGRATED_PROFILE)
    const deps = makeDeps('first-run')

    await importLegacy(deps)

    expect(deps.setErrorMessage.mock.calls).toEqual([['Imported 0 of 3 items.']])
    // The early return is what keeps a failed import from being announced as
    // a completed first-run.
    expect(deps.onDone).not.toHaveBeenCalled()
    expect(deps.setStatusMessage).not.toHaveBeenCalled()
    // The row is re-evaluated before the error path returns, so a still-present
    // ~/.claude keeps the affordance offered.
    expect(deps.setCanImportLegacyClaude.mock.calls).toEqual([[true]])
  })

  test('a clean import in first-run finishes through onDone', async () => {
    mockMigration({ report: { errors: [] }, summary: 'Imported 3 items.' })
    mockActiveProfile(MIGRATED_PROFILE)
    const deps = makeDeps('first-run')

    await importLegacy(deps)

    expect(deps.onDone.mock.calls).toEqual([
      [
        {
          action: 'saved',
          activeProfileId: MIGRATED_PROFILE.id,
          activeProviderName: MIGRATED_PROFILE.name,
          activeProviderModel: MIGRATED_PROFILE.model,
          message: 'Imported 3 items.',
        },
      ],
    ])
    expect(deps.returnToMenu).not.toHaveBeenCalled()
    expect(deps.setCanImportLegacyClaude.mock.calls).toEqual([[false]])
  })

  test('a clean import with nothing active falls through to the status message', async () => {
    mockMigration({ report: { errors: [] }, summary: 'Imported 1 item.' })
    mockActiveProfile(null)
    const deps = makeDeps('first-run')

    await importLegacy(deps)

    // No active profile means there is nothing to hand back, so first-run is
    // NOT completed even though the import succeeded.
    expect(deps.onDone).not.toHaveBeenCalled()
    expect(deps.setStatusMessage.mock.calls).toEqual([['Imported 1 item.']])
    expect(deps.returnToMenu).not.toHaveBeenCalled()
  })

  test('a clean import in manage mode reports and returns to the menu', async () => {
    mockMigration({ report: { errors: [] }, summary: 'Imported 2 items.' })
    mockActiveProfile(MIGRATED_PROFILE)
    const deps = makeDeps('manage')

    await importLegacy(deps)

    expect(deps.setStatusMessage.mock.calls).toEqual([['Imported 2 items.']])
    expect(deps.setErrorMessage.mock.calls).toEqual([[undefined]])
    expect(deps.returnToMenu).toHaveBeenCalledTimes(1)
    expect(deps.onDone).not.toHaveBeenCalled()
    expect(deps.refreshProfiles).toHaveBeenCalledTimes(1)
  })
})
