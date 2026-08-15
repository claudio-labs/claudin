import { describe, expect, test } from 'bun:test'

import type { ToolUseContext } from 'src/Tool.js'
import { TaskOutputTool } from 'src/tools/TaskOutputTool/TaskOutputTool.js'

function makeCtx(appState: Record<string, unknown>): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

describe('TaskOutputTool', () => {
  test('aliases preserve renamed legacy tool names', () => {
    expect(TaskOutputTool.aliases).toEqual(
      expect.arrayContaining(['AgentOutputTool', 'BashOutputTool']),
    )
  })

  test('input schema enforces task_id and clamps timeout range', () => {
    expect(TaskOutputTool.inputSchema.safeParse({}).success).toBe(false)
    expect(
      TaskOutputTool.inputSchema.safeParse({
        task_id: '1',
        timeout: -1,
      }).success,
    ).toBe(false)
    expect(
      TaskOutputTool.inputSchema.safeParse({
        task_id: '1',
        timeout: 600_001,
      }).success,
    ).toBe(false)
    const ok = TaskOutputTool.inputSchema.safeParse({ task_id: '1' })
    expect(ok.success).toBe(true)
    if (ok.success) {
      expect(ok.data.block).toBe(true)
      expect(ok.data.timeout).toBe(30_000)
    }
  })

  test('isReadOnly() and isEnabled() are true', () => {
    expect(TaskOutputTool.isReadOnly?.({} as never)).toBe(true)
    expect(TaskOutputTool.isEnabled?.()).toBe(true)
  })

  test('validateInput rejects missing or unknown task_id', async () => {
    const missing = await TaskOutputTool.validateInput?.(
      { task_id: '' } as never,
      makeCtx({ tasks: {} }),
    )
    expect(missing && missing.result === false && missing.message).toContain(
      'Task ID is required',
    )

    const unknown = await TaskOutputTool.validateInput?.(
      { task_id: 'nope' } as never,
      makeCtx({ tasks: {} }),
    )
    expect(unknown && unknown.result === false && unknown.message).toContain(
      'No task found',
    )
  })

  test('validateInput accepts known task', async () => {
    const result = await TaskOutputTool.validateInput?.(
      { task_id: 'a' } as never,
      makeCtx({
        tasks: { a: { id: 'a', status: 'completed', type: 'local_bash' } },
      }),
    )
    expect(result?.result).toBe(true)
  })

  test('call() throws when task is gone from app state', async () => {
    await expect(
      TaskOutputTool.call(
        { task_id: 'missing', block: false, timeout: 1000 } as never,
        makeCtx({ tasks: {} }),
        undefined as never,
        undefined as never,
      ),
    ).rejects.toThrow('No task found')
  })

  test('non-blocking call() reports not_ready for running task', async () => {
    const ctx = makeCtx({
      tasks: {
        a: {
          id: 'a',
          status: 'running',
          type: 'local_bash',
          description: 'sleep 9',
          shellCommand: undefined,
        },
      },
    })
    const { data } = await TaskOutputTool.call(
      { task_id: 'a', block: false, timeout: 1000 } as never,
      ctx,
      undefined as never,
      undefined as never,
    )
    expect(data.retrieval_status).toBe('not_ready')
    expect(data.task?.status).toBe('running')
  })
})
