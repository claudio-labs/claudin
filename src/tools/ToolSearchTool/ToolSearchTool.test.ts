import { describe, expect, test } from 'bun:test'

import type { Tool, ToolUseContext } from 'src/Tool.js'
import { clearToolSearchDescriptionCache, ToolSearchTool } from 'src/tools/ToolSearchTool/ToolSearchTool.js'

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: overrides.name ?? 'AnyTool',
    shouldDefer: true,
    async description() {
      return 'desc'
    },
    async prompt() {
      return overrides.name ?? 'AnyTool'
    },
    userFacingName: () => overrides.name ?? 'AnyTool',
    inputSchema: { safeParse: () => ({ success: true }) } as never,
    outputSchema: { safeParse: () => ({ success: true }) } as never,
    isEnabled: () => true,
    isMcp: false,
    ...overrides,
  } as unknown as Tool
}

function makeCtx(tools: Tool[]): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({ mcp: { clients: [] } }),
    setAppState: () => {},
    options: { tools },
  } as unknown as ToolUseContext
}

describe('ToolSearchTool', () => {
  test('flags: read-only and concurrency-safe', () => {
    expect(ToolSearchTool.isReadOnly?.()).toBe(true)
    expect(ToolSearchTool.isConcurrencySafe?.()).toBe(true)
  })

  test('userFacingName is empty (rendered by UI helpers)', () => {
    expect(ToolSearchTool.userFacingName()).toBe('')
  })

  test('input schema requires query and defaults max_results to 5', () => {
    expect(ToolSearchTool.inputSchema.safeParse({}).success).toBe(false)
    const parsed = ToolSearchTool.inputSchema.safeParse({ query: 'hello' })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.max_results).toBe(5)
    }
  })

  test('select:<name> returns the matching deferred tool', async () => {
    clearToolSearchDescriptionCache()
    const ctx = makeCtx([
      makeTool({ name: 'AnyTool', shouldDefer: true } as Partial<Tool>),
      makeTool({ name: 'Other', shouldDefer: true } as Partial<Tool>),
    ])
    const { data } = await ToolSearchTool.call(
      { query: 'select:AnyTool', max_results: 5 } as never,
      ctx,
    )
    expect(data.matches).toContain('AnyTool')
    expect(data.total_deferred_tools).toBe(2)
  })

  test('select:<missing> returns empty matches and reports total deferred', async () => {
    clearToolSearchDescriptionCache()
    const ctx = makeCtx([
      makeTool({ name: 'AnyTool', shouldDefer: true } as Partial<Tool>),
    ])
    const { data } = await ToolSearchTool.call(
      { query: 'select:DoesNotExist', max_results: 5 } as never,
      ctx,
    )
    expect(data.matches).toEqual([])
    expect(data.total_deferred_tools).toBe(1)
  })

  test('keyword search filters to deferred tools and respects max_results', async () => {
    clearToolSearchDescriptionCache()
    const ctx = makeCtx([
      makeTool({ name: 'AnyTool', shouldDefer: true } as Partial<Tool>),
      makeTool({ name: 'OtherTool', shouldDefer: true } as Partial<Tool>),
      makeTool({ name: 'AnyTwo', shouldDefer: true } as Partial<Tool>),
    ])
    const { data } = await ToolSearchTool.call(
      { query: 'any', max_results: 1 } as never,
      ctx,
    )
    expect(data.matches.length).toBeLessThanOrEqual(1)
    expect(data.query).toBe('any')
  })

  test('mapToolResultToToolResultBlockParam handles empty + pending servers', () => {
    const map = ToolSearchTool.mapToolResultToToolResultBlockParam
    const empty = map?.(
      { matches: [], query: 'x', total_deferred_tools: 0 },
      'u',
    )
    expect(empty?.content).toBe('No matching deferred tools found')

    const pending = map?.(
      {
        matches: [],
        query: 'x',
        total_deferred_tools: 0,
        pending_mcp_servers: ['srv-a'],
      },
      'u',
    )
    expect(pending?.content).toContain('srv-a')
    expect(pending?.content).toContain('still connecting')
  })

  test('mapToolResultToToolResultBlockParam wraps matches as tool_reference blocks', () => {
    const map = ToolSearchTool.mapToolResultToToolResultBlockParam
    const block = map?.(
      { matches: ['Foo', 'Bar'], query: 'x', total_deferred_tools: 5 },
      'u',
    )
    expect(Array.isArray(block?.content)).toBe(true)
    const items = block?.content as Array<{
      type: string
      tool_name: string
    }>
    expect(items?.map(i => i.tool_name)).toEqual(['Foo', 'Bar'])
    expect(items?.[0]?.type).toBe('tool_reference')
  })
})
