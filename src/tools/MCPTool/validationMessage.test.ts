import { describe, expect, test } from 'bun:test'

import { buildMcpValidationError, describeSchemaShape } from './validationMessage.js'

describe('describeSchemaShape', () => {
  test('lists required and optional properties with types', () => {
    const schema = {
      type: 'object',
      required: ['libraryName', 'query'],
      properties: {
        libraryName: { type: 'string' },
        query: { type: 'string' },
        max_results: { type: 'number' },
      },
    }
    expect(describeSchemaShape(schema)).toBe(
      'Accepted arguments: libraryName (string, required), query (string, required), max_results (number, optional)',
    )
  })

  test('includes enum values when present', () => {
    const schema = {
      type: 'object',
      required: ['sort'],
      properties: {
        sort: { type: 'string', enum: ['asc', 'desc'] },
      },
    }
    expect(describeSchemaShape(schema)).toBe(
      'Accepted arguments: sort (string, required, one of: "asc" | "desc")',
    )
  })

  test('handles union types and missing type', () => {
    const schema = {
      type: 'object',
      properties: {
        id: { type: ['string', 'number'] },
        anything: {},
      },
    }
    expect(describeSchemaShape(schema)).toBe(
      'Accepted arguments: id (string | number, optional), anything (any, optional)',
    )
  })

  test('returns null for a schema without properties (e.g. top-level oneOf)', () => {
    expect(describeSchemaShape({ oneOf: [{ type: 'string' }] })).toBeNull()
    expect(describeSchemaShape({ type: 'object' })).toBeNull()
    expect(describeSchemaShape({ type: 'object', properties: {} })).toBeNull()
  })

  test('returns null for non-object inputs', () => {
    expect(describeSchemaShape(null)).toBeNull()
    expect(describeSchemaShape(undefined)).toBeNull()
    expect(describeSchemaShape('nope')).toBeNull()
  })

  test('caps a pathologically long enum', () => {
    const enumValues = Array.from({ length: 30 }, (_, i) => `v${i}`)
    const out = describeSchemaShape({
      type: 'object',
      properties: { region: { type: 'string', enum: enumValues } },
    })
    expect(out).toContain('"v0"')
    expect(out).toContain('"v11"')
    expect(out).not.toContain('"v12"')
    expect(out).toContain('… +18 more')
  })

  test('truncates pathologically large schemas', () => {
    const properties: Record<string, unknown> = {}
    for (let i = 0; i < 40; i++) properties[`p${i}`] = { type: 'string' }
    const out = describeSchemaShape({ type: 'object', properties })
    expect(out).toContain('p0 (string, optional)')
    expect(out).toContain('p14 (string, optional)')
    expect(out).not.toContain('p15 (string, optional)')
    expect(out).toContain('… +25 more')
  })
})

describe('buildMcpValidationError', () => {
  test('appends the shape summary on its own line', () => {
    const schema = {
      type: 'object',
      required: ['libraryName'],
      properties: { libraryName: { type: 'string' } },
    }
    const out = buildMcpValidationError(schema, "data must have required property 'libraryName'")
    expect(out).toBe(
      "data must have required property 'libraryName'\nAccepted arguments: libraryName (string, required)",
    )
  })

  test('falls back to raw errorsText when shape is undescribable', () => {
    const out = buildMcpValidationError({ oneOf: [] }, 'some ajv error')
    expect(out).toBe('some ajv error')
  })
})
