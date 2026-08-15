import { describe, expect, test } from 'bun:test'

import type { ToolUseContext } from 'src/Tool.js'
import { createMcpAuthTool } from 'src/tools/McpAuthTool/McpAuthTool.js'

function makeCtx(): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({ mcp: { clients: [], tools: [], commands: [] } }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

describe('createMcpAuthTool', () => {
  test('tool identity is mcp-namespaced and labelled', () => {
    const tool = createMcpAuthTool('acme', {
      type: 'http',
      url: 'https://acme.example/mcp',
    } as never)
    expect(tool.name).toBe('mcp__acme__authenticate')
    expect(tool.isMcp).toBe(true)
    expect(tool.mcpInfo).toEqual({ serverName: 'acme', toolName: 'authenticate' })
    expect(tool.userFacingName(undefined)).toBe('acme - authenticate (MCP)')
  })

  test('flags: not read-only, not concurrency-safe, always enabled', () => {
    const tool = createMcpAuthTool('acme', { type: 'http' } as never)
    expect(tool.isReadOnly?.({} as never)).toBe(false)
    expect(tool.isConcurrencySafe?.({} as never)).toBe(false)
    expect(tool.isEnabled?.()).toBe(true)
  })

  test('input schema accepts only empty object', () => {
    const tool = createMcpAuthTool('acme', { type: 'http' } as never)
    expect(tool.inputSchema.safeParse({}).success).toBe(true)
  })

  test('checkPermissions auto-allows the call', async () => {
    const tool = createMcpAuthTool('acme', { type: 'http' } as never)
    const result = await tool.checkPermissions?.(
      {} as never,
      makeCtx(),
    )
    expect(result?.behavior).toBe('allow')
  })

  test('call() returns unsupported for claudeai-proxy transport', async () => {
    const tool = createMcpAuthTool('acme', {
      type: 'claudeai-proxy',
    } as never)
    const { data } = await tool.call(
      {} as never,
      makeCtx(),
      {} as never,
      {} as never,
    )
    expect(data.status).toBe('unsupported')
    expect(data.message).toContain('claude.ai MCP connector')
  })

  test('call() returns unsupported for stdio transport', async () => {
    const tool = createMcpAuthTool('acme', { type: 'stdio' } as never)
    const { data } = await tool.call(
      {} as never,
      makeCtx(),
      {} as never,
      {} as never,
    )
    expect(data.status).toBe('unsupported')
    expect(data.message).toContain('does not support OAuth')
  })

  test('mapToolResultToToolResultBlockParam forwards the message', () => {
    const tool = createMcpAuthTool('acme', { type: 'http' } as never)
    const block = tool.mapToolResultToToolResultBlockParam?.(
      { status: 'unsupported', message: 'hi' },
      'u1',
    )
    expect(block).toEqual({
      tool_use_id: 'u1',
      type: 'tool_result',
      content: 'hi',
    })
  })

  test('toAutoClassifierInput returns the server name', () => {
    const tool = createMcpAuthTool('acme', { type: 'http' } as never)
    expect(tool.toAutoClassifierInput?.({} as never)).toBe('acme')
  })
})
