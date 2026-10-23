import { describe, expect, test } from 'bun:test'
import { parseWholeNumberEnvVar, validateBoundedIntEnvVar } from 'src/shared/envValidation.js'

describe('parseWholeNumberEnvVar', () => {
  test('an unset or empty value is the default', () => {
    expect(parseWholeNumberEnvVar('X', undefined, 7)).toBe(7)
    expect(parseWholeNumberEnvVar('X', '', 7)).toBe(7)
  })

  test('digits are the value, surrounding whitespace ignored', () => {
    expect(parseWholeNumberEnvVar('X', '120000', 7)).toBe(120_000)
    expect(parseWholeNumberEnvVar('X', ' 3 ', 7)).toBe(3)
  })

  test('zero is valid unless the minimum says otherwise', () => {
    expect(parseWholeNumberEnvVar('X', '0', 7)).toBe(0)
    expect(parseWholeNumberEnvVar('X', '0', 7, 1)).toBe(7)
  })

  test.each(['abc', '-5', '2.5', '600s', '1e3', '99999999999999999999'])(
    '%s is invalid and falls back to the default',
    value => {
      expect(parseWholeNumberEnvVar('X', value, 7)).toBe(7)
    },
  )
})

describe('validateBoundedIntEnvVar', () => {
  test('an unset value is the default', () => {
    expect(validateBoundedIntEnvVar('X', undefined, 5, 10)).toEqual({ effective: 5, status: 'valid' })
  })

  test('a value in range is used as is', () => {
    expect(validateBoundedIntEnvVar('X', '8', 5, 10)).toEqual({ effective: 8, status: 'valid' })
  })

  test('a value above the limit is capped', () => {
    expect(validateBoundedIntEnvVar('X', '20', 5, 10)).toMatchObject({ effective: 10, status: 'capped' })
  })

  test('zero, negatives and non-numbers are invalid', () => {
    for (const value of ['0', '-1', 'abc']) {
      expect(validateBoundedIntEnvVar('X', value, 5, 10)).toMatchObject({ effective: 5, status: 'invalid' })
    }
  })
})
