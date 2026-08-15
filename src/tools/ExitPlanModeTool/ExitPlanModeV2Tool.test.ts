import { describe, expect, test } from 'bun:test'

import type { ToolUseContext } from 'src/Tool.js'
import { ExitPlanModeV2Tool } from 'src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'

function makeCtx(mode: string): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: { mode },
    }),
    setAppState: () => {},
    options: { mainLoopModel: 'test-model' },
  } as unknown as ToolUseContext
}

describe('ExitPlanModeV2Tool', () => {
  test('flags: shouldDefer, not read-only, concurrency-safe', () => {
    expect(ExitPlanModeV2Tool.shouldDefer).toBe(true)
    expect(ExitPlanModeV2Tool.isReadOnly?.({} as never)).toBe(false)
    expect(ExitPlanModeV2Tool.isConcurrencySafe?.({} as never)).toBe(true)
  })

  test('isEnabled() is true when channels are not restricted', () => {
    expect(ExitPlanModeV2Tool.isEnabled?.()).toBe(true)
  })

  test('input schema accepts empty body and parses allowedPrompts/filesToEdit', () => {
    expect(ExitPlanModeV2Tool.inputSchema.safeParse({}).success).toBe(true)

    const ok = ExitPlanModeV2Tool.inputSchema.safeParse({
      allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
      filesToEdit: ['/abs/path'],
    })
    expect(ok.success).toBe(true)

    // Unknown tool in allowedPrompts must fail
    const badTool = ExitPlanModeV2Tool.inputSchema.safeParse({
      allowedPrompts: [{ tool: 'Edit', prompt: 'x' }],
    })
    expect(badTool.success).toBe(false)
  })

  test('input schema passes through extra keys (passthrough)', () => {
    const parsed = ExitPlanModeV2Tool.inputSchema.safeParse({
      extraneous: 'ok',
    })
    expect(parsed.success).toBe(true)
  })

  test('validateInput rejects when not in plan mode', async () => {
    const result = await ExitPlanModeV2Tool.validateInput?.(
      {} as never,
      makeCtx('default'),
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.message).toContain('not in plan mode')
      expect(result.errorCode).toBe(1)
    }
  })

  test('validateInput accepts when current mode is plan', async () => {
    const result = await ExitPlanModeV2Tool.validateInput?.(
      {} as never,
      makeCtx('plan'),
    )
    expect(result?.result).toBe(true)
  })

  test('requiresUserInteraction is true for non-teammate', () => {
    expect(ExitPlanModeV2Tool.requiresUserInteraction?.()).toBe(true)
  })

  test('checkPermissions asks user for non-teammate', async () => {
    const result = await ExitPlanModeV2Tool.checkPermissions?.(
      { allowedPrompts: undefined } as never,
      makeCtx('plan'),
    )
    expect(result?.behavior).toBe('ask')
    if (result?.behavior === 'ask') {
      expect(result.message).toBe('Exit plan mode?')
    }
  })

  test('mapToolResultToToolResultBlockParam renders awaitingLeaderApproval branch', () => {
    const map = ExitPlanModeV2Tool.mapToolResultToToolResultBlockParam
    expect(map).toBeDefined()
    const block = map?.(
      {
        plan: 'do thing',
        isAgent: false,
        filePath: '/p',
        awaitingLeaderApproval: true,
        requestId: 'r1',
      },
      'u1',
    )
    expect(block?.content).toContain('submitted to the team lead')
    expect(block?.content).toContain('Request ID: r1')
  })

  test('mapToolResultToToolResultBlockParam handles agent and empty plan branches', () => {
    const map = ExitPlanModeV2Tool.mapToolResultToToolResultBlockParam
    const agentBlock = map?.(
      { plan: 'p', isAgent: true },
      'u',
    )
    expect(agentBlock?.content).toContain('Please respond with "ok"')

    const emptyBlock = map?.(
      { plan: '', isAgent: false },
      'u',
    )
    expect(emptyBlock?.content).toBe(
      'User has approved exiting plan mode. You can now proceed.',
    )
  })

  test('mapToolResultToToolResultBlockParam includes plan body and edited label', () => {
    const map = ExitPlanModeV2Tool.mapToolResultToToolResultBlockParam
    const block = map?.(
      {
        plan: 'PLAN CONTENT',
        isAgent: false,
        filePath: '/tmp/plan.md',
        planWasEdited: true,
      },
      'u',
    )
    expect(block?.content).toContain('Approved Plan (edited by user)')
    expect(block?.content).toContain('PLAN CONTENT')
    expect(block?.content).toContain('/tmp/plan.md')
  })
})
