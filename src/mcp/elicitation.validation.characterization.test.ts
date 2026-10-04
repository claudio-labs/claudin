/**
 * Characterization of the field checks behind an MCP elicitation form
 * (`elicitationValidation.ts`), pinned before the clean-base rewrite.
 *
 * Every case is a schema as a server may send it in `requestedSchema`, and the
 * raw text the user typed. The natural-language date path, which needs the
 * model, is pinned in `elicitation.dateTime.characterization.test.ts`.
 */
import { describe, expect, test } from 'bun:test'
import type {
  EnumSchema,
  MultiSelectEnumSchema,
  PrimitiveSchemaDefinition,
} from '@modelcontextprotocol/sdk/types.js'

import {
  getEnumLabel,
  getEnumLabels,
  getEnumValues,
  getMultiSelectLabel,
  getMultiSelectLabels,
  getMultiSelectValues,
  isDateTimeSchema,
  isEnumSchema,
  isMultiSelectEnumSchema,
  validateElicitationInput,
} from 'src/mcp/elicitationValidation.js'

const asField = (schema: object) => schema as PrimitiveSchemaDefinition

// --- what kind of field a schema describes ---------------------------------

describe('field kinds', () => {
  const kinds: Array<{ schema: object; single: boolean; multi: boolean; dated: boolean }> = [
    { schema: { type: 'string' }, single: false, multi: false, dated: false },
    { schema: { type: 'string', enum: ['a'] }, single: true, multi: false, dated: false },
    { schema: { type: 'string', enum: [] }, single: true, multi: false, dated: false },
    { schema: { type: 'string', oneOf: [{ const: 'a', title: 'A' }] }, single: true, multi: false, dated: false },
    { schema: { type: 'number', enum: [1, 2] }, single: false, multi: false, dated: false },
    { schema: { type: 'array', items: { type: 'string', enum: ['a'] } }, single: false, multi: true, dated: false },
    { schema: { type: 'array', items: { anyOf: [{ const: 'a', title: 'A' }] } }, single: false, multi: true, dated: false },
    { schema: { type: 'array', items: { type: 'string' } }, single: false, multi: false, dated: false },
    { schema: { type: 'array', items: null }, single: false, multi: false, dated: false },
    { schema: { type: 'array' }, single: false, multi: false, dated: false },
    { schema: { type: 'object', items: { enum: ['a'] } }, single: false, multi: false, dated: false },
    { schema: { type: 'string', format: 'date' }, single: false, multi: false, dated: true },
    { schema: { type: 'string', format: 'date-time' }, single: false, multi: false, dated: true },
    { schema: { type: 'string', format: 'email' }, single: false, multi: false, dated: false },
    { schema: { type: 'string', format: 'time' }, single: false, multi: false, dated: false },
    { schema: { type: 'number', format: 'date' }, single: false, multi: false, dated: false },
    { schema: { type: 'boolean' }, single: false, multi: false, dated: false },
  ]

  for (const { schema, single, multi, dated } of kinds) {
    test(JSON.stringify(schema), () => {
      expect({
        single: isEnumSchema(asField(schema)),
        multi: isMultiSelectEnumSchema(asField(schema)),
        dated: isDateTimeSchema(asField(schema)),
      }).toEqual({ single, multi, dated })
    })
  }
})

// --- choices and their labels ----------------------------------------------

describe('single-choice values and labels', () => {
  const plain = { type: 'string', enum: ['s', 'm', 'l'] } as EnumSchema
  const named = { type: 'string', enum: ['s', 'm', 'l'], enumNames: ['Small', 'Medium'] } as unknown as EnumSchema
  const titled = {
    type: 'string',
    oneOf: [
      { const: 'eu', title: 'Europe' },
      { const: 'us', title: 'United States' },
    ],
  } as EnumSchema
  const neither = { type: 'string' } as unknown as EnumSchema

  test('values come from `enum`, or from the `const` of each `oneOf` entry, in order', () => {
    expect(getEnumValues(plain)).toEqual(['s', 'm', 'l'])
    expect(getEnumValues(titled)).toEqual(['eu', 'us'])
    expect(getEnumValues(neither)).toEqual([])
  })

  test('labels are the `oneOf` titles, else the legacy `enumNames`, else the values', () => {
    expect(getEnumLabels(titled)).toEqual(['Europe', 'United States'])
    expect(getEnumLabels(named)).toEqual(['Small', 'Medium'])
    expect(getEnumLabels(plain)).toEqual(['s', 'm', 'l'])
    expect(getEnumLabels(neither)).toEqual([])
  })

  const lookups: Array<[EnumSchema, string, string]> = [
    [titled, 'us', 'United States'],
    [titled, 'mars', 'mars'],
    [named, 'm', 'Medium'],
    [named, 'l', 'l'],
    [plain, 'm', 'm'],
  ]
  for (const [schema, value, label] of lookups) {
    test(`the label of ${value} is ${label}`, () => {
      expect(getEnumLabel(schema, value)).toBe(label)
    })
  }
})

