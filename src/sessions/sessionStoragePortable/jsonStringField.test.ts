// Field reads over raw JSONL text. The characterization suite pins the cases
// the two readers always agreed on; these pin the choice by position across
// the compact and the spaced form, and the JSON-string decoding rules.

import { describe, expect, test } from 'bun:test'

import {
  extractJsonStringField,
  extractLastJsonStringField,
} from 'src/sessions/sessionStoragePortable.js'

describe('the two forms are ranked by position', () => {
  test('the first occurrence wins when it is the spaced one', () => {
    expect(extractJsonStringField('{"t": "spaced"}\n{"t":"compact"}', 't')).toBe('spaced')
  })

  test('the last occurrence wins when it is the spaced one', () => {
    expect(extractLastJsonStringField('{"t":"compact"}\n{"t": "spaced"}', 't')).toBe('spaced')
  })

  test('the first reader still prefers an earlier compact occurrence', () => {
    expect(extractJsonStringField('{"t":"compact"}\n{"t": "spaced"}', 't')).toBe('compact')
  })

  test('a last occurrence cut short falls back to the one before it, in either form', () => {
    const text = '{"t": "first"}\n{"t":"second"}\n{"t": "third"}\n{"t":"cut'
    expect(extractLastJsonStringField(text, 't')).toBe('third')
    expect(extractLastJsonStringField('{"t":"one"}\n{"t": "cu', 't')).toBe('one')
  })
})

describe('decoding by JSON string rules', () => {
  test('unicode and solidus escapes decode', () => {
    expect(extractJsonStringField('{"t":"\\u0041\\/\\b\\f\\r"}', 't')).toBe('A/\b\f\r')
  })

  test('a unicode escape short of four hex digits leaves the value as it is', () => {
    expect(extractJsonStringField('{"t":"\\u12g4"}', 't')).toBe('\\u12g4')
  })

  test('a raw control character makes the value invalid, so its escapes stay undecoded', () => {
    expect(extractJsonStringField('{"t":"tab\there \\n"}', 't')).toBe('tab\there \\n')
  })

  test('a value without escapes comes back as it is, control characters and all', () => {
    expect(extractLastJsonStringField('{"t":"a\tb"}', 't')).toBe('a\tb')
  })
})
