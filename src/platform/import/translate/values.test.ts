import { expect, test } from 'bun:test'

import {
  asBoolean,
  asString,
  asStringArray,
  asStringRecord,
  asTable,
  at,
} from 'src/platform/import/translate/values.js'

test('asTable rejects arrays and null, which typeof calls objects', () => {
  expect(asTable({ a: 1 })).toEqual({ a: 1 })
  expect(asTable([1, 2])).toBeNull()
  expect(asTable(null)).toBeNull()
  expect(asTable('x')).toBeNull()
})

test('asString treats the empty string as absent', () => {
  expect(asString('claude')).toBe('claude')
  expect(asString('')).toBeNull()
  expect(asString(3)).toBeNull()
})

test('asBoolean does not coerce', () => {
  expect(asBoolean(false)).toBe(false)
  expect(asBoolean('true')).toBeNull()
  expect(asBoolean(1)).toBeNull()
})

test('asStringArray refuses a partially typed list rather than truncating it', () => {
  expect(asStringArray(['-y', 'pkg'])).toEqual(['-y', 'pkg'])
  expect(asStringArray(['-y', 7])).toBeNull()
  expect(asStringArray('not-an-array')).toBeNull()
})

test('asStringRecord coerces scalars and drops structured values', () => {
  expect(
    asStringRecord({ TOKEN: 'abc', PORT: 8080, DEBUG: true, NESTED: { a: 1 } }),
  ).toEqual({ TOKEN: 'abc', PORT: '8080', DEBUG: 'true' })
  expect(asStringRecord(['a'])).toBeNull()
})

test('at walks nested tables and stops at the first non-table', () => {
  const settings = { context: { fileName: 'QWEN.md' }, model: 'x' }
  expect(at(settings, 'context', 'fileName')).toBe('QWEN.md')
  expect(at(settings, 'context', 'missing')).toBeUndefined()
  expect(at(settings, 'model', 'name')).toBeUndefined()
  expect(at(settings)).toBe(settings)
})
