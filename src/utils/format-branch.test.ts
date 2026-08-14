import { afterEach, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import { stringWidth } from 'src/ink/stringWidth.js'
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

/** The SGR escape immediately preceding `needle` — i.e. the colour it is in. */
function sgrBefore(text: string, needle: string): string | undefined {
  return text.slice(0, text.indexOf(needle)).match(/\u001b\[[0-9;]*m$/)?.[0]
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
  test('returns null until something has changed', () => {
    expect(build({ session: { added: 0, removed: 0 } })).toBeNull()
  })

  describe('picks the widest scope available', () => {
    const session = { added: 34, removed: 0 }
    const uncommitted = { added: 12, removed: 3 }
    const branch = { added: 552, removed: 5, base: 'main' }

    test('the branch total wins over both narrower scopes', () => {
      // The three nest — the session's writes are part of what is uncommitted,
      // which is part of what the branch carries — so showing more than one
      // restates the same work at a different zoom.
      const seg = withNerdFont(false, () => build({ session, uncommitted, branch }))
      expect(seg!.text).toBe('[ main +552 -5 ]')
    })

    test('falls back to the working tree when the branch is on its base', () => {
      const seg = withNerdFont(false, () => build({ session, uncommitted }))
      expect(seg!.text).toBe('[ HEAD +12 -3 ]')
    })

    test('falls back to the session outside a git repo', () => {
      const seg = withNerdFont(false, () => build({ session }))
      expect(seg!.text).toBe('[ +34 ]')
    })

    test('the branch total shows even when the session wrote nothing', () => {
      // Resuming into an existing branch: the session counter is zero but the
      // work is real, which is the whole reason the git scopes exist.
      const seg = withNerdFont(false, () =>
        build({ session: { added: 0, removed: 0 }, branch }),
      )
      expect(seg!.text).toBe('[ main +552 -5 ]')
    })

    test('a chosen scope with no changes returns null, it does not fall through', () => {
      // A clean tree on the base branch is nothing to report — falling back to
      // the session counter here would resurrect numbers git has since
      // absorbed into a commit.
      expect(
        build({ session: { added: 34, removed: 0 }, uncommitted: { added: 0, removed: 0 } }),
      ).toBeNull()
    })

    test('labels with whatever base name it is given', () => {
      const seg = withNerdFont(false, () =>
        build({ session, branch: { added: 40, removed: 2, base: 'origin/release-2' } }),
      )
      expect(seg!.text).toBe('[ origin/release-2 +40 -2 ]')
    })
  })

  test('reported width matches the rendered cell width', () => {
    // The prompt's top rule sizes its fill from `width`, so a mismatch wraps
    // the rule onto a row Ink did not measure.
    for (const nerdFont of [true, false]) {
      for (const input of [
        { session: { added: 157, removed: 6 } },
        { session: { added: 12, removed: 0 } },
        { session: { added: 0, removed: 9 } },
        { session: { added: 3, removed: 3 }, uncommitted: { added: 40000, removed: 1 } },
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

  test('draws the proportion bar last, and only with a Nerd Font', () => {
    const input: DiffStatInput = {
      session: { added: 34, removed: 0 },
      branch: { added: 552, removed: 5, base: 'main' },
    }
    const off = withNerdFont(false, () => build(input))
    expect(off!.text).not.toContain('■')
    expect(off!.width).toBe('[ main +552 -5 ]'.length)

    const on = withNerdFont(true, () => build(input))
    // Four cells, after the numbers rather than between them.
    expect(on!.text).toBe('[ main +552 -5 ■■■■ ]')
    expect(on!.width).toBe('[ main +552 -5 ■■■■ ]'.length)
  })

  test('the bar describes the scope actually shown, not the session', () => {
    const level = chalk.level
    chalk.level = 3
    try {
      // Split 50/50 on the session and all-deletions on the branch, so a bar
      // built from the wrong scope differs in its run LENGTHS ([2,2] vs [4])
      // and not only in colour — run lengths alone cannot tell four green
      // cells from four red ones.
      const seg = withNerdFont(true, () =>
        build({
          session: { added: 50, removed: 50 },
          branch: { added: 0, removed: 100, base: 'main' },
        }),
      )!
      expect(barRuns(seg.text)).toEqual([4])
      // …and pin the colour too, against the SGR the segment itself puts on
      // the removed count. Theme-agnostic: it compares the bar to a run known
      // to be red rather than to a hardcoded escape.
      expect(sgrBefore(seg.text, '■')).toBe(sgrBefore(seg.text, '-100'))
    } finally {
      chalk.level = level
    }
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
      session: { added: 34, removed: 0 },
      branch: { added: 552, removed: 5, base: 'main' },
    }
    const plain = '[ main +552 -5 ]'.length
    const withBar = '[ main +552 -5 ■■■■ ]'.length

    test('fits exactly at its own width', () => {
      expect(withNerdFont(false, () => build(input, plain))!.width).toBe(plain)
      expect(withNerdFont(true, () => build(input, withBar))!.width).toBe(withBar)
    })

    test('returns null rather than overflow the rule', () => {
      expect(withNerdFont(false, () => build(input, plain - 1))).toBeNull()
      expect(withNerdFont(true, () => build(input, withBar - 1))).toBeNull()
    })
  })
})
