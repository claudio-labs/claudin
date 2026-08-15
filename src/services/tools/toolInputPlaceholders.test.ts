import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { stripPlaceholderOptionalFields } from 'src/services/tools/toolInputPlaceholders.js'

// Mirrors the shape a strict-schema provider hits hardest: a required string,
// optional strings, an optional enum and an optional number.
const zodTool = {
  inputSchema: z.strictObject({
    file_path: z.string(),
    offset: z.number().int().optional(),
    pages: z.string().optional(),
    view: z.enum(['outline', 'full']).optional(),
    symbol: z.string().optional(),
  }),
}

// An MCP tool: passthrough zod schema, real schema in inputJSONSchema.
const mcpTool = {
  inputSchema: z.object({}).passthrough(),
  inputJSONSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      cursor: { type: 'string' },
    },
    required: ['query'],
  },
}

describe('stripPlaceholderOptionalFields', () => {
  test('drops empty-string and null placeholders for optional keys', () => {
    // The exact Read input the Codex transport produced 135 times in one
    // session, each answered with `Invalid pages parameter: ""`.
    const input: Record<string, unknown> = {
      file_path: '/repo/CalculoSimulacaoMapper.java',
      limit: 190,
      offset: 1,
      pages: '',
      symbol: '',
      view: 'full',
    }

    expect(stripPlaceholderOptionalFields(zodTool, input)).toEqual({
      file_path: '/repo/CalculoSimulacaoMapper.java',
      limit: 190,
      offset: 1,
      view: 'full',
    })
    const nulled: Record<string, unknown> = { file_path: '/a', pages: null }
    expect(stripPlaceholderOptionalFields(zodTool, nulled)).toEqual({
      file_path: '/a',
    })
  })

  test('keeps placeholders on required keys so validation still reports them', () => {
    const input = { file_path: '', pages: '3-5' }
    expect(stripPlaceholderOptionalFields(zodTool, input)).toEqual(input)
  })

  test('keeps keys the schema does not declare, and real values', () => {
    const input = { file_path: '/a', pages: '1-2', unknown_key: '' }
    expect(stripPlaceholderOptionalFields(zodTool, input)).toEqual(input)
  })

  test('returns the same object when there is nothing to strip', () => {
    const input = { file_path: '/a', offset: 0 }
    expect(stripPlaceholderOptionalFields(zodTool, input)).toBe(input)
  })

  test('an optional field wrapped in a preprocess still reads as optional', () => {
    // semanticNumber() wraps tool number fields; the optionality check has to
    // see through the wrapper or `limit: null` would survive.
    const wrapped = {
      inputSchema: z.strictObject({
        limit: z.preprocess(v => v, z.number().optional()),
      }),
    }
    const input: Record<string, unknown> = { limit: null }
    expect(stripPlaceholderOptionalFields(wrapped, input)).toEqual({})
  })

  test('keeps the value when the schema cannot be converted', () => {
    const exploding = { inputSchema: { not: 'a zod schema' } }
    const input = { pages: '' }
    expect(stripPlaceholderOptionalFields(exploding, input)).toEqual(input)
  })

  // ---- Nesting: codexShim widens at every level, so this must too ----

  test('strips placeholders inside nested objects and array items', () => {
    // ReportFindings' real shape. codexShim recurses into `items` and widens
    // each optional property there, so the model sends `line: null` inside an
    // array element — one level below where a top-level-only pass can see it.
    const nested = {
      inputSchema: z.strictObject({
        summary: z.string(),
        findings: z.array(
          z.strictObject({
            file: z.string(),
            line: z.number().optional(),
            verdict: z.enum(['CONFIRMED', 'PLAUSIBLE']).optional(),
          }),
        ),
        meta: z
          .strictObject({ branch: z.string(), note: z.string().optional() })
          .optional(),
      }),
    }

    const input: Record<string, unknown> = {
      summary: 'two findings',
      findings: [
        { file: 'a.ts', line: null, verdict: null },
        { file: 'b.ts', line: 12, verdict: 'CONFIRMED' },
      ],
      meta: { branch: 'main', note: '' },
    }

    expect(stripPlaceholderOptionalFields(nested, input)).toEqual({
      summary: 'two findings',
      findings: [{ file: 'a.ts' }, { file: 'b.ts', line: 12, verdict: 'CONFIRMED' }],
      meta: { branch: 'main' },
    })
  })

  test('keeps a nested placeholder the schema marks required', () => {
    const nested = {
      inputSchema: z.strictObject({
        entry: z.strictObject({ path: z.string(), tag: z.string().optional() }),
      }),
    }
    const input: Record<string, unknown> = { entry: { path: '', tag: '' } }
    expect(stripPlaceholderOptionalFields(nested, input)).toEqual({
      entry: { path: '' },
    })
  })

  test('recurses into a nested MCP inputJSONSchema', () => {
    const nestedMcp = {
      inputJSONSchema: {
        type: 'object',
        properties: {
          filter: {
            type: 'object',
            properties: { owner: { type: 'string' }, label: { type: 'string' } },
            required: ['owner'],
          },
        },
        required: ['filter'],
      },
    }
    const input: Record<string, unknown> = { filter: { owner: 'me', label: null } }
    expect(stripPlaceholderOptionalFields(nestedMcp, input)).toEqual({
      filter: { owner: 'me' },
    })
  })

  test('leaves untouched levels identical, not copied', () => {
    const nested = {
      inputSchema: z.strictObject({
        keep: z.strictObject({ a: z.string() }),
        drop: z.string().optional(),
      }),
    }
    const keep = { a: 'x' }
    const result = stripPlaceholderOptionalFields(nested, { keep, drop: '' }) as {
      keep: unknown
    }
    expect(result.keep).toBe(keep)
  })

  // ---- MCP path: the zod schema is a passthrough, inputJSONSchema is real ----

  test('reads optionality from inputJSONSchema when the tool has one', () => {
    // Without this the MCP branch is a silent no-op: the passthrough zod shape
    // is `{}`, so no key ever resolves — while codexShim has already widened
    // these args to nullable, sending `null` into MCPTool's Ajv check.
    const input: Record<string, unknown> = {
      query: 'files',
      cursor: null,
      extra: '',
    }
    expect(stripPlaceholderOptionalFields(mcpTool, input)).toEqual({
      query: 'files',
      extra: '', // not declared by the server — its Ajv owns that complaint
    })
  })

  test('keeps a placeholder the MCP server marks required', () => {
    const input = { query: '', cursor: 'abc' }
    expect(stripPlaceholderOptionalFields(mcpTool, input)).toEqual(input)
  })

  test('an MCP schema with no required list marks every property optional', () => {
    const looseTool = {
      inputJSONSchema: {
        type: 'object',
        properties: { server: { type: 'string' } },
      },
    }
    const input: Record<string, unknown> = { server: '' }
    expect(stripPlaceholderOptionalFields(looseTool, input)).toEqual({})
  })

  test('falls back to the zod shape when inputJSONSchema has no properties', () => {
    const hybrid = { ...zodTool, inputJSONSchema: { type: 'object' } }
    const input: Record<string, unknown> = { file_path: '/a', pages: '' }
    expect(stripPlaceholderOptionalFields(hybrid, input)).toEqual({
      file_path: '/a',
    })
  })

  test('passes through non-object input and schemaless tools', () => {
    expect(stripPlaceholderOptionalFields(zodTool, null)).toBeNull()
    expect(stripPlaceholderOptionalFields({}, { pages: '' })).toEqual({
      pages: '',
    })
    // Arrays keep their identity: without the Array.isArray guard the copy
    // below would come back as a plain object with index 0 deleted.
    const indexed = {
      inputSchema: z.strictObject({ '0': z.string().optional() }),
    }
    expect(stripPlaceholderOptionalFields(indexed, ['', 'x'])).toEqual(['', 'x'])
  })
})
