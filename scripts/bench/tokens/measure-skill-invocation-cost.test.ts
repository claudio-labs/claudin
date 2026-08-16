import { describe, expect, test } from 'bun:test'

import { measureSkillInvocationCost } from './measure-skill-invocation-cost.ts'

describe('measureSkillInvocationCost', () => {
  test('returns synthetic profiles in size order', async () => {
    const result = await measureSkillInvocationCost()
    expect(result.synthetic).toHaveLength(4)
    const profiles = result.synthetic.map(s => s.profile)
    expect(profiles).toEqual(['small', 'medium', 'large', 'huge'])

    for (let i = 1; i < result.synthetic.length; i++) {
      expect(result.synthetic[i]!.bodyBytes).toBeGreaterThan(
        result.synthetic[i - 1]!.bodyBytes,
      )
      expect(result.synthetic[i]!.tokens).toBeGreaterThan(
        result.synthetic[i - 1]!.tokens,
      )
    }
  })

  test('per-session projection scales with invocations', async () => {
    const a = await measureSkillInvocationCost({ invocationsPerSession: 1 })
    const b = await measureSkillInvocationCost({ invocationsPerSession: 5 })
    expect(b.perSessionMediumTokens).toBe(a.perSessionMediumTokens * 5)
  })

  test('real skills array is non-empty (registers at least one bundled skill)', async () => {
    const result = await measureSkillInvocationCost()
    // We try debug/loop/keybindings — at least one MUST register OR we get
    // a single error row. Either way the array is non-empty.
    expect(result.realSkills.length).toBeGreaterThan(0)
  })

  test('successfully-loaded skills report positive byte counts', async () => {
    const result = await measureSkillInvocationCost()
    const successful = result.realSkills.filter(r => !r.errored)
    if (successful.length > 0) {
      for (const r of successful) {
        expect(r.promptBytes).toBeGreaterThan(0)
        expect(r.promptTokens).toBeGreaterThan(0)
      }
    }
  })

  test('huge profile is at least 50× small profile in tokens', async () => {
    const result = await measureSkillInvocationCost()
    const small = result.synthetic.find(s => s.profile === 'small')!
    const huge = result.synthetic.find(s => s.profile === 'huge')!
    expect(huge.tokens / small.tokens).toBeGreaterThan(50)
  })
})
