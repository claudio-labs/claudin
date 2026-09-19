import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'

import { lastFrame, mountHook } from 'src/providers/ui/__testutils__/inkHookHarness.js'
import type {
  DraftField,
  ProviderDraft,
  Screen,
} from 'src/providers/ui/ProviderManager.types.js'
import {
  AtomicChatSelectionScreen,
  type LocalModelSelectionScreenProps,
  OllamaSelectionScreen,
  OpenAiModelSelectionScreen,
  type OpenAiModelSelectionScreenProps,
} from 'src/providers/ui/screens/ModelSelection.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'

const ENTER = '\r'
const DOWN = 'j'

const DRAFT: ProviderDraft = {
  name: 'Local',
  baseUrl: 'http://127.0.0.1:1234/v1',
  model: 'seed-model',
  apiKey: '',
}

/**
 * The payoff of the narrow props type: every screen under test takes its whole
 * world as props, so one factory of `mock()` callbacks covers all three and a
 * test overrides only the field it is about.
 */
function makeLocalDeps(selection: LocalModelSelectionScreenProps['selection']) {
  return {
    selection,
    draft: { ...DRAFT },
    setDraft: mock((_draft: ProviderDraft) => {}),
    setScreen: mock((_screen: Screen) => {}),
    setFormStepIndex: mock((_index: number) => {}),
    setCursorOffset: mock((_offset: number) => {}),
    persistDraft: mock((_draft: ProviderDraft) => {}),
  }
}

function makeOpenAiDeps(
  openAiModelSelection: OpenAiModelSelectionScreenProps['openAiModelSelection'],
) {
  return {
    openAiModelSelection,
    draft: { ...DRAFT },
    setDraft: mock((_draft: ProviderDraft) => {}),
    goToFormStep: mock((_key: DraftField) => {}),
    goToManualModelStep: mock(() => {}),
    finishAfterModelStep: mock((_draft: ProviderDraft) => {}),
  }
}

function wrap(node: React.ReactNode): React.ReactNode {
  return (
    <AppStateProvider>
      <KeybindingSetup>{node}</KeybindingSetup>
    </AppStateProvider>
  )
}

/**
 * A frame from a real root rather than from `renderToString`.
 *
 * Every screen here mounts a `Select`, which puts stdin in raw mode. Under
 * `renderToString` that is the PROCESS stdin, so Ink logs "Raw mode is not
 * supported", `waitUntilExit()` never resolves and each frame costs the
 * helper's full 3s fallback. `mountHook`'s throwaway stdin supports raw mode,
 * so the frame is both clean and immediate.
 */
async function frameOf(node: React.ReactNode, columns = 100): Promise<string> {
  const ui = await mountScreen(node, columns)
  try {
    return ui.frame()
  } finally {
    await ui.cleanup()
  }
}

