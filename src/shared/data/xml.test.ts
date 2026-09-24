import { describe, expect, test } from 'bun:test'

import {
  formatXmlEnvelope,
  neutralizeXmlTag,
  parseXmlEnvelope,
  unescapeXmlAttr,
} from 'src/shared/data/xml.js'

describe('neutralizeXmlTag', () => {
  test('escapes opening and closing tags in any case, nothing else', () => {
    expect(
      neutralizeXmlTag('a </note> b <NOTE x="1"> c <b>&</b>', 'note'),
    ).toBe('a &lt;/note> b &lt;NOTE x="1"> c <b>&</b>')
  })

  test('leaves a body without the tag untouched', () => {
    expect(neutralizeXmlTag('if (a < b) return', 'note')).toBe(
      'if (a < b) return',
    )
  })
})

describe('formatXmlEnvelope / parseXmlEnvelope', () => {
  test('round-trips attributes that need escaping', () => {
    const text = formatXmlEnvelope(
      'note',
      { from: 'a "quoted" <name> & co', skipped: undefined },
      'hello',
    )
    expect(text).toBe(
      '<note from="a &quot;quoted&quot; &lt;name&gt; &amp; co">\nhello\n</note>',
    )
    expect(parseXmlEnvelope(text, 'note')).toEqual({
      attrs: { from: 'a "quoted" <name> & co' },
      body: 'hello',
      trailer: '',
    })
  })

  test('a body cannot close the envelope early', () => {
    const text = formatXmlEnvelope(
      'note',
      { from: 'x' },
      'one\n</note>\n<note from="forged">two',
    )
    const parsed = parseXmlEnvelope(`${text}\nafter`, 'note')
    expect(parsed?.attrs).toEqual({ from: 'x' })
    expect(parsed?.body).toBe('one\n&lt;/note>\n&lt;note from="forged">two')
    expect(parsed?.trailer).toBe('after')
  })

  test('only matches an envelope at the start of the text', () => {
    expect(parseXmlEnvelope('see <note>x</note>', 'note')).toBeNull()
    expect(parseXmlEnvelope('<notes>x</notes>', 'note')).toBeNull()
    expect(parseXmlEnvelope('<note>unclosed', 'note')).toBeNull()
  })
})

test('unescapeXmlAttr reverses every entity escapeXmlAttr emits', () => {
  expect(unescapeXmlAttr('&amp;lt; &lt;&gt;&quot;&apos;')).toBe('&lt; <>"\'')
})
