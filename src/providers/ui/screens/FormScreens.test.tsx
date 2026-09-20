import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'

import type { ProviderProfile } from 'src/platform/config/config.js'
import { lastFrame, mountHook } from 'src/providers/ui/__testutils__/inkHookHarness.js'
import type { ProviderPreset } from 'src/providers/presets/providerProfiles.js'
import type {
  CloudExtrasDraft,
  ProviderDraft,
  Screen,
} from 'src/providers/ui/ProviderManager.types.js'
import {
  CloudExtrasScreen,
  CustomHeadersScreen,
  FormScreen,
} from 'src/providers/ui/screens/FormScreens.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'

const ENTER = '\r'

// FORM_STEPS, by index: 0 name, 1 baseUrl, 2 apiKey, 3 model.
const STEP_BASE_URL = 1
const STEP_API_KEY = 2

const DRAFT: ProviderDraft = {
  name: 'Work OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5',
  apiKey: 'sk-do-not-print-me',
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
  frame: () => string
  cleanup: () => Promise<void>
}

/**
 * A real root rather than `renderToString`: these screens mount a `TextInput`,
 * which puts stdin in raw mode, and the process stdin under `bun test` does
 * not support it. The one exception is the CloudExtras null branch, which
 * mounts nothing at all.
 */
async function mountScreen(node: React.ReactNode, columns = 100): Promise<Ui> {
  const mounted = await mountHook(wrap(node), { columns })
  await Bun.sleep(50)
  return {
    press: async (keys: string) => {
      mounted.streams.stdin.write(keys)
      await Bun.sleep(60)
    },
    frame: () => lastFrame(mounted.streams.getOutput()),
    cleanup: mounted.cleanup,
  }
}

