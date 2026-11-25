import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as React from 'react'
import { REPLStatus, type REPLStatusProps } from 'src/agent/repl/ui/REPLStatus.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { type AppState, AppStateProvider, getDefaultAppState } from 'src/terminal/state/AppState.js'

// The spinner's verb is what the agent is doing: REPL derives it from the
// running tool calls (toolActivityLabel.ts) and REPLStatus hands it on.

function props(overrides: Partial<REPLStatusProps> = {}): REPLStatusProps {
  return {
    showSpinner: true,
    streamMode: 'tool-use',
    responseLengthRef: { current: 0 },
    apiMetricsRef: { current: [] },
    spinnerMessage: null,
    activityLabel: undefined,
    stopHookSpinnerSuffix: null,
    verbose: false,
    loadingStartTimeRef: { current: Date.now() },
    totalPausedMsRef: { current: 0 },
    pauseStartTimeRef: { current: null },
    spinnerColor: null,
    spinnerShimmerColor: null,
    hasActiveTools: true,
    leaderIsIdle: false,
    isLoading: true,
    userInputOnProcessing: undefined,
    hasRunningTeammates: false,
    isBriefOnly: false,
    viewedAgentTask: undefined,
    ...overrides,
  }
}

function render(overrides: Partial<REPLStatusProps>): Promise<string> {
  const base = getDefaultAppState()
  const state = { ...base, settings: { ...base.settings, prefersReducedMotion: true } } as AppState
  return renderToString(
    <AppStateProvider initialState={state}>
      <REPLStatus {...props(overrides)} />
    </AppStateProvider>,
    120,
  )
}

describe('REPLStatus — the spinner verb', () => {
  test('the activity label reaches the spinner', async () => {
    expect(await render({ activityLabel: 'Editing Spinner.tsx' })).toContain('Editing Spinner.tsx...')
  })

  test('without one the spinner falls back on its mode', async () => {
    expect(await render({ activityLabel: undefined })).toContain('Working...')
  })

  test('REPL derives the label from the running calls and passes it on', () => {
    const source = readFileSync(new URL('../REPL.tsx', import.meta.url), 'utf8')
    expect(source).toContain('describeActivity(messages, inProgressToolUseIDs, streamingToolUses)')
    expect(source).toContain('activityLabel={activityLabel}')
  })
})
