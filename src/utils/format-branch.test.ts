import { afterEach, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import { stringWidth } from '../ink/stringWidth.js'
import { buildDiffStatSegment, type DiffStatInput } from './format-branch.js'
import { getTheme } from './theme.js'

const theme = getTheme('dark')
const ANSI_SGR = /\u001b\[[0-9;]*m/

/** Lengths of the consecutive same-colored block runs inside a segment. */
function barRuns(text: string): number[] {
  return text
    .split(ANSI_SGR)
    .filter(part => part.includes('■'))
    .map(part => part.length)
}

function withNerdFont<T>(on: boolean, fn: () => T): T {
  process.env.CLAUDIN_NERD_FONT = on ? 'on' : 'off'
  return fn()
}

function build(input: DiffStatInput, maxWidth?: number) {
  return buildDiffStatSegment(input, theme, maxWidth)
}

afterEach(() => {
  delete process.env.CLAUDIN_NERD_FONT
})

describe('buildDiffStatSegment', () => {
  test('returns null until something has been edited', () => {
    expect(build({ session: { added: 0, removed: 0 } })).toBeNull()
  })

  test('shows the git groups even when the session wrote nothing', () => {
    // Resuming into a dirty tree: the session counter is zero but the work is
    // real, which is the whole reason the git groups exist.
    const seg = withNerdFont(false, () =>
      build({
        session: { added: 0, removed: 0 },
        uncommitted: { added: 12, removed: 3 },
        branch: { added: 1240, removed: 300, base: 'main' },
      }),
    )
    expect(seg!.text).toBe('[ HEAD +12 -3  main +1240 -300 ]')
  })

  test('labels each git group with the ref it is measured against', () => {
    const seg = withNerdFont(false, () =>
      build({
        session: { added: 254, removed: 30 },
        uncommitted: { added: 12, removed: 3 },
        branch: { added: 1240, removed: 300, base: 'develop' },
      }),
    )
    expect(seg!.text).toBe('[ +254 -30  HEAD +12 -3  develop +1240 -300 ]')
  })

  test('reported width matches the rendered cell width', () => {
    // The prompt's top rule sizes its fill from `width`, so a mismatch wraps
    // the rule onto a row Ink did not measure.
    for (const nerdFont of [true, false]) {
      for (const input of [
        { session: { added: 157, removed: 6 } },
        { session: { added: 12, removed: 0 } },
        { session: { added: 0, removed: 9 } },
        {
          session: { added: 3, removed: 3 },
          uncommitted: { added: 40000, removed: 1 },
        },
        {
          session: { added: 254, removed: 30 },
          uncommitted: { added: 12, removed: 3 },
          branch: { added: 1240, removed: 300, base: 'main' },
        },
      ] satisfies DiffStatInput[]) {
        const seg = withNerdFont(nerdFont, () => build(input))
        expect(seg).not.toBeNull()
        expect(stringWidth(seg!.text)).toBe(seg!.width)
      }
    }
  })

  test('omits the zero side', () => {
    const added = withNerdFont(false, () => build({ session: { added: 12, removed: 0 } }))
    expect(added!.text).toContain('+12')
    expect(added!.text).not.toContain('-0')

    const removed = withNerdFont(false, () => build({ session: { added: 0, removed: 9 } }))
    expect(removed!.text).toContain('-9')
    expect(removed!.text).not.toContain('+0')
  })

  test('draws the proportion bar only with a Nerd Font, and only on the session group', () => {
    const input: DiffStatInput = {
      session: { added: 157, removed: 6 },
      uncommitted: { added: 12, removed: 3 },
    }
    const off = withNerdFont(false, () => build(input))
    expect(off!.text).not.toContain('■')
    expect(off!.width).toBe('[ +157 -6  HEAD +12 -3 ]'.length)

    const on = withNerdFont(true, () => build(input))
    // Exactly one run of cells, right after the session numbers — the HEAD
    // group must not grow a second bar.
    expect(on!.text).toContain('-6 ■■■■  HEAD')
    expect(on!.text.match(/■/g)).toHaveLength(4)
    expect(on!.width).toBe('[ +157 -6 ■■■■  HEAD +12 -3 ]'.length)
  })

  test('bar splits four cells in proportion, added first', () => {
    // Both halves use the same glyph, so the split is only observable through
    // the color runs — force color on for this one assertion.
    const level = chalk.level
    chalk.level = 3
    try {
      expect(barRuns(withNerdFont(true, () => build({ session: { added: 50, removed: 50 } }))!.text)).toEqual([2, 2])
      expect(barRuns(withNerdFont(true, () => build({ session: { added: 30, removed: 90 } }))!.text)).toEqual([1, 3])
      // A side too small to round up to a cell yields a single run, not a
      // forced minimum — the number beside the bar is what reports it. Checked
      // in both directions so neither side gets a floor.
      expect(barRuns(withNerdFont(true, () => build({ session: { added: 157, removed: 6 } }))!.text)).toEqual([4])
      expect(barRuns(withNerdFont(true, () => build({ session: { added: 3, removed: 200 } }))!.text)).toEqual([4])
    } finally {
      chalk.level = level
    }
  })

  describe('maxWidth', () => {
    const input: DiffStatInput = {
      session: { added: 254, removed: 30 },
      uncommitted: { added: 12, removed: 3 },
      branch: { added: 1240, removed: 300, base: 'main' },
    }
    const full = '[ +254 -30  HEAD +12 -3  main +1240 -300 ]'.length
    const twoGroups = '[ +254 -30  HEAD +12 -3 ]'.length
    const oneGroup = '[ +254 -30 ]'.length

    test('drops the git groups right-to-left to fit', () => {
      expect(withNerdFont(false, () => build(input, full))!.width).toBe(full)
      expect(withNerdFont(false, () => build(input, full - 1))!.width).toBe(twoGroups)
      expect(withNerdFont(false, () => build(input, twoGroups - 1))!.width).toBe(oneGroup)
    })

    test('returns null rather than overflow when even the lead group is too wide', () => {
      expect(withNerdFont(false, () => build(input, oneGroup - 1))).toBeNull()
    })
  })
})
