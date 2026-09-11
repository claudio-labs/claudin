import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  _resetForkGateForTesting,
  DEFAULT_FORK_MAX_PARENT_TOKENS,
  forkGateVerdict,
  forkParentTokenLimit,
} from 'src/tools/AgentTool/forkGate.js'

const prior = process.env.CLAUDIN_FORK_MAX_PARENT_TOKENS

beforeEach(() => {
  _resetForkGateForTesting()
  delete process.env.CLAUDIN_FORK_MAX_PARENT_TOKENS
})

afterEach(() => {
  if (prior === undefined) delete process.env.CLAUDIN_FORK_MAX_PARENT_TOKENS
  else process.env.CLAUDIN_FORK_MAX_PARENT_TOKENS = prior
})

describe('forkGateVerdict', () => {
  test('lets a fork through under the limit', () => {
    expect(forkGateVerdict(149_999, 'find the bug')).toBeNull()
    expect(forkGateVerdict(DEFAULT_FORK_MAX_PARENT_TOKENS, 'find the bug')).toBeNull()
  })

  test('refuses once above the limit and names the fresh agent; the identical re-send forks', () => {
    const first = forkGateVerdict(312_000, 'bisect the footer edits')
    expect(first).not.toBeNull()
    expect(first).toContain('Blocked:')
    expect(first).toContain('312k tokens')
    expect(first).toContain('subagent_type: "Code"')
    expect(first).toContain('re-send this exact call')
    // The escape hatch the message promises.
    expect(forkGateVerdict(312_000, 'bisect the footer edits')).toBeNull()
    // A different prompt at the same size is refused on its own first try.
    expect(forkGateVerdict(312_000, 'another question')).not.toBeNull()
  })

  test('CLAUDIN_FORK_MAX_PARENT_TOKENS moves the limit and 0 disables it', () => {
    process.env.CLAUDIN_FORK_MAX_PARENT_TOKENS = '50000'
    expect(forkParentTokenLimit()).toBe(50_000)
    expect(forkGateVerdict(60_000, 'p')).not.toBeNull()

    process.env.CLAUDIN_FORK_MAX_PARENT_TOKENS = '0'
    expect(forkGateVerdict(900_000, 'q')).toBeNull()

    process.env.CLAUDIN_FORK_MAX_PARENT_TOKENS = 'nonsense'
    expect(forkParentTokenLimit()).toBe(DEFAULT_FORK_MAX_PARENT_TOKENS)
  })
})
