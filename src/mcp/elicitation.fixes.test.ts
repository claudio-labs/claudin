/**
 * The three findings of the `mcp/elicitation` spec decided as "fix":
 *   1. a boolean field accepts `true` and `false` only;
 *   2. blank text is not a number;
 *   3. the date parser succeeds only with a real ISO 8601 date or date-time.
 *
 * The model is the only stand-in, as in the characterization suite, and the
 * real provider shim is put back afterwards.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { PrimitiveSchemaDefinition } from '@modelcontextprotocol/sdk/types.js'

let reply = 'INVALID'
const realShim = { ...(await import('src/providers/shims/claude.js')) }
mock.module('src/providers/shims/claude.js', () => ({
  ...realShim,
  queryHaiku: async () => ({ message: { content: [{ type: 'text', text: reply }] } }),
}))

const { parseNaturalLanguageDateTime } = await import('src/mcp/dateTimeParser.js')
const { validateElicitationInput, validateElicitationInputAsync } = await import('src/mcp/elicitationValidation.js')

afterAll(() => {
  mock.module('src/providers/shims/claude.js', () => realShim)
})

beforeEach(() => {
  reply = 'INVALID'
})

const asField = (schema: object) => schema as PrimitiveSchemaDefinition
const live = () => new AbortController().signal

describe('finding 1: a boolean field', () => {
  const BOOLEAN = asField({ type: 'boolean' })
  const cases: Array<[string, boolean | undefined]> = [
    ['true', true],
    ['false', false],
    ['', undefined],
    ['yes', undefined],
    ['TRUE', undefined],
    [' true', undefined],
    ['0', undefined],
  ]
  for (const [input, value] of cases) {
    test(`${JSON.stringify(input)} -> ${value === undefined ? 'refused' : value}`, () => {
      expect(validateElicitationInput(input, BOOLEAN)).toEqual(
        value === undefined ? { isValid: false, error: 'Must be true or false' } : { isValid: true, value },
      )
    })
  }
})

describe('finding 2: blank text in a number field', () => {
  const cases: Array<[object, string]> = [
    [{ type: 'number' }, 'Must be a number'],
    [{ type: 'integer' }, 'Must be an integer'],
    [{ type: 'number', minimum: -1, maximum: 1 }, 'Must be a number between -1.0 and 1.0'],
    [{ type: 'integer', minimum: 0 }, 'Must be an integer >= 0'],
  ]
  for (const [schema, error] of cases) {
    for (const input of ['', '   ', '\t\n']) {
      test(`${JSON.stringify(input)} against ${JSON.stringify(schema)} is refused`, () => {
        expect(validateElicitationInput(input, asField(schema))).toEqual({ isValid: false, error })
      })
    }
  }

  test('zero typed as zero is still a number', () => {
    expect(validateElicitationInput('0', asField({ type: 'integer', minimum: 0 }))).toEqual({ isValid: true, value: 0 })
  })
})

describe('finding 3: the parser succeeds only with a real ISO date or date-time', () => {
  const UNPARSED = { success: false, error: 'Unable to parse date/time from input' } as const
  const replies: Array<[string, boolean]> = [
    ['2026-03-05', true],
    ['2024-02-29', true],
    ['2026-03-05T15:00', true],
    ['2026-03-05T15:00:00', true],
    ['2026-03-05T15:00:00.5Z', true],
    ['2026-03-05T23:59:59+05:30', true],
    ['2026garbage', false],
    ['20260305', false],
    ['2026-03-05 garbage', false],
    ['2026-03-05T', false],
    ['2026-02-30', false],
    ['2023-02-29', false],
    ['2026-13-01', false],
    ['2026-00-10', false],
    ['2026-03-00', false],
    ['2026-04-31', false],
    ['2026-03-05T24:00:00Z', false],
    ['2026-03-05T15:60:00Z', false],
    ['2026-03-05T15:00:60Z', false],
    ['2026-03-05T15:00:00+24:00', false],
    ['2026-03-05T15:00:00+05:60', false],
    ['2026-03-05T15:00:00 Z', false],
  ]
  for (const [text, success] of replies) {
    test(`the reply ${JSON.stringify(text)} is ${success ? 'a success' : 'refused'}`, async () => {
      reply = text
      expect(await parseNaturalLanguageDateTime('whenever', 'date-time', live())).toEqual(
        success ? { success: true, value: text } : UNPARSED,
      )
    })
  }

  test('a refused reply leaves the field with the error for what the user typed', async () => {
    reply = '2026garbage'
    expect(await validateElicitationInputAsync('soon', asField({ type: 'string', format: 'date' }), live())).toEqual({
      isValid: false,
      error: 'Must be a valid date, e.g. 2024-03-15, today, next Monday',
    })
  })
})
