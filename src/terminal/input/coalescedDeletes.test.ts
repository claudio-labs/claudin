import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { applyCoalescedDeletes } from 'src/terminal/input/coalescedDeletes.js'
import { Cursor } from 'src/terminal/input/Cursor.js'

const at = (text: string, offset = text.length) => Cursor.fromText(text, 80, offset)

describe('applyCoalescedDeletes', () => {
  test('one DEL deletes the character before the cursor', () => {
    const next = applyCoalescedDeletes(at('abc'), '\x7f')
    expect(next.text).toBe('ab')
    expect(next.offset).toBe(2)
  })

  test('every DEL in the read counts', () => {
    expect(applyCoalescedDeletes(at('abcd'), '\x7f\x7f\x7f').text).toBe('a')
  })

  test('deletes before the cursor, not at the end of the text', () => {
    const next = applyCoalescedDeletes(at('abcd', 2), '\x7f')
    expect(next.text).toBe('acd')
    expect(next.offset).toBe(1)
  })

  test('stops at the start of the text', () => {
    const start = at('ab', 0)
    expect(applyCoalescedDeletes(start, '\x7f\x7f').equals(start)).toBe(true)
  })

  test('keeps the text typed in the same read, in order', () => {
    expect(applyCoalescedDeletes(at('x'), 'abc\x7f').text).toBe('xab')
    expect(applyCoalescedDeletes(at(''), 'ab\x7fc').text).toBe('ac')
  })

  test('the text input routes raw DEL reads through it', () => {
    const hook = readFileSync(new URL('../hooks/useTextInput.ts', import.meta.url), 'utf8')
    expect(hook).toContain('const nextCursor = applyCoalescedDeletes(currentCursor, input)')
  })
})
