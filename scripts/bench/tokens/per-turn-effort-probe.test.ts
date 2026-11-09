import { describe, expect, test } from 'bun:test'
import { layoutRequest } from './per-turn-effort-probe.ts'

describe('layoutRequest', () => {
  test('a change of effort is a system message right after its user turn', () => {
    const { topEffort, messages } = layoutRequest('A', 1)
    expect(topEffort).toBe('medium')
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'system'])
    expect(messages[3]).toEqual({ role: 'system', content: [], output_config: { effort: 'low' } })
  })

  test('A keeps the first turn at the top level, B follows the turn', () => {
    expect(layoutRequest('A', 2).topEffort).toBe('medium')
    expect(layoutRequest('B', 2).topEffort).toBe('xhigh')
    expect(layoutRequest('B', 0).topEffort).toBe('medium')
  })

  test('the earlier turns render the same in every later request, and only the last user turn is marked', () => {
    const third = layoutRequest('A', 2).messages
    const fourth = layoutRequest('A', 3).messages
    const strip = (m: Record<string, unknown>) => JSON.stringify(m).replace(/,"cache_control":\{"type":"ephemeral"\}/, '')
    expect(fourth.slice(0, third.length).map(strip)).toEqual(third.map(strip))
    expect(JSON.stringify(fourth).match(/cache_control/g)).toHaveLength(1)
  })
})
