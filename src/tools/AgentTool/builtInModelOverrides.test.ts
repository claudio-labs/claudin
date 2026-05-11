import { describe, expect, test } from 'bun:test'
import {
  applyBuiltInModelOverrides,
  type BuiltInModelOverrideDeps,
} from './builtInModelOverrides.js'

function makeAgent(agentType: string, model: string | undefined = undefined) {
  return { agentType, model }
}

function makeDeps(
  partial: Partial<BuiltInModelOverrideDeps> = {},
): BuiltInModelOverrideDeps {
  return {
    readConfig: () => ({}),
    getAvailableModelIds: () => undefined,
    logDebug: () => {},
    logErr: () => {},
    ...partial,
  }
}

describe('applyBuiltInModelOverrides', () => {
  test('returns agents unchanged when agentModelOverrides is absent', () => {
    const input = [makeAgent('Explore'), makeAgent('Plan')]
    const result = applyBuiltInModelOverrides(input, makeDeps())
    expect(result).toEqual(input)
  })

  test('applies override when value matches active profile model list', () => {
    const result = applyBuiltInModelOverrides(
      [makeAgent('Explore'), makeAgent('Plan')],
      makeDeps({
        readConfig: () => ({
          agentModelOverrides: { 'built-in:Explore': 'deepseek-chat' },
        }),
        getAvailableModelIds: () => new Set(['deepseek-chat', 'deepseek-r1']),
      }),
    )
    expect(result[0]?.model).toBe('deepseek-chat')
    expect(result[1]?.model).toBeUndefined()
  })

  test('preserves "inherit" override regardless of profile model list', () => {
    const result = applyBuiltInModelOverrides(
      [makeAgent('Explore')],
      makeDeps({
        readConfig: () => ({ agentModelOverrides: { 'built-in:Explore': 'inherit' } }),
        getAvailableModelIds: () => new Set(['gpt-5']),
      }),
    )
    expect(result[0]?.model).toBe('inherit')
  })

  test.each(['haiku', 'sonnet', 'opus'])(
    'preserves Claude family alias "%s" even when not in profile model list',
    alias => {
      const result = applyBuiltInModelOverrides(
        [makeAgent('Explore')],
        makeDeps({
          readConfig: () => ({ agentModelOverrides: { 'built-in:Explore': alias } }),
          getAvailableModelIds: () => new Set(['gpt-5']),
        }),
      )
      expect(result[0]?.model).toBe(alias)
    },
  )

  test('drops orphaned override to "inherit" when not in profile model list', () => {
    const debugCalls: string[] = []
    const result = applyBuiltInModelOverrides(
      [makeAgent('Explore')],
      makeDeps({
        readConfig: () => ({
          agentModelOverrides: { 'built-in:Explore': 'deepseek-r1' },
        }),
        getAvailableModelIds: () => new Set(['gpt-5']),
        logDebug: msg => debugCalls.push(msg),
      }),
    )
    expect(result[0]?.model).toBe('inherit')
    expect(debugCalls).toHaveLength(1)
    expect(debugCalls[0]).toContain('Dropping orphaned')
    expect(debugCalls[0]).toContain('Explore')
    expect(debugCalls[0]).toContain('deepseek-r1')
  })

  test('preserves override when profile has no model list (cannot validate)', () => {
    const result = applyBuiltInModelOverrides(
      [makeAgent('Explore')],
      makeDeps({
        readConfig: () => ({
          agentModelOverrides: { 'built-in:Explore': 'unknown-model' },
        }),
        getAvailableModelIds: () => undefined,
      }),
    )
    expect(result[0]?.model).toBe('unknown-model')
  })

  test('preserves override when getAvailableModelIds throws (fails open)', () => {
    const errCalls: unknown[] = []
    const result = applyBuiltInModelOverrides(
      [makeAgent('Explore')],
      makeDeps({
        readConfig: () => ({
          agentModelOverrides: { 'built-in:Explore': 'some-model' },
        }),
        getAvailableModelIds: () => {
          throw new Error('profile lookup failed')
        },
        logErr: e => errCalls.push(e),
      }),
    )
    expect(result[0]?.model).toBe('some-model')
    expect(errCalls).toHaveLength(1)
  })

  test('returns agents unchanged when readConfig throws', () => {
    const errCalls: unknown[] = []
    const input = [makeAgent('Explore', 'original-model')]
    const result = applyBuiltInModelOverrides(
      input,
      makeDeps({
        readConfig: () => {
          throw new Error('config read failed')
        },
        logErr: e => errCalls.push(e),
      }),
    )
    expect(result).toEqual(input)
    expect(errCalls).toHaveLength(1)
  })

  test('trims whitespace from override values', () => {
    const result = applyBuiltInModelOverrides(
      [makeAgent('Explore')],
      makeDeps({
        readConfig: () => ({
          agentModelOverrides: { 'built-in:Explore': '  deepseek-chat  ' },
        }),
        getAvailableModelIds: () => new Set(['deepseek-chat']),
      }),
    )
    expect(result[0]?.model).toBe('deepseek-chat')
  })

  test('ignores whitespace-only overrides', () => {
    const result = applyBuiltInModelOverrides(
      [makeAgent('Explore', 'pre-existing')],
      makeDeps({
        readConfig: () => ({ agentModelOverrides: { 'built-in:Explore': '   ' } }),
        getAvailableModelIds: () => new Set(['gpt-5']),
      }),
    )
    expect(result[0]?.model).toBe('pre-existing')
  })

  test('ignores non-namespaced (legacy) keys to prevent .md shadow collisions', () => {
    // A bare `Explore` key in agentModelOverrides should NOT apply: the
    // built-in path always reads `built-in:Explore`. This protects against a
    // user `.md` agent named `Explore` accidentally sharing the slot.
    const result = applyBuiltInModelOverrides(
      [makeAgent('Explore')],
      makeDeps({
        readConfig: () => ({
          agentModelOverrides: { Explore: 'deepseek-chat' },
        }),
        getAvailableModelIds: () => new Set(['deepseek-chat']),
      }),
    )
    expect(result[0]?.model).toBeUndefined()
  })

  test('agents without override are returned untouched', () => {
    const result = applyBuiltInModelOverrides(
      [makeAgent('Explore'), makeAgent('Plan', 'haiku')],
      makeDeps({
        readConfig: () => ({
          agentModelOverrides: { 'built-in:OtherAgent': 'gpt-5' },
        }),
        getAvailableModelIds: () => new Set(['gpt-5']),
      }),
    )
    expect(result[0]?.model).toBeUndefined()
    expect(result[1]?.model).toBe('haiku')
  })
})