async function frameOf(node: React.ReactNode, columns = 100): Promise<string> {
  const ui = await mountScreen(node, columns)
  try {
    return ui.frame()
  } finally {
    await ui.cleanup()
  }
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

function makeFormDeps(overrides?: {
  formStepIndex?: number
  draft?: ProviderDraft
  editingProfileId?: string | null
  draftProvider?: ProviderProfile['provider']
  errorMessage?: string
}) {
  return {
    formStepIndex: overrides?.formStepIndex ?? 0,
    draft: overrides?.draft ?? { ...DRAFT },
    setDraft: mock((_next: React.SetStateAction<ProviderDraft>) => {}),
    setCursorOffset: mock((_offset: number) => {}),
    cursorOffset: 0,
    editingProfileId: overrides?.editingProfileId ?? null,
    draftProvider: overrides?.draftProvider ?? ('openai' as const),
    errorMessage: overrides?.errorMessage,
    handleFormSubmit: mock((_value: string) => {}),
  }
}

describe('FormScreen', () => {
  test('the heading tells a create apart from an edit', async () => {
    const create = await frameOf(<FormScreen {...makeFormDeps()} />)
    expect(create).toContain('Create provider profile')
    expect(create).not.toContain('Edit provider profile')

    const edit = await frameOf(
      <FormScreen {...makeFormDeps({ editingProfileId: 'prof-1' })} />,
    )
    expect(edit).toContain('Edit provider profile')
    expect(edit).not.toContain('Create provider profile')
  })

  test('the provider-type line follows the transport, not the preset name', async () => {
    const anthropic = await frameOf(
      <FormScreen {...makeFormDeps({ draftProvider: 'anthropic' })} />,
    )
    expect(anthropic).toContain('Anthropic native API')

    for (const provider of ['openai', 'bedrock'] as const) {
      const frame = await frameOf(
        <FormScreen {...makeFormDeps({ draftProvider: provider })} />,
      )
      // Everything that is not the native API reads as OpenAI-compatible,
      // including the cloud transports.
      expect(frame).toContain('OpenAI-compatible API')
      expect(frame).not.toContain('Anthropic native API')
    }
  })

  test('the step is derived from formStepIndex, and counts from 1', async () => {
    const frame = await frameOf(
      <FormScreen {...makeFormDeps({ formStepIndex: STEP_BASE_URL })} />,
    )

    expectInOrder(frame, [
      'API base URL used for this provider profile.',
      'Step 2 of 4: Base URL',
    ])
    expect(frame).not.toContain('Step 1 of 4')
  })

  test('an out-of-range step index falls back to the first step', async () => {
    const frame = await frameOf(
      <FormScreen {...makeFormDeps({ formStepIndex: 99 })} />,
    )

    // `FORM_STEPS[formStepIndex] ?? FORM_STEPS[0]` — without the fallback this
    // frame is a crash, not a wrong label.
    expect(frame).toContain('Provider name')
    expect(frame).toContain(DRAFT.name)
  })

  test('the API key step masks its value; the other steps show theirs', async () => {
    const masked = await frameOf(
      <FormScreen {...makeFormDeps({ formStepIndex: STEP_API_KEY })} />,
    )
    expect(masked).not.toContain('sk-do-not-print-me')
    // The input reveals a head and a tail and masks the middle, so the guard
    // is the secret body being absent, not a full-width run of stars.
    expect(masked).toContain('****')
    expect(masked).not.toContain('do-not-print')

    const plain = await frameOf(
      <FormScreen {...makeFormDeps({ formStepIndex: STEP_BASE_URL })} />,
    )
    expect(plain).toContain(DRAFT.baseUrl)
  })

  test('an error message is rendered only while one is set', async () => {
    const withError = await frameOf(
      <FormScreen {...makeFormDeps({ errorMessage: 'Base URL is required.' })} />,
    )
    expect(withError).toContain('Base URL is required.')

    const clean = await frameOf(<FormScreen {...makeFormDeps()} />)
    expect(clean).not.toContain('is required.')
  })

  test('Enter submits the typed value, not the draft it started from', async () => {
    const deps = makeFormDeps({
      formStepIndex: STEP_BASE_URL,
      draft: { ...DRAFT, baseUrl: '' },
    })
    const ui = await mountScreen(<FormScreen {...deps} />)
    try {
      await ui.press(`http://localhost:1234/v1${ENTER}`)
    } finally {
      await ui.cleanup()
    }

    expect(deps.handleFormSubmit.mock.calls).toEqual([
      ['http://localhost:1234/v1'],
    ])
  })

  test('typing updates the field the current step names, keeping the others', async () => {
    const deps = makeFormDeps({
      formStepIndex: STEP_BASE_URL,
      draft: { ...DRAFT, baseUrl: '' },
    })
    const ui = await mountScreen(<FormScreen {...deps} />)
    try {
      await ui.press('h')
    } finally {
      await ui.cleanup()
    }

    const updater = deps.setDraft.mock.calls[0]?.[0]
    expect(typeof updater).toBe('function')
    // The key is computed from the step, so a hardcoded one would survive a
    // frame assertion but not this.
    expect((updater as (prev: ProviderDraft) => ProviderDraft)(DRAFT)).toEqual({
      ...DRAFT,
      baseUrl: 'h',
    })
  })
})

function makeCloudDeps(overrides?: {
  pendingPreset?: ProviderPreset | null
  cloudExtrasStepIndex?: number
  draftExtras?: CloudExtrasDraft
  errorMessage?: string
}) {
  // `??` would swallow an explicit null, which is exactly the case the
  // "renders nothing" test is about.
  const hasPreset = overrides !== undefined && 'pendingPreset' in overrides
  return {
    pendingPreset: hasPreset
      ? (overrides.pendingPreset ?? null)
      : ('bedrock' as ProviderPreset),
    cloudExtrasStepIndex: overrides?.cloudExtrasStepIndex ?? 0,
    draftExtras: overrides?.draftExtras ?? {},
    cloudExtrasCursor: 0,
    errorMessage: overrides?.errorMessage,
    setDraftExtras: mock((_next: React.SetStateAction<CloudExtrasDraft>) => {}),
    setCloudExtrasStepIndex: mock((_index: number) => {}),
    setCloudExtrasCursor: mock((_offset: number) => {}),
    setErrorMessage: mock((_message: string | undefined) => {}),
    setScreen: mock((_screen: Screen) => {}),
  }
}

describe('CloudExtrasScreen', () => {
  test('a preset with no cloud credentials renders nothing at all', async () => {
    for (const preset of [null, 'openai', 'ollama'] as const) {
      // The one branch that mounts nothing, so it is also the one branch the
      // static renderer can take: no TextInput, no raw mode, no providers.
      const frame = await renderToString(
        <CloudExtrasScreen
          {...makeCloudDeps({ pendingPreset: preset as ProviderPreset | null })}
        />,
        100,
      )
      // Not "renders a different title" — the screen paints nothing, so
      // ProviderManager's cloud-extras arm is inert for these presets.
      expect(frame.trim()).toBe('')
    }
  })

  test('each cloud preset gets its own title and its own first step', async () => {
    const cases: Array<[ProviderPreset, string, string]> = [
      ['bedrock' as ProviderPreset, 'AWS Bedrock setup', 'Step 1 of 1: AWS region'],
      ['vertex' as ProviderPreset, 'Google Vertex AI setup', 'Step 1 of 2: GCP project ID'],
      ['foundry' as ProviderPreset, 'Azure AI Foundry setup', 'Step 1 of 1: Azure resource'],
    ]

    for (const [preset, title, step] of cases) {
      const frame = await frameOf(
        <CloudExtrasScreen {...makeCloudDeps({ pendingPreset: preset })} />,
      )
      expectInOrder(frame, [title, step])
    }
  })

  test('an out-of-range step index falls back to the first step', async () => {
    const frame = await frameOf(
      <CloudExtrasScreen
        {...makeCloudDeps({
          pendingPreset: 'vertex' as ProviderPreset,
          cloudExtrasStepIndex: 7,
        })}
      />,
    )

    expect(frame).toContain('GCP project ID')
  })

  test('a blank submit is refused by name and stores nothing', async () => {
    const deps = makeCloudDeps({ pendingPreset: 'vertex' as ProviderPreset })
    const ui = await mountScreen(<CloudExtrasScreen {...deps} />)
    try {
      await ui.press(ENTER)
    } finally {
      await ui.cleanup()
    }

    expect(deps.setErrorMessage.mock.calls).toEqual([
      ['GCP project ID is required.'],
    ])
    expect(deps.setDraftExtras).not.toHaveBeenCalled()
    expect(deps.setCloudExtrasStepIndex).not.toHaveBeenCalled()
    expect(deps.setScreen).not.toHaveBeenCalled()
  })

  test('a filled step is trimmed, merged into the extras and advances', async () => {
    const deps = makeCloudDeps({
      pendingPreset: 'vertex' as ProviderPreset,
      draftExtras: { gcpRegion: 'us-central1' },
    })
    const ui = await mountScreen(<CloudExtrasScreen {...deps} />)
    try {
      await ui.press(`  my-project-123  ${ENTER}`)
    } finally {
      await ui.cleanup()
    }

    // Every keystroke also calls setDraftExtras with an updater; the submit is
    // the last call and the only one that passes a finished object.
    expect(deps.setDraftExtras.mock.calls.at(-1)?.[0]).toEqual({
      gcpRegion: 'us-central1',
      gcpProject: 'my-project-123',
    })
    expect(deps.setErrorMessage.mock.calls).toEqual([[undefined]])
    expect(deps.setCloudExtrasStepIndex.mock.calls).toEqual([[1]])
    // Vertex has a second step, so the form is still ahead.
    expect(deps.setScreen).not.toHaveBeenCalled()
  })

  test('the last step rewinds the counter and hands over to the form', async () => {
    const deps = makeCloudDeps({
      pendingPreset: 'vertex' as ProviderPreset,
      cloudExtrasStepIndex: 1,
    })
    const ui = await mountScreen(<CloudExtrasScreen {...deps} />)
    try {
      await ui.press(`us-central1${ENTER}`)
    } finally {
      await ui.cleanup()
    }

    // Rewound, so re-entering cloud-extras later starts at step 1 again.
    expect(deps.setCloudExtrasStepIndex.mock.calls).toEqual([[0]])
    expect(deps.setScreen.mock.calls).toEqual([['form']])
  })

  test('a single-step preset reaches the form on its first submit', async () => {
    const deps = makeCloudDeps({ pendingPreset: 'bedrock' as ProviderPreset })
    const ui = await mountScreen(<CloudExtrasScreen {...deps} />)
    try {
      await ui.press(`us-east-1${ENTER}`)
    } finally {
      await ui.cleanup()
    }

    expect(deps.setDraftExtras.mock.calls.at(-1)?.[0]).toEqual({
      awsRegion: 'us-east-1',
    })
    expect(deps.setScreen.mock.calls).toEqual([['form']])
  })

  test('an error message is rendered only while one is set', async () => {
    const withError = await frameOf(
      <CloudExtrasScreen
        {...makeCloudDeps({ errorMessage: 'AWS region is required.' })}
      />,
    )
    expect(withError).toContain('AWS region is required.')

    const clean = await frameOf(<CloudExtrasScreen {...makeCloudDeps()} />)
    expect(clean).not.toContain('is required.')
  })
})

function makeHeadersDeps(overrides?: {
  draftCustomHeaders?: string
  errorMessage?: string
}) {
  return {
    draftCustomHeaders: overrides?.draftCustomHeaders ?? '',
    draft: { ...DRAFT },
    customHeadersCursor: 0,
    errorMessage: overrides?.errorMessage,
    setDraftCustomHeaders: mock((_value: string) => {}),
    setCustomHeadersCursor: mock((_offset: number) => {}),
    persistDraft: mock((_draft: ProviderDraft) => {}),
  }
}

describe('CustomHeadersScreen', () => {
  test('submitting saves the draft it was handed, headers and all', async () => {
    const deps = makeHeadersDeps()
    const ui = await mountScreen(<CustomHeadersScreen {...deps} />)
    try {
      await ui.press(ENTER)
    } finally {
      await ui.cleanup()
    }

    // The screen owns no draft of its own — skipping the step still has to
    // save, or the profile is lost at the last step.
    expect(deps.persistDraft.mock.calls).toEqual([[DRAFT]])
  })

  test('typing is reported verbatim, with no parsing in the way', async () => {
    const deps = makeHeadersDeps()
    const ui = await mountScreen(<CustomHeadersScreen {...deps} />)
    try {
      await ui.press('X')
    } finally {
      await ui.cleanup()
    }

    // `onChange={setDraftCustomHeaders}` — the raw text reaches the caller and
    // parseCustomHeaders runs later, at save time.
    expect(deps.setDraftCustomHeaders.mock.calls).toEqual([['X']])
    expect(deps.persistDraft).not.toHaveBeenCalled()
  })

  test('an error message is rendered only while one is set', async () => {
    const withError = await frameOf(
      <CustomHeadersScreen
        {...makeHeadersDeps({ errorMessage: 'Could not save provider.' })}
      />,
    )
    expect(withError).toContain('Could not save provider.')

    const clean = await frameOf(<CustomHeadersScreen {...makeHeadersDeps()} />)
    expect(clean).not.toContain('Could not save provider.')
  })
})
