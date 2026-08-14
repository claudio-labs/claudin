import { describe, expect, test } from 'bun:test'

import { ConfigTool } from './ConfigTool.js'

function makeCtx(): {
  ctx: import('src/Tool.js').ToolUseContext
  state: Record<string, unknown>
} {
  const state: Record<string, unknown> = {}
  const ctx = {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (
      updater: (prev: Record<string, unknown>) => Record<string, unknown>,
    ) => Object.assign(state, updater(state)),
    options: {},
  } as unknown as import('src/Tool.js').ToolUseContext
  return { ctx, state }
}

describe('ConfigTool', () => {
  test('userFacingName is Config and shouldDefer is true', () => {
    expect(ConfigTool.userFacingName()).toBe('Config')
    expect(ConfigTool.shouldDefer).toBe(true)
    expect(ConfigTool.isConcurrencySafe?.()).toBe(true)
  })

  test('isReadOnly() is true on read and false on write', () => {
    expect(ConfigTool.isReadOnly?.({ setting: 'theme' } as never)).toBe(true)
    expect(
      ConfigTool.isReadOnly?.({ setting: 'theme', value: 'dark' } as never),
    ).toBe(false)
  })

  test('input schema requires setting and accepts only string|boolean|number values', () => {
    expect(ConfigTool.inputSchema.safeParse({}).success).toBe(false)
    expect(
      ConfigTool.inputSchema.safeParse({ setting: 'theme' }).success,
    ).toBe(true)
    expect(
      ConfigTool.inputSchema.safeParse({ setting: 'theme', value: 'dark' })
        .success,
    ).toBe(true)
    expect(
      ConfigTool.inputSchema.safeParse({
        setting: 'theme',
        value: { complex: true },
      }).success,
    ).toBe(false)
  })

  test('input schema rejects unknown keys', () => {
    expect(
      ConfigTool.inputSchema.safeParse({
        setting: 'theme',
        value: 'dark',
        extra: true,
      }).success,
    ).toBe(false)
  })

  test('toAutoClassifierInput differentiates get and set', () => {
    expect(
      ConfigTool.toAutoClassifierInput?.({ setting: 'theme' } as never),
    ).toBe('theme')
    expect(
      ConfigTool.toAutoClassifierInput?.({
        setting: 'theme',
        value: 'dark',
      } as never),
    ).toBe('theme = dark')
  })

  test('checkPermissions auto-allows reads and asks for writes', async () => {
    const read = await ConfigTool.checkPermissions?.(
      { setting: 'theme' } as never,
    )
    expect(read?.behavior).toBe('allow')

    const write = await ConfigTool.checkPermissions?.(
      { setting: 'theme', value: 'dark' } as never,
    )
    expect(write?.behavior).toBe('ask')
    if (write?.behavior === 'ask') {
      expect(write.message).toContain('Set theme to')
    }
  })

  test('call() reports unknown settings without writing anything', async () => {
    const { ctx } = makeCtx()
    const { data } = await ConfigTool.call(
      { setting: 'definitely-not-a-real-setting' } as never,
      ctx,
    )
    expect(data.success).toBe(false)
    expect(data.error).toContain('Unknown setting')
  })

  test('mapToolResultToToolResultBlockParam covers get, set, and error', () => {
    const map = ConfigTool.mapToolResultToToolResultBlockParam
    const get = map?.(
      { success: true, operation: 'get', setting: 'theme', value: 'dark' },
      'u',
    )
    expect(get?.content).toBe('theme = "dark"')

    const set = map?.(
      {
        success: true,
        operation: 'set',
        setting: 'theme',
        newValue: 'light',
      },
      'u',
    )
    expect(set?.content).toBe('Set theme to "light"')

    const err = map?.(
      { success: false, error: 'boom' },
      'u',
    )
    expect(err?.content).toBe('Error: boom')
    expect(err?.is_error).toBe(true)
  })
})
