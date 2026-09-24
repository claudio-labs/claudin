import { expect, test } from 'bun:test'

import {
  INITIAL_STATE,
  parseMultipleKeypresses,
  type ParsedKey,
} from 'src/terminal/ink/parse-keypress.ts'
import { InputEvent } from 'src/terminal/ink/events/input-event.ts'

function parseInputEvent(sequence: string): InputEvent {
  const [items] = parseMultipleKeypresses(INITIAL_STATE, sequence)

  expect(items).toHaveLength(1)

  const item = items[0]
  expect(item?.kind).toBe('key')

  return new InputEvent(item as ParsedKey)
}

test('treats CSI-u modifier 0 as unmodified printable input', () => {
  const event = parseInputEvent('\x1b[47;0u')

  expect(event.input).toBe('/')
  expect(event.key.ctrl).toBe(false)
  expect(event.key.meta).toBe(false)
  expect(event.key.shift).toBe(false)
  expect(event.key.super).toBe(false)
})

/** Every key one read produces, as the input each carries. */
function inputsOf(sequence: string): string[] {
  const [items] = parseMultipleKeypresses(INITIAL_STATE, sequence)
  return items.map(item => new InputEvent(item as ParsedKey).input)
}

test('keys typed faster than one read are one key each', () => {
  expect(inputsOf('jj')).toEqual(['j', 'j'])
  expect(inputsOf('jk')).toEqual(['j', 'k'])
  expect(inputsOf('abc')).toEqual(['a', 'b', 'c'])
})

test('a grapheme made of several code points stays one key', () => {
  expect(inputsOf('a👍🏽e\u0301')).toEqual(['a', '👍🏽', 'e\u0301'])
})

test('a run that can be an unbracketed paste keeps its one-key shape', () => {
  // Embedded and trailing \r are what the text input reads as a multi-line
  // paste and as a coalesced Enter; splitting them would submit mid-paste.
  expect(inputsOf('one\rtwo')).toHaveLength(1)
  expect(inputsOf('o\r')).toHaveLength(1)
  expect(inputsOf('ab\x7f')).toHaveLength(1)
  expect(inputsOf('x'.repeat(33))).toHaveLength(1)
})

test('a bracketed paste is still one key, whatever it holds', () => {
  const [items] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[200~jj\x1b[201~')
  expect(items).toHaveLength(1)
  expect((items[0] as ParsedKey).isPasted).toBe(true)
})

test('preserves printable Unicode CSI-u input', () => {
  const event = parseInputEvent('\x1b[231u')

  expect(event.input).toBe('ç')
  expect(event.key.ctrl).toBe(false)
  expect(event.key.meta).toBe(false)
  expect(event.key.shift).toBe(false)
  expect(event.key.super).toBe(false)
})

test('preserves printable Unicode CSI-u input with explicit modifier 0', () => {
  const event = parseInputEvent('\x1b[231;0u')

  expect(event.input).toBe('ç')
  expect(event.key.ctrl).toBe(false)
  expect(event.key.meta).toBe(false)
  expect(event.key.shift).toBe(false)
  expect(event.key.super).toBe(false)
})
