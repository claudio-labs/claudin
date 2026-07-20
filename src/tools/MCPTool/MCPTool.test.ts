import { describe, expect, test } from 'bun:test'

import type { ToolUseContext } from '../../Tool.js'
import { MCPTool } from './MCPTool.js'

function makeCtx(): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

describe('MCPTool (base scaffold)', () => {
  test('isMcp is true, isOpenWorld is false', () => {
    expect(MCPTool.isMcp).toBe(true)
    expect(MCPTool.isOpenWorld?.()).toBe(false)
  })

  test('default name and userFacingName are mcp placeholders', () => {
    expect(MCPTool.name).toBe('mcp')
    expect(MCPTool.userFacingName()).toBe('mcp')
  })

  test('input schema is permissive (passthrough on unknown keys)', () => {
    expect(MCPTool.inputSchema.safeParse({}).success).toBe(true)
    expect(MCPTool.inputSchema.safeParse({ anything: true }).success).toBe(true)
  })

  test('output schema accepts both string and content-block array', () => {
    expect(MCPTool.outputSchema.safeParse('text').success).toBe(true)
    expect(
      MCPTool.outputSchema.safeParse([{ type: 'text', text: 'hi' }]).success,
    ).toBe(true)
    // Wrong shape: number rejected
    expect(MCPTool.outputSchema.safeParse(42).success).toBe(false)
  })

  test('checkPermissions returns passthrough so the dialog is owned by the runtime', async () => {
    const result = await MCPTool.checkPermissions?.(
      {} as never,
      makeCtx(),
    )
    expect(result?.behavior).toBe('passthrough')
  })

  test('validateInput passes when no inputJSONSchema is set', async () => {
    const result = await MCPTool.validateInput?.({} as never, makeCtx())
    expect(result?.result).toBe(true)
  })

  test('validateInput rejects payload that fails compiled JSON schema', async () => {
    const toolWithSchema = {
      ...MCPTool,
      inputJSONSchema: {
        type: 'object',
        required: ['needed'],
        properties: { needed: { type: 'string' } },
      },
    }
    const result = await toolWithSchema.validateInput?.(
      {} as never,
      makeCtx(),
    )
    expect(result?.result).toBe(false)
  })

  test('validateInput reports all missing required fields at once and lists accepted args', async () => {
    const toolWithSchema = {
      ...MCPTool,
      inputJSONSchema: {
        type: 'object',
        required: ['libraryName', 'query'],
        properties: {
          libraryName: { type: 'string' },
          query: { type: 'string' },
        },
      },
    }
    const result = await toolWithSchema.validateInput?.({} as never, makeCtx())
    expect(result?.result).toBe(false)
    if (result?.result !== false) throw new Error('expected validation failure')
    // allErrors: true surfaces BOTH missing fields in the raw Ajv line (the
    // first line, before the appended hint). Asserting the first line — not the
    // whole message — is what actually pins the flag: with allErrors off the
    // Ajv line would name only ONE field even though the hint names both.
    const ajvLine = result.message.split('\n')[0]
    expect(ajvLine).toContain('libraryName')
    expect(ajvLine).toContain('query')
    // Enriched hint lists the accepted arguments so the model stops re-guessing.
    expect(result.message).toContain(
      'Accepted arguments: libraryName (string, required), query (string, required)',
    )
  })

  test('isResultTruncated returns false for short string and false for short blocks', () => {
    expect(MCPTool.isResultTruncated?.('short')).toBe(false)
    expect(
      MCPTool.isResultTruncated?.([{ type: 'text', text: 'short' }]),
    ).toBe(false)
  })

  test('mapToolResultToToolResultBlockParam wraps content verbatim', () => {
    const block = MCPTool.mapToolResultToToolResultBlockParam?.(
      'hello',
      'u1',
    )
    expect(block).toEqual({
      tool_use_id: 'u1',
      type: 'tool_result',
      content: 'hello',
    })
  })

  test('default call() returns empty data (overridden by mcpClient.ts)', async () => {
    const { data } = await MCPTool.call({} as never, makeCtx())
    expect(data).toBe('')
  })
})
