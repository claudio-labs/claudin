import { describe, expect, test } from 'bun:test'
import { countRunningAgents, samePresence } from 'src/sessions/sessionPresence.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'

function tasks(...entries: Array<{ type: string; status: string }>): AppState['tasks'] {
  return Object.fromEntries(entries.map((task, i) => [`t${i}`, task])) as unknown as AppState['tasks']
}

describe('session presence', () => {
  test('counts only the local agents still running', () => {
    expect(
      countRunningAgents(
        tasks(
          { type: 'local_agent', status: 'running' },
          { type: 'local_agent', status: 'completed' },
          { type: 'local_bash', status: 'running' },
          { type: 'local_agent', status: 'running' },
        ),
      ),
    ).toBe(2)
  })

  test('a change the list would not show does not count as one', () => {
    const base = { turnActive: false, runningAgents: 0, costUSD: 1.231 }
    expect(samePresence(base, { ...base, costUSD: 1.229 })).toBe(true)
    expect(samePresence(base, { ...base, costUSD: 1.25 })).toBe(false)
    expect(samePresence(base, { ...base, turnActive: true })).toBe(false)
    expect(samePresence(base, { ...base, runningAgents: 1 })).toBe(false)
  })
})
