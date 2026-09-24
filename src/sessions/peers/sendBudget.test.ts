import { beforeEach, expect, test } from 'bun:test'

import {
  CROSS_SESSION_SENDS_PER_USER_PROMPT,
  renewCrossSessionSendsFor,
  resetCrossSessionSends,
  takeCrossSessionSend,
} from 'src/sessions/peers/sendBudget.js'

beforeEach(() => {
  resetCrossSessionSends()
})

// Bounded, so a budget that never runs out fails the test instead of hanging it.
function spendAll(): number {
  let spent = 0
  while (spent <= CROSS_SESSION_SENDS_PER_USER_PROMPT && takeCrossSessionSend()) spent++
  return spent
}

test('the budget runs out after a fixed number of sends', () => {
  expect(spendAll()).toBe(CROSS_SESSION_SENDS_PER_USER_PROMPT)
  expect(takeCrossSessionSend()).toBe(false)
})

test('only a prompt with no origin — one the user typed — renews it', () => {
  spendAll()
  renewCrossSessionSendsFor([
    { mode: 'task-notification', origin: { kind: 'peer', name: 'claudin-goal' } },
    { mode: 'prompt', origin: { kind: 'subagent', name: 'researcher' } },
    { mode: 'task-notification' },
  ])
  expect(takeCrossSessionSend()).toBe(false)
  renewCrossSessionSendsFor([{ mode: 'prompt' }])
  expect(spendAll()).toBe(CROSS_SESSION_SENDS_PER_USER_PROMPT)
})
