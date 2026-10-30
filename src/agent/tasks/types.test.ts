import { describe, expect, test } from 'bun:test'
import type { TaskState } from 'src/agent/tasks/types.js'
import { holdsHeadlessExit } from 'src/agent/tasks/types.js'

function task(over: Record<string, unknown>): TaskState {
  return { id: 't1', type: 'local_bash', status: 'running', isBackgrounded: true, ...over } as unknown as TaskState
}

describe('holdsHeadlessExit — what `-p` waits for before it exits', () => {
  test('a running background command holds the exit until it ends', () => {
    expect(holdsHeadlessExit(task({}))).toBe(true)
    expect(holdsHeadlessExit(task({ type: 'local_agent' }))).toBe(true)
  })

  test('a finished task or a foreground one does not', () => {
    expect(holdsHeadlessExit(task({ status: 'completed' }))).toBe(false)
    expect(holdsHeadlessExit(task({ isBackgrounded: false }))).toBe(false)
  })

  test('a teammate does not: it runs for its whole lifetime (gh-30008)', () => {
    expect(holdsHeadlessExit(task({ type: 'in_process_teammate' }))).toBe(false)
  })

  test('nor does an adopted leftover: nobody asked to wait for it, and the exit stops it', () => {
    // A live `-p` run with CLAUDIN_ADOPT_LEFTOVERS=1 that left `sleep` running
    // never exited: the loop waited for the adopted task until `timeout` killed it.
    expect(holdsHeadlessExit(task({ adopted: true }))).toBe(false)
  })
})
