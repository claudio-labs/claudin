import { afterEach, describe, expect, test } from 'bun:test'
import { getFooterGroupSegments } from 'src/agent/ui/tasks/footerGroupIcons.js'
import {
  FOOTER_GROUP_LABELS,
  FOOTER_GROUP_ORDER,
} from 'src/agent/ui/tasks/footerTaskGeometry.js'

// hasNerdFontGlyphs resolves CLAUDIN_NERD_FONT before any terminal sniffing,
// so this pins both branches without depending on the host terminal.
function withNerdFont<T>(on: boolean, fn: () => T): T {
  process.env.CLAUDIN_NERD_FONT = on ? 'on' : 'off'
  try {
    return fn()
  } finally {
    delete process.env.CLAUDIN_NERD_FONT
  }
}

afterEach(() => {
  delete process.env.CLAUDIN_NERD_FONT
})

describe('getFooterGroupSegments', () => {
  test('falls back to the group word on a terminal with no Nerd Font', () => {
    // This is the whole point of the module: without it these terminals get
    // tofu where the icon should be.
    const segments = withNerdFont(false, getFooterGroupSegments)
    expect(segments).toEqual(FOOTER_GROUP_LABELS)
  })

  test('every icon is nf-md-*, in the supplementary private-use area', () => {
    // Not just "is a Nerd Font glyph": the nf-fa-* range painted blank on a
    // JetBrainsMono Nerd Font whose charset claimed to cover it, so the set is
    // deliberately all Material Design. A new group added from the FA range
    // fails here rather than shipping an invisible segment.
    const segments = withNerdFont(true, getFooterGroupSegments)
    for (const key of FOOTER_GROUP_ORDER) {
      const codePoint = segments[key].codePointAt(0) ?? 0
      expect(codePoint).toBeGreaterThanOrEqual(0xf0000)
      expect(codePoint).toBeLessThanOrEqual(0xffffd)
    }
  })

  test('never returns an empty segment — the count beside it needs an owner', () => {
    for (const on of [true, false]) {
      const segments = withNerdFont(on, getFooterGroupSegments)
      for (const key of FOOTER_GROUP_ORDER) {
        expect(segments[key].length).toBeGreaterThan(0)
      }
    }
  })

  test('covers every group, so a new one cannot ship without a glyph', () => {
    const segments = withNerdFont(true, getFooterGroupSegments)
    expect(Object.keys(segments).sort()).toEqual([...FOOTER_GROUP_ORDER].sort())
  })
})
