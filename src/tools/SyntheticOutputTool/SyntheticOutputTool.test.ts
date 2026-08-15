import { describe, expect, test } from 'bun:test'

import {
  createSyntheticOutputTool,
  isSyntheticOutputToolEnabled,
  SyntheticOutputTool,
} from 'src/tools/SyntheticOutputTool/SyntheticOutputTool.js'

describe('SyntheticOutputTool (base)', () => {
  test('flags: read-only, concurrency-safe, not open-world, not MCP', () => {
    expect(SyntheticOutputTool.isReadOnly?.()).toBe(true)
    expect(SyntheticOutputTool.isConcurrencySafe?.()).toBe(true)
    expect(SyntheticOutputTool.isOpenWorld?.()).toBe(false)
    expect(SyntheticOutputTool.isMcp).toBe(false)
  })

  test('isEnabled() always returns true once created', () => {
    expect(SyntheticOutputTool.isEnabled?.()).toBe(true)
  })

  test('input schema is passthrough', () => {
    expect(SyntheticOutputTool.inputSchema.safeParse({}).success).toBe(true)
    expect(SyntheticOutputTool.inputSchema.safeParse({ a: 1 }).success).toBe(
      true,
    )
  })

  test('checkPermissions always allows', async () => {
    const result = await SyntheticOutputTool.checkPermissions?.(
      {} as never,
    )
    expect(result?.behavior).toBe('allow')
  })

  test('call() reports success and surfaces structured_output', async () => {
    const result = await SyntheticOutputTool.call(
      { foo: 'bar' } as never,
    )
    expect(result.data).toBe('Structured output provided successfully')
    expect(
      (result as { structured_output: unknown }).structured_output,
    ).toEqual({ foo: 'bar' })
  })

  test('renderToolUseMessage compacts large keysets', () => {
    expect(
      SyntheticOutputTool.renderToolUseMessage?.({} as never),
    ).toBeNull()
    expect(
      SyntheticOutputTool.renderToolUseMessage?.(
        { a: 1, b: 2, c: 3, d: 4 } as never,
      ),
    ).toBe('4 fields: a, b, c…')
  })

  test('mapToolResultToToolResultBlockParam forwards content', () => {
    const block = SyntheticOutputTool.mapToolResultToToolResultBlockParam?.(
      'hi',
      'u1',
    )
    expect(block).toEqual({
      tool_use_id: 'u1',
      type: 'tool_result',
      content: 'hi',
    })
  })
})

describe('isSyntheticOutputToolEnabled', () => {
  test('mirrors isNonInteractiveSession flag', () => {
    expect(isSyntheticOutputToolEnabled({ isNonInteractiveSession: true })).toBe(
      true,
    )
    expect(
      isSyntheticOutputToolEnabled({ isNonInteractiveSession: false }),
    ).toBe(false)
  })
})

describe('createSyntheticOutputTool', () => {
  test('returns an error on invalid JSON schema', () => {
    // 'type' must be a string per JSON Schema
    const result = createSyntheticOutputTool({ type: 42 } as never)
    expect('error' in result).toBe(true)
  })

  test('returns a tool when the schema compiles, and validates input on call()', async () => {
    const result = createSyntheticOutputTool({
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
      additionalProperties: false,
    })
    expect('tool' in result).toBe(true)
    if ('tool' in result) {
      const ok = await result.tool.call({ count: 7 } as never, {} as never, {} as never, {} as never)
      expect(ok.data).toBe('Structured output provided successfully')

      await expect(
        result.tool.call({ count: 'bad' } as never, {} as never, {} as never, {} as never),
      ).rejects.toThrow('Output does not match required schema')
    }
  })

  test('caches tools by schema identity (returns same result)', () => {
    const schema = { type: 'object' }
    const a = createSyntheticOutputTool(schema)
    const b = createSyntheticOutputTool(schema)
    expect(a).toBe(b)
  })
})
