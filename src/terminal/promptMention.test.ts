import { describe, expect, test } from 'bun:test'
import { applyMention } from 'src/terminal/promptMention.js'

const A = '@src/lib/time.ts#L68-70'
const B = '@src/lib/time.ts#L68-75'

describe('applyMention', () => {
  test('writes into an empty prompt with a trailing space to type after', () => {
    const r = applyMention('', 0, A, null)
    expect(r.input).toBe(`${A} `)
    expect(r.cursor).toBe(r.input.length)
  })

  test('separates from the word before it', () => {
    const r = applyMention('explica', 7, A, null)
    expect(r.input).toBe(`explica ${A} `)
  })

  test('does not double the separator when one is already there', () => {
    const r = applyMention('explica ', 8, A, null)
    expect(r.input).toBe(`explica ${A} `)
  })

  test('writes at the caret, not at the end', () => {
    const r = applyMention('ab cd', 2, A, null)
    expect(r.input).toBe(`ab${A} ` + ' cd')
    expect(r.cursor).toBe(2 + `${A} `.length)
  })

  test('a second drag rewrites the first mention instead of stacking one', () => {
    const first = applyMention('', 0, A, null)
    const second = applyMention(first.input, first.cursor, B, first.tracked)
    expect(second.input).toBe(`${B} `)
    expect(second.cursor).toBe(second.input.length)
  })

  test('rewriting keeps the separator the first insert chose', () => {
    const first = applyMention('explica', 7, A, null)
    const second = applyMention(first.input, first.cursor, B, first.tracked)
    expect(second.input).toBe(`explica ${B} `)
  })

  test('rewriting preserves text the user had after the mention', () => {
    const first = applyMention('ab cd', 2, A, null)
    const second = applyMention(first.input, first.cursor, B, first.tracked)
    expect(second.input).toBe(`ab${B} ` + ' cd')
  })

  test('once the user types, the next drag appends instead', () => {
    const first = applyMention('', 0, A, null)
    const typed = `${first.input}explica`
    const second = applyMention(typed, typed.length, B, first.tracked)
    expect(second.input).toBe(`${A} explica ${B} `)
  })

  test('a stale tracked mention that no longer matches is ignored', () => {
    const first = applyMention('', 0, A, null)
    // Same length, different content — `input === tracked.input` fails.
    const edited = first.input.replace('68', '99')
    const second = applyMention(edited, edited.length, B, first.tracked)
    // Appended, not rewritten. No extra separator: the edited buffer still
    // ends in the first insert's trailing space.
    expect(second.input).toBe(`${edited}${B} `)
    expect(second.input).toContain('#L99-70')
  })

  test('three drags in a row leave exactly one mention', () => {
    let r = applyMention('', 0, A, null)
    r = applyMention(r.input, r.cursor, B, r.tracked)
    r = applyMention(r.input, r.cursor, A, r.tracked)
    expect(r.input).toBe(`${A} `)
  })

  test('an out-of-range caret is clamped rather than tearing the input', () => {
    expect(applyMention('abc', 99, A, null).input).toBe(`abc ${A} `)
    expect(applyMention('abc', -5, A, null).input).toBe(`${A} abc`)
  })
})
