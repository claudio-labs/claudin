import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { semanticNumber } from 'src/utils/semanticNumber.js'

describe('semanticNumber', () => {
  const schema = semanticNumber(z.number().int().nonnegative().optional())

  test('accepts plain numbers', () => {
    expect(schema.parse(30)).toBe(30)
  })

  test('accepts numeric strings', () => {
    expect(schema.parse('30')).toBe(30)
  })

  test('accepts whitespace-padded numeric strings', () => {
    expect(schema.parse(' 30 ')).toBe(30)
    expect(schema.parse('\t42\n')).toBe(42)
  })

  test('accepts +-prefixed numeric strings', () => {
    expect(schema.parse('+30')).toBe(30)
    expect(schema.parse(' +7 ')).toBe(7)
  })

  test('rejects non-numeric strings', () => {
    expect(() => schema.parse('abc')).toThrow()
    expect(() => schema.parse('')).toThrow()
  })

  test('passes undefined through to optional inner', () => {
    expect(schema.parse(undefined)).toBeUndefined()
  })
})