describe('multi-choice values and labels', () => {
  const plain = { type: 'array', items: { type: 'string', enum: ['r', 'g'] } } as MultiSelectEnumSchema
  const titled = {
    type: 'array',
    items: {
      anyOf: [
        { const: 'r', title: 'Red' },
        { const: 'g', title: 'Green' },
      ],
    },
  } as MultiSelectEnumSchema
  const neither = { type: 'array', items: { type: 'string' } } as unknown as MultiSelectEnumSchema

  test('values come from `items.enum`, or from the `const` of each `items.anyOf` entry', () => {
    expect(getMultiSelectValues(plain)).toEqual(['r', 'g'])
    expect(getMultiSelectValues(titled)).toEqual(['r', 'g'])
    expect(getMultiSelectValues(neither)).toEqual([])
  })

  test('labels are the `anyOf` titles, else the values', () => {
    expect(getMultiSelectLabels(titled)).toEqual(['Red', 'Green'])
    expect(getMultiSelectLabels(plain)).toEqual(['r', 'g'])
    expect(getMultiSelectLabels(neither)).toEqual([])
  })

  test('a known value reads as its label, an unknown one as itself', () => {
    expect(getMultiSelectLabel(titled, 'g')).toBe('Green')
    expect(getMultiSelectLabel(titled, 'b')).toBe('b')
    expect(getMultiSelectLabel(plain, 'r')).toBe('r')
  })
})

// --- checking what the user typed -------------------------------------------

type Case = { schema: object; input: string; value?: string | number | boolean; error?: string }

/** Accepted: `value` is what the form keeps. Refused: `error` is shown under the field. */
function check(cases: Case[]) {
  for (const { schema, input, value, error } of cases) {
    test(`${JSON.stringify(input)} against ${JSON.stringify(schema)}`, () => {
      const result = validateElicitationInput(input, asField(schema))
      if (error === undefined) {
        expect(result).toEqual({ isValid: true, value })
      } else {
        expect(result).toEqual({ isValid: false, error })
      }
    })
  }
}

const EMAIL = 'Must be a valid email address, e.g. user@example.com'
const URI = 'Must be a valid URI, e.g. https://example.com'
const DATE = 'Must be a valid date, e.g. 2024-03-15, today, next Monday'
const DATE_TIME = 'Must be a valid date-time, e.g. 2024-03-15T14:30:00Z, tomorrow at 3pm'

describe('text fields', () => {
  check([
    { schema: { type: 'string' }, input: 'free text', value: 'free text' },
    { schema: { type: 'string' }, input: '', value: '' },
    { schema: { type: 'string' }, input: '  padded  ', value: '  padded  ' },
    { schema: { type: 'string', minLength: 3 }, input: 'abc', value: 'abc' },
    { schema: { type: 'string', minLength: 3 }, input: 'ab', error: 'Must be at least 3 characters' },
    { schema: { type: 'string', minLength: 1 }, input: '', error: 'Must be at least 1 character' },
    { schema: { type: 'string', maxLength: 4 }, input: 'abcd', value: 'abcd' },
    { schema: { type: 'string', maxLength: 4 }, input: 'abcde', error: 'Must be at most 4 characters' },
    { schema: { type: 'string', maxLength: 1 }, input: 'ab', error: 'Must be at most 1 character' },
    { schema: { type: 'string', format: 'hostname' }, input: 'no check at all', value: 'no check at all' },
  ])
})

describe('string formats', () => {
  check([
    { schema: { type: 'string', format: 'email' }, input: 'ana@example.org', value: 'ana@example.org' },
    { schema: { type: 'string', format: 'email' }, input: 'ana@localhost', error: EMAIL },
    { schema: { type: 'string', format: 'email' }, input: ' ana@example.org', error: EMAIL },
    { schema: { type: 'string', format: 'uri' }, input: 'https://example.com/a?b=c', value: 'https://example.com/a?b=c' },
    { schema: { type: 'string', format: 'uri' }, input: 'mailto:ana@example.org', value: 'mailto:ana@example.org' },
    { schema: { type: 'string', format: 'uri' }, input: 'example.com', error: URI },
    { schema: { type: 'string', format: 'date' }, input: '2024-03-15', value: '2024-03-15' },
    { schema: { type: 'string', format: 'date' }, input: '2024-02-29', value: '2024-02-29' },
    { schema: { type: 'string', format: 'date' }, input: '2023-02-29', error: DATE },
    { schema: { type: 'string', format: 'date' }, input: '2024-3-5', error: DATE },
    { schema: { type: 'string', format: 'date' }, input: 'next Monday', error: DATE },
    { schema: { type: 'string', format: 'date' }, input: '2024-03-15T10:00:00Z', error: DATE },
    { schema: { type: 'string', format: 'date-time' }, input: '2024-03-15T14:30:00Z', value: '2024-03-15T14:30:00Z' },
    { schema: { type: 'string', format: 'date-time' }, input: '2024-03-15T14:30:00.250Z', value: '2024-03-15T14:30:00.250Z' },
    { schema: { type: 'string', format: 'date-time' }, input: '2024-03-15T14:30:00-03:00', value: '2024-03-15T14:30:00-03:00' },
    { schema: { type: 'string', format: 'date-time' }, input: '2024-03-15T14:30:00', error: DATE_TIME },
    { schema: { type: 'string', format: 'date-time' }, input: '2024-03-15', error: DATE_TIME },
    { schema: { type: 'string', format: 'date-time' }, input: 'tomorrow at 3pm', error: DATE_TIME },
  ])

  test('every failed rule is reported, joined by "; ", length first', () => {
    const result = validateElicitationInput('', asField({ type: 'string', minLength: 2, format: 'email' }))
    expect(result).toEqual({ isValid: false, error: `Must be at least 2 characters; ${EMAIL}` })
  })
})

