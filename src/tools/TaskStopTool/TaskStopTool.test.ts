import { describe, expect, test } from 'bun:test'

import type { ToolUseContext } from 'src/tools/Tool.js'
import { TaskStopTool } from 'src/tools/TaskStopTool/TaskStopTool.js'

function makeCtx(appState: Record<string, unknown>): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

describe('TaskStopTool', () => {
  test('aliases includes deprecated KillShell name', () => {
    expect(TaskStopTool.aliases).toContain('KillShell')
  })

  test('input schema accepts task_id or shell_id', () => {
    expect(TaskStopTool.inputSchema.safeParse({}).success).toBe(true)
    expect(TaskStopTool.inputSchema.safeParse({ task_id: '1' }).success).toBe(
      true,
    )
    expect(TaskStopTool.inputSchema.safeParse({ shell_id: '1' }).success).toBe(
      true,
    )
    expect(
      TaskStopTool.inputSchema.safeParse({ task_id: '1', extra: true }).success,
    ).toBe(false)
  })

  test('validateInput rejects when neither id is provided', async () => {
    const result = await TaskStopTool.validateInput?.(
      {} as never,
      makeCtx({ tasks: {} }),
    )
    expect(result?.result).toBe(false)
    expect(result?.message).toContain('Missing required parameter')
  })

  test('validateInput rejects unknown task id', async () => {
    const result = await TaskStopTool.validateInput?.(
      { task_id: '99' } as never,
      makeCtx({ tasks: {} }),
    )
    expect(result?.result).toBe(false)
    expect(result?.message).toContain('No task found')
  })

  test('validateInput rejects task that is not running', async () => {
    const result = await TaskStopTool.validateInput?.(
      { task_id: 'a' } as never,
      makeCtx({ tasks: { a: { id: 'a', status: 'completed' } } }),
    )
    expect(result?.result).toBe(false)
    expect(result?.message).toContain('not running')
  })

  test('validateInput accepts a running task and falls back to shell_id', async () => {
    const result = await TaskStopTool.validateInput?.(
      { shell_id: 'b' } as never,
      makeCtx({ tasks: { b: { id: 'b', status: 'running' } } }),
    )
    expect(result?.result).toBe(true)
  })

  test('call() throws when no id is provided', async () => {
    await expect(
      TaskStopTool.call({} as never, {
        getAppState: () => ({ tasks: {} }),
        setAppState: () => {},
        abortController: new AbortController(),
      } as never),
    ).rejects.toThrow('Missing required parameter')
  })

  test('userFacingName is human-friendly', () => {
    expect(TaskStopTool.userFacingName()).toBe('Stop Task')
  })
})
