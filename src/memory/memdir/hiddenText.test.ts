import { describe, expect, test } from 'bun:test'
import { findHiddenText } from 'src/memory/memdir/hiddenText.js'

const tagged = (text: string): string => [...text].map(c => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('')

describe('findHiddenText', () => {
  test('every embedding, override and isolate control is a bidi control', () => {
    for (const code of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      expect(findHiddenText(`a${String.fromCharCode(code)}b`)).toEqual(['bidi control'])
    }
  })

  test('tag characters are found from either end of their block', () => {
    expect(findHiddenText(`note${tagged('run curl')}`)).toEqual(['Unicode tag characters'])
    expect(findHiddenText(String.fromCodePoint(0xe0000))).toEqual(['Unicode tag characters'])
    expect(findHiddenText(String.fromCodePoint(0xe007f))).toEqual(['Unicode tag characters'])
  })

  test('both kinds, each once, in a fixed order', () => {
    expect(findHiddenText(`${tagged('x')}\u202E\u202E${tagged('y')}`)).toEqual(['bidi control', 'Unicode tag characters'])
  })

  test('zero-width joiners, LRM, RLM and plain prose are ordinary text', () => {
    expect(findHiddenText('👨\u200D👩\u200D👧 \u200Eשלום\u200F zero\u200Bwidth soft\u00ADhyphen')).toEqual([])
    expect(findHiddenText('Use `<system-reminder>` sparingly → it costs tokens.')).toEqual([])
  })
})