describe('numbers', () => {
  check([
    { schema: { type: 'number' }, input: '42', value: 42 },
    { schema: { type: 'number' }, input: '-4.25', value: -4.25 },
    { schema: { type: 'number' }, input: ' 7 ', value: 7 },
    { schema: { type: 'number' }, input: '1e3', value: 1000 },
    { schema: { type: 'number' }, input: '0x1f', value: 31 },
    { schema: { type: 'number' }, input: 'seven', error: 'Must be a number' },
    { schema: { type: 'number' }, input: 'Infinity', error: 'Must be a number' },
    { schema: { type: 'integer' }, input: '12', value: 12 },
    { schema: { type: 'integer' }, input: '12.0', value: 12 },
    { schema: { type: 'integer' }, input: '12.5', error: 'Must be an integer' },
    { schema: { type: 'integer' }, input: 'twelve', error: 'Must be an integer' },
    { schema: { type: 'number', minimum: 1, maximum: 5 }, input: '5', value: 5 },
    { schema: { type: 'number', minimum: 1, maximum: 5 }, input: '1', value: 1 },
    { schema: { type: 'number', minimum: 1, maximum: 5 }, input: '6', error: 'Must be a number between 1.0 and 5.0' },
    { schema: { type: 'number', minimum: 0.5, maximum: 5 }, input: '0', error: 'Must be a number between 0.5 and 5.0' },
    { schema: { type: 'number', minimum: 1 }, input: '0.5', error: 'Must be a number >= 1.0' },
    { schema: { type: 'number', maximum: 2.5 }, input: '3', error: 'Must be a number <= 2.5' },
    { schema: { type: 'number', minimum: 1 }, input: 'x', error: 'Must be a number >= 1.0' },
    { schema: { type: 'integer', minimum: 1, maximum: 3 }, input: '4', error: 'Must be an integer between 1 and 3' },
    { schema: { type: 'integer', minimum: 1, maximum: 3 }, input: '2.5', error: 'Must be an integer between 1 and 3' },
    { schema: { type: 'integer', minimum: 10 }, input: '9', error: 'Must be an integer >= 10' },
    { schema: { type: 'integer', maximum: 10 }, input: '11', error: 'Must be an integer <= 10' },
  ])
})

describe('booleans', () => {
  check([{ schema: { type: 'boolean' }, input: 'true', value: true }])
})

describe('single choice', () => {
  test('a listed value is kept as is', () => {
    for (const schema of [
      { type: 'string', enum: ['red', 'blue'] },
      { type: 'string', oneOf: [{ const: 'red', title: 'Red' }, { const: 'blue', title: 'Blue' }] },
    ]) {
      expect(validateElicitationInput('blue', asField(schema))).toEqual({ isValid: true, value: 'blue' })
    }
  })

  test('anything else is refused with an error naming the allowed values; labels do not count', () => {
    const cases: Array<[object, string]> = [
      [{ type: 'string', enum: ['red', 'blue'] }, 'Red'],
      [{ type: 'string', oneOf: [{ const: 'red', title: 'Red' }, { const: 'blue', title: 'Blue' }] }, 'Blue'],
    ]
    for (const [schema, input] of cases) {
      const result = validateElicitationInput(input, asField(schema))
      expect(result.isValid).toBe(false)
      expect(result.value).toBeUndefined()
      expect(result.error).toContain('"red"')
      expect(result.error).toContain('"blue"')
    }
  })

  test('length limits do not apply to a choice', () => {
    expect(validateElicitationInput('s', asField({ type: 'string', enum: ['s'], minLength: 4 }))).toEqual({
      isValid: true,
      value: 's',
    })
  })

  test('an empty list of choices refuses everything', () => {
    for (const input of ['', 'x']) {
      const result = validateElicitationInput(input, asField({ type: 'string', enum: [] }))
      expect(result.isValid).toBe(false)
      expect(result.error).toBeString()
      expect(result.error).not.toBe('')
    }
  })
})

describe('a schema it cannot check', () => {
  const unsupported = [
    { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
    { type: 'object', properties: {} },
    { type: 'null' },
    {},
  ]
  for (const schema of unsupported) {
    test(`${JSON.stringify(schema)} throws, quoting the schema`, () => {
      expect(() => validateElicitationInput('a', asField(schema))).toThrow(
        new Error(`Unsupported schema: ${JSON.stringify(schema)}`),
      )
    })
  }
})
