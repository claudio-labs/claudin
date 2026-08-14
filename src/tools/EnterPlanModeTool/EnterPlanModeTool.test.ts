import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { ToolUseContext } from 'src/Tool.js'
import { EnterPlanModeTool } from './EnterPlanModeTool.js'

type AppState = {
  toolPermissionContext: { mode: string }
}

function makeCtx(opts: { agentId?: string } = {}): {
  ctx: ToolUseContext
  state: AppState
} {
  const state: AppState = {
    toolPermissionContext: {
      mode: 'default',
    },
  }
  const ctx = {
    agentId: opts.agentId,
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (
      updater: (prev: AppState) => AppState,
    ) => {
      const next = updater(state)
      state.toolPermissionContext = next.toolPermissionContext
    },
    options: {},
  } as unknown as ToolUseContext
  return { ctx, state }
}

describe('EnterPlanModeTool', () => {
  beforeEach(() => {
    delete process.env.CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE
  })

  afterEach(() => {
    delete process.env.CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE
  })

  test('shouldDefer is true and read-only / concurrency-safe flags', () => {
    expect(EnterPlanModeTool.shouldDefer).toBe(true)
    expect(EnterPlanModeTool.isReadOnly?.({} as never)).toBe(true)
    expect(EnterPlanModeTool.isConcurrencySafe?.({} as never)).toBe(true)
  })

  test('isEnabled() is true when no channel restriction is active', () => {
    // KAIROS feature flag is off in the open build, so isEnabled never trips
    // the channels guard. This locks in current behavior.
    expect(EnterPlanModeTool.isEnabled?.()).toBe(true)
  })

  test('input schema rejects any properties (strict object, no params)', () => {
    expect(EnterPlanModeTool.inputSchema.safeParse({}).success).toBe(true)
    expect(
      EnterPlanModeTool.inputSchema.safeParse({ anything: true }).success,
    ).toBe(false)
  })

  test('userFacingName is empty (rendered by UI helpers)', () => {
    expect(EnterPlanModeTool.userFacingName(undefined)).toBe('')
  })

  test('call() refuses to run inside a sub-agent context', async () => {
    const { ctx } = makeCtx({ agentId: 'sub-1' })
    await expect(
      EnterPlanModeTool.call({} as never, ctx, {} as never, {} as never),
    ).rejects.toThrow('cannot be used in agent contexts')
  })

  test('call() flips the permission context to plan mode', async () => {
    const { ctx, state } = makeCtx()
    const { data } = await EnterPlanModeTool.call({} as never, ctx, {} as never, {} as never)

    expect(data.message).toContain('Entered plan mode')
    expect(state.toolPermissionContext.mode).toBe('plan')
  })

  test('mapToolResultToToolResultBlockParam switches text by interview flag', () => {
    process.env.CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE = '1'
    const interview = EnterPlanModeTool.mapToolResultToToolResultBlockParam?.(
      { message: 'Entered plan mode.' },
      'use-1',
    )
    expect(interview?.content).toContain(
      'DO NOT write or edit any files except the plan file',
    )

    process.env.CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE = '0'
    const legacy = EnterPlanModeTool.mapToolResultToToolResultBlockParam?.(
      { message: 'Entered plan mode.' },
      'use-2',
    )
    expect(legacy?.content).toContain('Thoroughly explore the codebase')
    expect(legacy?.content).toContain('ExitPlanMode')
  })
})
