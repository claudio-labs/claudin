import { describe, expect, test } from 'bun:test'

import type { ToolUseContext } from 'src/tools/Tool.js'
import { stripPlaceholderOptionalFields } from 'src/agent/tools/toolInputPlaceholders.js'
import { MCPTool } from 'src/tools/MCPTool/MCPTool.js'

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

  test('a nulled optional arg only survives Ajv once the placeholder is stripped', async () => {
    // Codex sends every optional arg as `null` (codexShim widens them so the
    // model can express "skip this"), and Ajv here validates against the
    // SERVER's schema, which says `"type": "string"` — so the null is a hard
    // rejection unless stripPlaceholderOptionalFields removed the key first.
    // MCPTool's own zod schema is a passthrough, so that helper has to read
    // inputJSONSchema; if it goes back to reading only the zod shape, the
    // first expectation below flips to false.
    const toolWithSchema = {
      ...MCPTool,
      inputJSONSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' },
          cursor: { type: 'string' },
        },
      },
    }
    const raw = { query: 'files', cursor: null }
    const stripped = stripPlaceholderOptionalFields(toolWithSchema, raw)

    const afterStrip = await toolWithSchema.validateInput?.(
      stripped as never,
      makeCtx(),
    )
    expect(afterStrip?.result).toBe(true)

    const withPlaceholder = await toolWithSchema.validateInput?.(
      raw as never,
      makeCtx(),
    )
    expect(withPlaceholder?.result).toBe(false)
  })

  // What @playwright/mcp announces: every tool's inputSchema names 2020-12.
  for (const draft of ['2020-12', '2019-09']) {
    test(`a schema declaring draft ${draft} validates instead of refusing the call`, async () => {
      const toolWithSchema = {
        ...MCPTool,
        inputJSONSchema: {
          $schema: `https://json-schema.org/draft/${draft}/schema`,
          type: 'object',
          required: ['url'],
          properties: { url: { type: 'string' } },
          additionalProperties: false,
        },
      }
      // The bad call goes first, on purpose: Ajv caches a schema before it
      // checks the meta-schema, so with the wrong validator only the FIRST
      // compile of a schema object throws, and a second call would pass.
      const bad = await toolWithSchema.validateInput?.(
        { query: 'x' } as never,
        makeCtx(),
      )
      if (bad?.result !== false) throw new Error('expected validation failure')
      expect(bad.message).toContain("must have required property 'url'")

      const ok = await toolWithSchema.validateInput?.(
        { url: 'http://10.0.1.1:8080/' } as never,
        makeCtx(),
      )
      expect(ok?.result).toBe(true)
    })
  }

  test('a schema no validator can compile lets every call through to the server', async () => {
    // draft-04 has no meta-schema in Ajv 8; the server still validates.
    const toolWithSchema = {
      ...MCPTool,
      inputJSONSchema: {
        $schema: 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        required: ['url'],
        properties: { url: { type: 'string' } },
      },
    }
    // Twice: Ajv caches the schema before its meta-schema check, so a second
    // compile would succeed and refuse what the first let through.
    for (const _ of [1, 2]) {
      const result = await toolWithSchema.validateInput?.({} as never, makeCtx())
      expect(result?.result).toBe(true)
    }
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
