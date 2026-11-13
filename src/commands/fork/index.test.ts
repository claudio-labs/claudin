import { expect, test } from 'bun:test'

import { fork, isForkCommandEnabled, subtask } from 'src/commands/fork/index.ts'

test('on only with the fork agent and somewhere to drain a background agent', () => {
  expect(isForkCommandEnabled(true, false)).toBe(true)
  expect(isForkCommandEnabled(false, false)).toBe(false)
  expect(isForkCommandEnabled(true, true)).toBe(false)
  expect(isForkCommandEnabled(false, true)).toBe(false)
})

test('/fork and /subtask share the gate, each loading its own call', async () => {
  // FORK_SUBAGENT folds to false under bun test, so both read off here.
  expect(fork.isEnabled()).toBe(isForkCommandEnabled())
  expect(subtask.isEnabled()).toBe(isForkCommandEnabled())
  const [forkModule, subtaskModule] = await Promise.all([fork.load(), subtask.load()])
  expect(forkModule.call).not.toBe(subtaskModule.call)
})
