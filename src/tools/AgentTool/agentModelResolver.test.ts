import { describe, expect, test } from 'bun:test'
import {
  isAliasOrInherit,
  resolveModelOverride,
  type ResolveOverrideDeps,
} from 'src/tools/AgentTool/agentModelResolver.js'

const silentDeps = (
  available: Set<string> | undefined = undefined,
): ResolveOverrideDeps & { debugCalls: string[] } => {
  const debugCalls: string[] = []
  return {
    getAvailableModelIds: () => available,
    logDebug: (msg: string) => debugCalls.push(msg),
    logErr: () => {},
    debugCalls,
  }
}

describe('isAliasOrInherit', () => {
  test.each(['inherit', 'haiku', 'sonnet', 'opus'])('%s is alias', v => {
    expect(isAliasOrInherit(v)).toBe(true)
  })
  test('arbitrary model id is not alias', () => {
    expect(isAliasOrInherit('claude-sonnet-4-6')).toBe(false)
  })
})

describe('resolveModelOverride', () => {
  test('undefined → undefined', () => {
    expect(resolveModelOverride(undefined, 'ctx', silentDeps())).toBeUndefined()
  })

  test('empty string → undefined', () => {
    expect(resolveModelOverride('', 'ctx', silentDeps())).toBeUndefined()
  })

  test('whitespace-only → undefined', () => {
    expect(resolveModelOverride('   ', 'ctx', silentDeps())).toBeUndefined()
  })

  test('inherit passes through without active-profile check', () => {
    expect(resolveModelOverride('inherit', 'ctx', silentDeps(new Set()))).toBe(
      'inherit',
    )
  })

  test('aliases pass through without active-profile check', () => {
    expect(resolveModelOverride('sonnet', 'ctx', silentDeps(new Set()))).toBe(
      'sonnet',
    )
  })

  test('passes through model when no available-list is enumerable', () => {
    expect(
      resolveModelOverride('deepseek-chat', 'ctx', silentDeps(undefined)),
    ).toBe('deepseek-chat')
  })

  test('passes through model present in active profile', () => {
    expect(
      resolveModelOverride(
        'claude-sonnet-4-6',
        'ctx',
        silentDeps(new Set(['claude-sonnet-4-6'])),
      ),
    ).toBe('claude-sonnet-4-6')
  })

  test('orphan falls back to inherit and emits one debug log', () => {
    const deps = silentDeps(new Set(['claude-sonnet-4-6']))
    expect(resolveModelOverride('gpt-5', 'built-in:Plan', deps)).toBe(
      'inherit',
    )
    expect(deps.debugCalls).toHaveLength(1)
    expect(deps.debugCalls[0]).toContain('built-in:Plan')
    expect(deps.debugCalls[0]).toContain('gpt-5')
  })

  test('trims whitespace before alias/availability checks', () => {
    expect(
      resolveModelOverride(
        '  claude-sonnet-4-6  ',
        'ctx',
        silentDeps(new Set(['claude-sonnet-4-6'])),
      ),
    ).toBe('claude-sonnet-4-6')
  })

  test('when getAvailableModelIds throws, passes through with err logged', () => {
    const errs: unknown[] = []
    const out = resolveModelOverride('gpt-5', 'ctx', {
      getAvailableModelIds: () => {
        throw new Error('boom')
      },
      logDebug: () => {},
      logErr: e => errs.push(e),
    })
    expect(out).toBe('gpt-5')
    expect(errs).toHaveLength(1)
  })
})
