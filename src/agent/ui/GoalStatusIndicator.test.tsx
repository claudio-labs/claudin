import { describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { GoalStatusIndicator } from 'src/agent/ui/GoalStatusIndicator.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { type ActiveGoalState, getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

async function footer(activeGoal: ActiveGoalState | undefined): Promise<string> {
  return stripAnsi(
    await renderToString(
      <AppStateProvider initialState={{ ...getDefaultAppState(), activeGoal }}>
        <GoalStatusIndicator />
      </AppStateProvider>,
      160,
    ),
  )
}

const GOAL: ActiveGoalState = { condition: 'tests pass', iterations: 2, setAt: Date.now(), lastCheckReason: 'two fail' }

describe('GoalStatusIndicator', () => {
  test('nothing without a goal', async () => {
    expect((await footer(undefined)).trim()).toBe('')
  })

  test('an active goal: condition, iterations and the last check', async () => {
    const out = await footer(GOAL)
    expect(out).toContain('◎ Goal active: tests pass · 2 iterations')
    expect(out).toContain('Last check: two fail')
    expect(out).not.toContain('Paused')
  })

  test('a paused goal says so on the element, with the reason and how it resumes', async () => {
    const out = await footer({ ...GOAL, paused: { reason: 'needs the staging token', at: Date.now() } })
    expect(out).toContain('◎ Goal paused: tests pass')
    expect(out).toContain('Paused: needs the staging token · your next message resumes it')
  })
})
