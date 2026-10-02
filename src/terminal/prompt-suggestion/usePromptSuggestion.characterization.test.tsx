/**
 * Characterization of usePromptSuggestion, the prompt box's view of the
 * suggestion held in app state: what it shows, and how showing, accepting,
 * submitting and dismissing move that state.
 *
 * The hook runs in a real Ink tree over a fake TTY, with real app state. A
 * small host renders it and keeps the latest result where the test can call
 * it, the way PromptInput calls it.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { createFakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot, Text } from 'src/terminal/ink.js'
import { usePromptSuggestion } from 'src/terminal/prompt-suggestion/usePromptSuggestion.js'
import { AppStateProvider, useAppStateStore } from 'src/terminal/state/AppState.js'
import { type AppState, type AppStateStore, getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

const SLOW = 15_000

type Hook = ReturnType<typeof usePromptSuggestion>
type Seen = { hook?: Hook; store?: AppStateStore; renders: number }
type Props = { inputValue: string; isAssistantResponding: boolean }

function Host({ seen, ...props }: Props & { seen: Seen }): React.ReactNode {
  seen.hook = usePromptSuggestion(props)
  seen.store = useAppStateStore()
  seen.renders += 1
  return <Text>{`${seen.hook.suggestion ?? '-'}|${seen.hook.promptSuggestionGhostRemainder ?? '-'}`}</Text>
}

type Mounted = {
  hook: () => Hook
  suggestionState: () => AppState['promptSuggestion']
  rerender: (props: Props) => Promise<void>
  act: (call: (hook: Hook) => void) => Promise<void>
}

const open: Array<() => void> = []
afterEach(() => {
  while (open.length) open.pop()?.()
})

async function mount(
  suggestion: Partial<AppState['promptSuggestion']>,
  props: Props = { inputValue: '', isAssistantResponding: false },
): Promise<Mounted> {
  const terminal = createFakeTerminal()
  const root = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, patchConsole: false, exitOnCtrlC: false })
  const seen: Seen = { renders: 0 }
  const initial = getDefaultAppState()
  const initialState = {
    ...initial,
    promptSuggestion: { ...initial.promptSuggestion, ...suggestion },
  } as AppState
  const draw = (next: Props) =>
    root.render(
      <AppStateProvider initialState={initialState}>
        <Host seen={seen} {...next} />
      </AppStateProvider>,
    )
  draw(props)
  open.push(() => {
    root.unmount()
    terminal.close()
  })
  const settle = async () => {
    const before = seen.renders
    await Bun.sleep(30)
    for (let i = 0; i < 20 && seen.renders === before; i++) await Bun.sleep(10)
  }
  for (let i = 0; i < 200 && !seen.hook; i++) await Bun.sleep(10)
  return {
    hook: () => seen.hook as Hook,
    suggestionState: () => (seen.store as AppStateStore).getState().promptSuggestion,
    rerender: async next => {
      draw(next)
      await settle()
    },
    act: async call => {
      call(seen.hook as Hook)
      await Bun.sleep(40)
    },
  }
}

const offered = (text: string, shownAt = 0, acceptedAt = 0) => ({
  text,
  promptId: 'user_intent' as const,
  shownAt,
  acceptedAt,
  generationRequestId: 'req_1',
})

describe('what the hook shows', () => {
  const cases: Array<{ when: string; text: string | null; input: string; responding: boolean; suggestion: string | null; ghost: string | null }> = [
    { when: 'an empty prompt', text: 'Run the tests', input: '', responding: false, suggestion: 'Run the tests', ghost: 'Run the tests' },
    { when: 'a typed prefix, in any case', text: 'Run the tests', input: 'run t', responding: false, suggestion: null, ghost: 'he tests' },
    { when: 'text that has left the suggestion', text: 'Run the tests', input: 'push', responding: false, suggestion: null, ghost: null },
    { when: 'the assistant still responding', text: 'Run the tests', input: '', responding: true, suggestion: null, ghost: null },
    { when: 'no suggestion at all', text: null, input: '', responding: false, suggestion: null, ghost: null },
  ]
  for (const { when, text, input, responding, suggestion, ghost } of cases) {
    test(
      `with ${when}`,
      async () => {
        const hooked = await mount({ ...offered(text ?? ''), text }, { inputValue: input, isAssistantResponding: responding })
        expect(hooked.hook().suggestion).toBe(suggestion)
        expect(hooked.hook().promptSuggestionGhostRemainder).toBe(ghost)
      },
      SLOW,
    )
  }
})

describe('markShown', () => {
  test(
    'stamps the first showing only',
    async () => {
      const hooked = await mount(offered('run the tests'))
      const before = Date.now()
      await hooked.act(h => h.markShown())
      const firstShown = hooked.suggestionState().shownAt
      expect(firstShown).toBeGreaterThanOrEqual(before)
      await Bun.sleep(5)
      await hooked.act(h => h.markShown())
      expect(hooked.suggestionState().shownAt).toBe(firstShown)
    },
    SLOW,
  )

  test(
    'does nothing without a suggestion',
    async () => {
      const hooked = await mount({ text: null })
      await hooked.act(h => h.markShown())
      expect(hooked.suggestionState().shownAt).toBe(0)
    },
    SLOW,
  )
})

describe('markAccepted', () => {
  test(
    'ignores a suggestion that was never shown',
    async () => {
      const hooked = await mount(offered('run the tests'))
      await hooked.act(h => h.markAccepted())
      expect(hooked.suggestionState().acceptedAt).toBe(0)
    },
    SLOW,
  )

  test(
    'stamps the acceptance once, so Tab then Enter keeps the Tab time',
    async () => {
      const hooked = await mount(offered('run the tests', Date.now() - 1_000))
      await hooked.act(h => h.markAccepted())
      const accepted = hooked.suggestionState().acceptedAt
      expect(accepted).toBeGreaterThan(hooked.suggestionState().shownAt)
      await Bun.sleep(5)
      await hooked.act(h => h.markAccepted())
      expect(hooked.suggestionState().acceptedAt).toBe(accepted)
    },
    SLOW,
  )

  test(
    'an acceptance stamped before the showing is replaced',
    async () => {
      const shownAt = Date.now() - 1_000
      const hooked = await mount(offered('run the tests', shownAt, shownAt - 500))
      await hooked.act(h => h.markAccepted())
      expect(hooked.suggestionState().acceptedAt).toBeGreaterThan(shownAt)
    },
    SLOW,
  )
})

describe('resetSuggestion and logOutcomeAtSubmission', () => {
  const EMPTY = { text: null, promptId: null, shownAt: 0, acceptedAt: 0, generationRequestId: null }

  test(
    'resetSuggestion clears every field',
    async () => {
      const hooked = await mount(offered('run the tests', 5, 9))
      await hooked.act(h => h.resetSuggestion())
      expect(hooked.suggestionState()).toEqual(EMPTY)
    },
    SLOW,
  )

  test(
    'submitting clears a shown suggestion, accepted or not',
    async () => {
      for (const [finalInput, acceptedAt] of [
        ['run the tests', 0],
        ['something else', 0],
        ['run the tests', Date.now()],
      ] as const) {
        const hooked = await mount(offered('run the tests', Date.now() - 1_000, acceptedAt))
        await hooked.act(h => h.logOutcomeAtSubmission(finalInput))
        expect(hooked.suggestionState()).toEqual(EMPTY)
      }
    },
    SLOW,
  )

  test(
    'submitting with skipReset keeps the suggestion',
    async () => {
      const hooked = await mount(offered('run the tests', 100))
      await hooked.act(h => h.logOutcomeAtSubmission('run the tests', { skipReset: true }))
      expect(hooked.suggestionState().text).toBe('run the tests')
    },
    SLOW,
  )

  test(
    'submitting leaves an unshown suggestion alone',
    async () => {
      const hooked = await mount(offered('run the tests'))
      await hooked.act(h => h.logOutcomeAtSubmission('run the tests'))
      expect(hooked.suggestionState().text).toBe('run the tests')
    },
    SLOW,
  )
})

describe('across renders', () => {
  test(
    'typing after the suggestion shows, then a fresh suggestion, then clearing it, keeps the hook usable',
    async () => {
      const hooked = await mount(offered('run the tests', 50))
      await hooked.rerender({ inputValue: 'r', isAssistantResponding: false })
      expect(hooked.hook().promptSuggestionGhostRemainder).toBe('un the tests')
      await hooked.act(h => h.resetSuggestion())
      await hooked.rerender({ inputValue: '', isAssistantResponding: false })
      expect(hooked.hook().suggestion).toBeNull()
      expect(hooked.suggestionState().shownAt).toBe(0)
    },
    SLOW,
  )
})
