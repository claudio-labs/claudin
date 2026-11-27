import { describe, expect, test } from 'bun:test'
import type { Tool } from '@modelcontextprotocol/client'
import { z } from 'zod/v4'
import {
  isSchemaError,
  keepValidPrompts,
  keepValidResources,
  keepValidResourceTemplates,
  keepValidTools,
  LenientPromptsPageSchema,
  LenientResourcesPageSchema,
  LenientResourceTemplatesPageSchema,
  LenientToolsPageSchema,
} from 'src/mcp/client/listValidation.js'

describe('lenient page schemas', () => {
  test('accept any entries and keep the cursor and extra fields', () => {
    const page = { tools: [1, 'two', { name: 'x' }], nextCursor: 'c2', _meta: { a: 1 } }
    expect(LenientToolsPageSchema.parse(page)).toEqual(page)
    expect(LenientPromptsPageSchema.parse({ prompts: [null] })).toEqual({ prompts: [null] })
    expect(LenientResourcesPageSchema.parse({ resources: [] })).toEqual({ resources: [] })
    expect(LenientResourceTemplatesPageSchema.parse({ resourceTemplates: [7] })).toEqual({ resourceTemplates: [7] })
  })

  test('refuse a page whose list is not a list, as a schema error', () => {
    const result = LenientToolsPageSchema.safeParse({ tools: 'nope' })
    expect(result.success).toBe(false)
    expect(isSchemaError(result.error)).toBe(true)
  })
})

describe('isSchemaError', () => {
  test('is true for a zod error only', () => {
    expect(isSchemaError(z.string().safeParse(1).error)).toBe(true)
    expect(isSchemaError(new Error('ECONNRESET'))).toBe(false)
    expect(isSchemaError('boom')).toBe(false)
  })
})

describe('keepValidTools', () => {
  test('keeps a well-formed tool as the SDK parses it', () => {
    const tool: Tool = {
      name: 'search',
      description: 'Search things',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      annotations: { readOnlyHint: true },
    }
    expect(keepValidTools([tool])).toEqual({ items: [tool], skipped: [] })
  })

  test('skips entries that are not tools, with the reason', () => {
    const { items, skipped } = keepValidTools([
      'a string',
      { name: '', inputSchema: { type: 'object' } },
      { name: 7, inputSchema: { type: 'object' } },
      { name: 'no-schema' },
      { name: 'array-schema', inputSchema: [] },
      { name: 'string-schema', inputSchema: { type: 'string' } },
    ])
    expect(items).toEqual([])
    expect(skipped).toEqual([
      { reason: 'not an object' },
      { name: '', reason: 'name is not a non-empty string' },
      { name: undefined, reason: 'name is not a non-empty string' },
      { name: 'no-schema', reason: 'inputSchema is not an object' },
      { name: 'array-schema', reason: 'inputSchema is not an object' },
      { name: 'string-schema', reason: 'inputSchema type is not "object"' },
    ])
  })

  test('fills in a missing inputSchema type and drops a malformed top-level properties or required', () => {
    const { items, skipped } = keepValidTools([
      { name: 'untyped', inputSchema: { properties: { a: { type: 'number' } } } },
      { name: 'bad-props', inputSchema: { type: 'object', properties: ['a'], required: ['a'] } },
      { name: 'bad-required', inputSchema: { type: 'object', required: [1, 'a'] } },
    ])
    expect(skipped).toEqual([])
    expect(items.map(t => t.inputSchema)).toEqual([
      { type: 'object', properties: { a: { type: 'number' } } },
      { type: 'object', required: ['a'] },
      { type: 'object' },
    ])
  })

  test('keeps the rest of the inputSchema as the server wrote it', () => {
    const { items } = keepValidTools([
      { name: 't', inputSchema: { type: 'object', additionalProperties: false, $defs: { x: {} } } },
    ])
    expect(items[0]!.inputSchema).toEqual({ type: 'object', additionalProperties: false, $defs: { x: {} } })
  })

  test('drops an optional field of the wrong type and keeps the tool', () => {
    const { items, skipped } = keepValidTools([
      { name: 't', description: 42, annotations: 'read-only', inputSchema: { type: 'object' } },
    ])
    expect(skipped).toEqual([])
    expect(items).toEqual([{ name: 't', inputSchema: { type: 'object' } }])
  })

  test('skips a tool whose nested property schema is not a schema', () => {
    const { items, skipped } = keepValidTools([
      { name: 'nested', inputSchema: { type: 'object', properties: { q: 'string' } } },
    ])
    expect(items).toEqual([])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.name).toBe('nested')
    expect(skipped[0]!.reason).toStartWith('inputSchema.properties.q: ')
  })
})

describe('keepValidPrompts', () => {
  test('keeps well-formed prompts and skips one with malformed arguments', () => {
    const { items, skipped } = keepValidPrompts([
      { name: 'good', arguments: [{ name: 'file', required: true }] },
      { name: 'bad', arguments: 'x' },
      { description: 'no name' },
    ])
    expect(items).toEqual([{ name: 'good', arguments: [{ name: 'file', required: true }] }])
    expect(skipped.map(s => s.name)).toEqual(['bad', undefined])
    expect(skipped[0]!.reason).toStartWith('arguments: ')
    expect(skipped[1]!.reason).toStartWith('name: ')
  })

  test('drops a wrong-typed description and keeps the prompt', () => {
    expect(keepValidPrompts([{ name: 'p', description: ['x'] }])).toEqual({ items: [{ name: 'p' }], skipped: [] })
  })
})

describe('keepValidResources and keepValidResourceTemplates', () => {
  test('a resource needs a uri and a name; a bad mimeType is dropped', () => {
    const { items, skipped } = keepValidResources([
      { uri: 'file:///ok', name: 'ok', mimeType: 5 },
      { name: 'no-uri' },
    ])
    expect(items).toEqual([{ uri: 'file:///ok', name: 'ok' }])
    expect(skipped.map(s => s.name)).toEqual(['no-uri'])
  })

  test('a template needs a uriTemplate', () => {
    const { items, skipped } = keepValidResourceTemplates([
      { uriTemplate: 'file:///{path}', name: 'files', description: 'Any file' },
      { name: 'no-template' },
    ])
    expect(items).toEqual([{ uriTemplate: 'file:///{path}', name: 'files', description: 'Any file' }])
    expect(skipped.map(s => s.name)).toEqual(['no-template'])
  })

  test('a field still wrong after the drop skips the entry', () => {
    // `size` is droppable, `name` is not: both wrong, so the entry goes.
    const { items, skipped } = keepValidResources([{ uri: 'file:///x', name: 1, size: 'big' }])
    expect(items).toEqual([])
    expect(skipped).toHaveLength(1)
  })
})
