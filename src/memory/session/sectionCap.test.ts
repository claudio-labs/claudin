/**
 * The per-section cap with small caps, where every character is visible.
 */
import { describe, expect, test } from 'bun:test'

import { capSectionBodies, SECTION_TRUNCATED_NOTE } from 'src/memory/session/sectionCap.js'

describe('capSectionBodies', () => {
  test('a body of exactly the cap is kept; one character more keeps the lines that fit, a blank line and the note', () => {
    expect(capSectionBodies('# A\n1234\n5678\n', 10)).toStrictEqual({
      truncatedContent: '# A\n1234\n5678\n',
      wasTruncated: false,
    })
    expect(capSectionBodies('# A\n1234\n5678\n9', 10)).toStrictEqual({
      truncatedContent: `# A\n1234\n5678\n\n${SECTION_TRUNCATED_NOTE}`,
      wasTruncated: true,
    })
  })

  test('blank lines count toward the cap', () => {
    const { wasTruncated } = capSectionBodies(`# A\n${'\n'.repeat(6)}`, 5)
    expect(wasTruncated).toBe(true)
  })

  test('a header with nothing under it, and two headers in a row, are sections of their own', () => {
    const text = '# Empty\n# Next\nabcdef\n# Last'
    expect(capSectionBodies(text, 3).truncatedContent).toBe(
      `# Empty\n# Next\n\n${SECTION_TRUNCATED_NOTE}\n# Last`,
    )
  })

  test('a section that is not cut keeps its trailing newline when another one is', () => {
    const text = '# Long\nabcdef\n# Short\nok\n'
    expect(capSectionBodies(text, 4).truncatedContent).toBe(`# Long\n\n${SECTION_TRUNCATED_NOTE}\n# Short\nok\n`)
  })

  test('Windows line endings still open sections, and count as characters', () => {
    const text = '# A\r\nab\r\ncd\r\n# B\r\nef'
    expect(capSectionBodies(text, 7)).toStrictEqual({ truncatedContent: text, wasTruncated: false })
    expect(capSectionBodies(text, 6).truncatedContent).toBe(`# A\r\nab\r\n\n${SECTION_TRUNCATED_NOTE}\n# B\r\nef`)
  })

  test('content without a header is all preamble, and never cut', () => {
    const text = 'x'.repeat(50)
    expect(capSectionBodies(text, 1)).toStrictEqual({ truncatedContent: text, wasTruncated: false })
  })
})
