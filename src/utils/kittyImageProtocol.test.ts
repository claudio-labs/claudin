import { describe, expect, test } from 'bun:test'
import {
  __test,
  deleteKittyImage,
  nextImageId,
  placeholderLines,
  transmitKittyImage,
} from './kittyImageProtocol.js'

describe('kittyImageProtocol', () => {
  test('nextImageId is monotonic and wraps at uint24', () => {
    const a = nextImageId()
    const b = nextImageId()
    expect(b).toBe(a + 1)
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThanOrEqual(0xff_ff_ff)
  })

  test('transmitKittyImage chunks payload at 4096 bytes', () => {
    const pngBuf = Buffer.alloc(10_000, 0xab)
    const out = transmitKittyImage(pngBuf, 42, 8, 40)
    // Each chunk starts with APC introducer \x1b_G and ends with ST \x1b\
    const chunks = out.split('\x1b_G').filter(Boolean)
    expect(chunks.length).toBeGreaterThan(1)
    // First chunk has the control block with i=42 and virtual placement params
    expect(chunks[0]).toContain('a=T')
    expect(chunks[0]).toContain('U=1')
    expect(chunks[0]).toContain('c=40')
    expect(chunks[0]).toContain('r=8')
    expect(chunks[0]).toContain('f=100')
    expect(chunks[0]).toContain('i=42')
    expect(chunks[0]).toContain('q=2')
    expect(chunks[0]).toContain('m=1')
    // Last chunk has m=0
    const last = chunks[chunks.length - 1]
    expect(last).toContain('m=0')
    // Every chunk ends with ST (ESC \)
    for (const c of chunks) expect(c).toContain('\x1b\\')
  })

  test('transmitKittyImage single-chunk payload sets m=0', () => {
    const pngBuf = Buffer.alloc(64, 0xab)
    const out = transmitKittyImage(pngBuf, 1, 4, 20)
    expect(out).toContain('m=0')
    expect(out).not.toContain('m=1')
  })

  test('placeholderLines emits rows x cols cells', () => {
    const lines = placeholderLines(7, 3, 5)
    expect(lines).toHaveLength(3)
    for (const line of lines) {
      // Each cell is one placeholder + 3 combining chars
      const cells = [...line.matchAll(/\u{10EEEE}/gu)]
      expect(cells).toHaveLength(5)
    }
  })

  test('placeholderLines encodes row/col via diacritic table', () => {
    const lines = placeholderLines(1, 2, 2)
    // Row 0 first cell: U+10EEEE + diacritic[0] + diacritic[0] + diacritic[0]
    const expectedDia = String.fromCodePoint(__test.KITTY_DIACRITICS[0]!)
    expect(lines[0]).toContain(
      `\u{10EEEE}${expectedDia}${expectedDia}${expectedDia}`,
    )
    // Row 1 first cell uses diacritic[1] for the row position
    const row1Dia = String.fromCodePoint(__test.KITTY_DIACRITICS[1]!)
    expect(lines[1]).toContain(`\u{10EEEE}${row1Dia}`)
  })

  test('placeholderLines wraps each row in 24-bit SGR foreground (full ID)', () => {
    // imageId 0xAB12CD splits into R=0xAB, G=0x12, B=0xCD.
    const lines = placeholderLines(0xab_12_cd, 1, 1)
    expect(lines[0]!.startsWith('\x1b[38;2;171;18;205m')).toBe(true)
    expect(lines[0]!.endsWith('\x1b[39m')).toBe(true)
  })

  test('different image IDs produce distinct SGR prefixes (no collision)', () => {
    // Regression for the bug where only the high byte was encoded —
    // IDs 1 and 2 both rendered as imageId=0 in the terminal.
    const a = placeholderLines(1, 1, 1)[0]!
    const b = placeholderLines(2, 1, 1)[0]!
    const c = placeholderLines(0x10_00_00, 1, 1)[0]!
    const sgrA = a.slice(0, a.indexOf('m') + 1)
    const sgrB = b.slice(0, b.indexOf('m') + 1)
    const sgrC = c.slice(0, c.indexOf('m') + 1)
    expect(sgrA).toBe('\x1b[38;2;0;0;1m')
    expect(sgrB).toBe('\x1b[38;2;0;0;2m')
    expect(sgrC).toBe('\x1b[38;2;16;0;0m')
    expect(sgrA).not.toBe(sgrB)
    expect(sgrA).not.toBe(sgrC)
  })

  test('deleteKittyImage emits a=d,d=I APC for the given id', () => {
    expect(deleteKittyImage(7)).toBe('\x1b_Ga=d,d=I,i=7,q=2;\x1b\\')
  })

  test('placeholderLines refuses oversized dimensions', () => {
    expect(() => placeholderLines(1, __test.MAX_CELLS + 1, 1)).toThrow(RangeError)
    expect(() => placeholderLines(1, 1, __test.MAX_CELLS + 1)).toThrow(RangeError)
  })

  test('placeholderLines returns empty array for zero dims', () => {
    expect(placeholderLines(1, 0, 5)).toEqual([])
    expect(placeholderLines(1, 5, 0)).toEqual([])
  })

  test('placeholderLines third diacritic carries bits 24-31 of the ID', () => {
    // ID 0x01000000 → bits 24-31 = 0x01, so 3rd diacritic = table[1].
    // We pass a 25-bit ID just to verify the masking, even though
    // nextImageId() never produces values that large in practice.
    const lines = placeholderLines(0x01_00_00_00, 1, 1)
    const expectedHighDia = String.fromCodePoint(__test.KITTY_DIACRITICS[1]!)
    const row0Dia = String.fromCodePoint(__test.KITTY_DIACRITICS[0]!)
    // Strip the SGR wrapper before comparing the placeholder body.
    const placeholderBody = lines[0]!
      .replace(/^\x1b\[[^m]*m/, '')
      .replace(/\x1b\[39m$/, '')
    expect(placeholderBody).toBe(
      `\u{10EEEE}${row0Dia}${row0Dia}${expectedHighDia}`,
    )
  })

  test('placeholderLines supports up to 297 cells per dimension', () => {
    // Sanity check the full Kitty diacritic table is present.
    expect(__test.MAX_CELLS).toBe(297)
    expect(() => placeholderLines(1, 297, 1)).not.toThrow()
    expect(() => placeholderLines(1, 1, 297)).not.toThrow()
  })

  test('cell widths match expectation via stringWidth', async () => {
    const { stringWidth } = await import('src/ink/stringWidth.js')
    const lines = placeholderLines(42, 1, 10)
    expect(stringWidth(lines[0]!)).toBe(10)
  })
})
