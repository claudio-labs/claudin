import { test, expect } from 'bun:test'

import { clamp, clampInt, inRange } from 'src/utils/data/clamp.js'

test('returns the value when inside the range', () => {
  expect(clamp(5, 0, 10)).toBe(5)
})

test('returns min when below the range', () => {
  expect(clamp(-3, 0, 10)).toBe(0)
})

test('returns max when above the range', () => {
  expect(clamp(42, 0, 10)).toBe(10)
})

test('returns the value at the lower bound', () => {
  expect(clamp(0, 0, 10)).toBe(0)
})

test('returns the value at the upper bound', () => {
  expect(clamp(10, 0, 10)).toBe(10)
})

test('throws RangeError when min > max', () => {
  expect(() => clamp(5, 10, 0)).toThrow(RangeError)
})

test('clampInt rounds down toward the nearest integer', () => {
  expect(clampInt(4.2, 0, 10)).toBe(4)
})

test('clampInt rounds up toward the nearest integer', () => {
  expect(clampInt(4.7, 0, 10)).toBe(5)
})

test('clampInt rounds halves up', () => {
  expect(clampInt(4.5, 0, 10)).toBe(5)
})

test('clampInt returns min when the rounded value is below the range', () => {
  expect(clampInt(-3.4, 0, 10)).toBe(0)
})

test('clampInt returns max when the rounded value is above the range', () => {
  expect(clampInt(42.6, 0, 10)).toBe(10)
})

test('clampInt throws RangeError when min > max', () => {
  expect(() => clampInt(5, 10, 0)).toThrow(RangeError)
})

test('inRange returns true when the value is inside the range', () => {
  expect(inRange(5, 0, 10)).toBe(true)
})

test('inRange returns true at the lower bound', () => {
  expect(inRange(0, 0, 10)).toBe(true)
})

test('inRange returns true at the upper bound', () => {
  expect(inRange(10, 0, 10)).toBe(true)
})

test('inRange returns false when the value is below min', () => {
  expect(inRange(-1, 0, 10)).toBe(false)
})

test('inRange returns false when the value is above max', () => {
  expect(inRange(11, 0, 10)).toBe(false)
})

test('inRange throws RangeError when min > max', () => {
  expect(() => inRange(5, 10, 0)).toThrow(RangeError)
})