/** A real root, for the assertions about which callback a keypress fires. */
async function mountScreen(
  node: React.ReactNode,
  columns = 100,
): Promise<{
  press: (keys: string) => Promise<void>
  pressEscape: () => Promise<void>
  frame: () => string
  cleanup: () => Promise<void>
}> {
  const mounted = await mountHook(wrap(node), { columns })
  await Bun.sleep(40)
  return {
    press: async (keys: string) => {
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
    cleanup: mounted.cleanup,
  }
}

/**
 * Sibling `<Text>` in a row Box wrap as independent columns, so a bare
 * `toContain` passes on a render whose fragments got interleaved across rows.
 * Assert order over the whitespace-flattened frame instead.
 */
function expectInOrder(frame: string, fragments: string[]): void {
  let rest = frame.replace(/\s+/g, ' ')
  for (const fragment of fragments) {
    expect(rest).toContain(fragment)
    rest = rest.slice(rest.indexOf(fragment) + fragment.length)
  }
}

const READY_ATOMIC: LocalModelSelectionScreenProps['selection'] = {
  state: 'ready',
  defaultValue: 'beta-model',
  options: [
    { value: 'alpha-model', label: 'alpha-model' },
    { value: 'beta-model', label: 'beta-model' },
    { value: 'gamma-model', label: 'gamma-model' },
  ],
}

describe('AtomicChatSelectionScreen', () => {
  test('idle and loading both render the probe, and offer no escape hatch yet', async () => {
    for (const state of ['idle', 'loading'] as const) {
      const deps = makeLocalDeps({ state })
      const frame = await frameOf(<AtomicChatSelectionScreen {...deps} />)

      expect(frame).toContain('Looking for loaded Atomic Chat models...')
      // The manual/back rows belong to `unavailable`. Seeing them here would
      // mean the two states fell through to the wrong arm.
      expect(frame).not.toContain('Enter manually')
      expect(frame).not.toContain('Choose an Atomic Chat model')
    }
  })

  test('unavailable surfaces the probe message rather than a generic one', async () => {
    const deps = makeLocalDeps({
      state: 'unavailable',
      message: 'Nothing is listening on 127.0.0.1:1234.',
    })
    const frame = await frameOf(<AtomicChatSelectionScreen {...deps} />)

    expectInOrder(frame, [
      'Atomic Chat setup',
      'Nothing is listening on 127.0.0.1:1234.',
      'Enter manually',
      'Back',
    ])
  })

  test('the manual escape resumes the form at step 0 with the cursor past the name', async () => {
    const deps = makeLocalDeps({ state: 'unavailable', message: 'no models' })
    const ui = await mountScreen(<AtomicChatSelectionScreen {...deps} />)
    try {
      await ui.press(ENTER)
    } finally {
      await ui.cleanup()
    }

    expect(deps.setFormStepIndex.mock.calls).toEqual([[0]])
    // The cursor lands at the end of the name the preset filled in, not at 0.
    expect(deps.setCursorOffset.mock.calls).toEqual([[DRAFT.name.length]])
    expect(deps.setScreen.mock.calls).toEqual([['form']])
  })

  test('the back row returns to the preset list without touching the form', async () => {
    const deps = makeLocalDeps({ state: 'unavailable', message: 'no models' })
    const ui = await mountScreen(<AtomicChatSelectionScreen {...deps} />)
    try {
      await ui.press(DOWN)
      await ui.press(ENTER)
    } finally {
      await ui.cleanup()
    }

    expect(deps.setScreen.mock.calls).toEqual([['select-preset']])
    expect(deps.setFormStepIndex).not.toHaveBeenCalled()
    expect(deps.setCursorOffset).not.toHaveBeenCalled()
  })

  test('the ready list opens on defaultValue, not on the first row', async () => {
    const deps = makeLocalDeps(READY_ATOMIC)
    const ui = await mountScreen(<AtomicChatSelectionScreen {...deps} />)
    try {
      await ui.press(ENTER)
    } finally {
      await ui.cleanup()
    }

    expect(deps.persistDraft.mock.calls).toEqual([
      [{ ...DRAFT, model: 'beta-model' }],
    ])
  })

  test('choosing a model keeps the rest of the draft and persists the same object', async () => {
    const deps = makeLocalDeps(READY_ATOMIC)
    const ui = await mountScreen(<AtomicChatSelectionScreen {...deps} />)
    try {
      await ui.press(DOWN)
      await ui.press(ENTER)
    } finally {
      await ui.cleanup()
    }

    const expected = { ...DRAFT, model: 'gamma-model' }
    expect(deps.setDraft.mock.calls).toEqual([[expected]])
    // setDraft is async; persisting the state value instead of `nextDraft`
    // would save the previous model.
    expect(deps.persistDraft.mock.calls).toEqual([[expected]])
  })

  test('Esc on the ready list backs out to the preset picker', async () => {
    const deps = makeLocalDeps(READY_ATOMIC)
    const ui = await mountScreen(<AtomicChatSelectionScreen {...deps} />)
    try {
      await ui.pressEscape()
    } finally {
      await ui.cleanup()
    }

    expect(deps.setScreen.mock.calls).toEqual([['select-preset']])
    expect(deps.persistDraft).not.toHaveBeenCalled()
  })
})

describe('OllamaSelectionScreen', () => {
  test('reads the same props type but renders its own copy', async () => {
    const deps = makeLocalDeps({ state: 'loading' })
    const frame = await frameOf(<OllamaSelectionScreen {...deps} />)

    expect(frame).toContain('Looking for installed Ollama models...')
    expect(frame).not.toContain('Atomic Chat')
  })

  test('unavailable keeps the manual and back rows', async () => {
    const deps = makeLocalDeps({
      state: 'unavailable',
      message: 'Ollama is installed but has no models pulled.',
    })
    const frame = await frameOf(<OllamaSelectionScreen {...deps} />)

    expectInOrder(frame, [
      'Ollama setup',
      'Ollama is installed but has no models pulled.',
      'Enter manually',
      'Back',
    ])
  })

  test('choosing a model persists the draft with that model', async () => {
    const deps = makeLocalDeps({
      state: 'ready',
      defaultValue: 'llama3.1:8b',
      options: [
        { value: 'llama3.1:8b', label: 'llama3.1:8b' },
        { value: 'qwen3:4b', label: 'qwen3:4b' },
      ],
    })
    const ui = await mountScreen(<OllamaSelectionScreen {...deps} />)
    try {
      await ui.press(ENTER)
    } finally {
      await ui.cleanup()
    }

    expect(deps.persistDraft.mock.calls).toEqual([
      [{ ...DRAFT, model: 'llama3.1:8b' }],
    ])
  })
})

const READY_OPENAI = {
  state: 'ready' as const,
  defaultValue: 'gpt-5-mini',
  options: [
    { value: 'gpt-5-mini', label: 'gpt-5-mini' },
    { value: 'gpt-5', label: 'gpt-5' },
  ],
}

describe('OpenAiModelSelectionScreen', () => {
  test('while discovering, it points at Esc instead of showing rows', async () => {
    const deps = makeOpenAiDeps({ state: 'loading' })
    const frame = await frameOf(<OpenAiModelSelectionScreen {...deps} />)

    expect(frame).toContain('Press Esc to enter the model manually.')
    expect(frame).not.toContain('Enter a model id manually')
  })

  test('a failed discovery routes manual to the model step and back to the key step', async () => {
    const failed = { state: 'unavailable' as const, message: '404 from /models' }

    const manual = makeOpenAiDeps(failed)
    const manualUi = await mountScreen(<OpenAiModelSelectionScreen {...manual} />)
    try {
      await manualUi.press(ENTER)
    } finally {
      await manualUi.cleanup()
    }
    expect(manual.goToManualModelStep).toHaveBeenCalledTimes(1)
    expect(manual.goToFormStep).not.toHaveBeenCalled()

    const back = makeOpenAiDeps(failed)
    const backUi = await mountScreen(<OpenAiModelSelectionScreen {...back} />)
    try {
      await backUi.press(DOWN)
      await backUi.press(ENTER)
    } finally {
      await backUi.cleanup()
    }
    // Back goes to the API key step, not to the preset list — this screen is
    // reached from inside the form.
    expect(back.goToFormStep.mock.calls).toEqual([['apiKey']])
    expect(back.goToManualModelStep).not.toHaveBeenCalled()
  })

  test('Esc returns to the API key step from either state', async () => {
    const failed = makeOpenAiDeps({
      state: 'unavailable',
      message: '404 from /models',
    })
    const failedUi = await mountScreen(<OpenAiModelSelectionScreen {...failed} />)
    try {
      await failedUi.pressEscape()
    } finally {
      await failedUi.cleanup()
    }
    expect(failed.goToFormStep.mock.calls).toEqual([['apiKey']])

    const ready = makeOpenAiDeps(READY_OPENAI)
    const readyUi = await mountScreen(<OpenAiModelSelectionScreen {...ready} />)
    try {
      await readyUi.pressEscape()
    } finally {
      await readyUi.cleanup()
    }
    // Esc on a populated list must not count as picking the focused row.
    expect(ready.goToFormStep.mock.calls).toEqual([['apiKey']])
    expect(ready.finishAfterModelStep).not.toHaveBeenCalled()
    expect(ready.setDraft).not.toHaveBeenCalled()
  })

  test('the manual sentinel is appended after every discovered id', async () => {
    for (const columns of [100, 60]) {
      const deps = makeOpenAiDeps(READY_OPENAI)
      const frame = await frameOf(
        <OpenAiModelSelectionScreen {...deps} />,
        columns,
      )

      expectInOrder(frame, [
        'gpt-5-mini',
        'gpt-5',
        'Enter a model id manually',
      ])
    }
  })

  test('with no defaultValue the focus falls back to the manual sentinel', async () => {
    const deps = makeOpenAiDeps({
      state: 'ready',
      options: [{ value: 'only-model', label: 'only-model' }],
    })
    const ui = await mountScreen(<OpenAiModelSelectionScreen {...deps} />)
    try {
      await ui.press(ENTER)
    } finally {
      await ui.cleanup()
    }

    // Focus sits on the sentinel, so Enter types an id rather than silently
    // accepting a model the user never looked at.
    expect(deps.goToManualModelStep).toHaveBeenCalledTimes(1)
    expect(deps.finishAfterModelStep).not.toHaveBeenCalled()
    expect(deps.setDraft).not.toHaveBeenCalled()
  })

  test('choosing a discovered id finishes the step with the updated draft', async () => {
    const deps = makeOpenAiDeps(READY_OPENAI)
    const ui = await mountScreen(<OpenAiModelSelectionScreen {...deps} />)
    try {
      await ui.press(ENTER)
    } finally {
      await ui.cleanup()
    }

    const expected = { ...DRAFT, model: 'gpt-5-mini' }
    expect(deps.setDraft.mock.calls).toEqual([[expected]])
    expect(deps.finishAfterModelStep.mock.calls).toEqual([[expected]])
    expect(deps.goToManualModelStep).not.toHaveBeenCalled()
  })

  test('selecting the sentinel from a populated list still types an id', async () => {
    const deps = makeOpenAiDeps(READY_OPENAI)
    const ui = await mountScreen(<OpenAiModelSelectionScreen {...deps} />)
    try {
      await ui.press(DOWN)
      await ui.press(DOWN)
      await ui.press(ENTER)
    } finally {
      await ui.cleanup()
    }

    expect(deps.goToManualModelStep).toHaveBeenCalledTimes(1)
    expect(deps.finishAfterModelStep).not.toHaveBeenCalled()
  })
})
