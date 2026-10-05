/**
 * Characterization of the bordered box the AskUserQuestion dialog draws an
 * option's preview in. Written before the clean-base rewrite of
 * permissions/askUserQuestionViews; the spec is
 * docs/tech/rewrite/permissions/askUserQuestionViews.md.
 *
 * The geometry is pinned on static frames: how wide the box gets for a given
 * terminal, content and pair of limits, how tall, and how it says lines were
 * cut. The preview text comes from the model, so what it may and may not send
 * to the terminal is pinned too.
 *
 * The code highlighter decides on its own whether the terminal takes colour,
 * and a test process is not a terminal. So under the plain runner this file
 * also runs itself again in a child with FORCE_COLOR=3, where the
 * highlighting cases run.
 */
import { describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import * as React from 'react'
import { PreviewBox } from 'src/permissions/ui/AskUserQuestionPermissionRequest/PreviewBox.js'
import { still, stillStyled } from 'src/permissions/ui/__testutils__/askUserQuestionViewsRig.js'
import { isolatedWorld, mount, SLOW, styleBefore, withTruecolor } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { Text } from 'src/terminal/ink.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

isolatedWorld()
withTruecolor()

/** Everything the box takes but its content. */
type Limits = Omit<React.ComponentProps<typeof PreviewBox>, 'content'>

/** The box a reader expects: `width` columns in all, text starting two columns in. */
function framed(width: number, body: string[], hidden?: number): string[] {
  const rule = '─'.repeat(width - 2)
  const out = [`┌${rule}┐`, ...body.map(text => `│ ${text.padEnd(width - 4 - (displayWidth(text) - text.length))} │`)]
  if (hidden !== undefined) {
    const label = `─── ✂ ─── ${hidden} lines hidden `
    out.push(`├${label}${'─'.repeat(Math.max(0, width - 2 - label.length))}┤`)
  }
  out.push(`└${rule}┘`)
  return out
}

/** Columns a test string takes: the CJK used below is two columns a character. */
const displayWidth = (text: string) => [...text].reduce((sum, ch) => sum + (/[\u4e00-\u9fff]/.test(ch) ? 2 : 1), 0)

const linesOf = (frame: string) => frame.split('\n').map(line => line.trimEnd()).filter(line => line !== '')
const numbered = (count: number) => Array.from({ length: count }, (_, i) => `row ${i + 1}`)
const blank = (count: number) => Array<string>(count).fill('')
const CJK = '漢字'.repeat(12)

describe('PreviewBox: geometry', () => {
  // [what, content, props, terminal columns, expected box]
  const cases: Array<[string, string, Limits, number, string[]]> = [
    ['short text gets the 40-column minimum plus the frame', 'hello\nworld', {}, 80, framed(44, ['hello', 'world'])],
    ['with no maxWidth the terminal minus four caps it', 'hello\nworld', {}, 40, framed(36, ['hello', 'world'])],
    ['a smaller minWidth lets the box hug its text', 'short', { minWidth: 10 }, 60, framed(14, ['short'])],
    ['maxWidth wins over minWidth', 'short', { maxWidth: 20 }, 80, framed(20, ['short'])],
    ['text wider than the minimum widens the box', 'w'.repeat(50), {}, 120, framed(54, ['w'.repeat(50)])],
    ['a line wider than the box is cut at the inner width', 'x'.repeat(100), { minWidth: 10 }, 60, framed(56, ['x'.repeat(52)])],
    ['wide characters are cut whole', CJK, { maxWidth: 50 }, 80, framed(50, ['漢字'.repeat(11) + '漢'])],
    ['empty content is one blank row', '', {}, 80, framed(44, [''])],
    ['minHeight pads with blank rows', 'a\nb', { minHeight: 5 }, 80, framed(44, ['a', 'b', ...blank(3)])],
    ['minHeight is capped by maxLines', 'a', { maxLines: 3, minHeight: 4 }, 80, framed(44, ['a', '', ''])],
    ['minHeight is capped by the default of 20 lines', 'a', { minHeight: 50 }, 80, framed(44, ['a', ...blank(19)])],
    ['past maxLines the rest is hidden behind a bar', 'a\nb\nc\nd\ne', { maxLines: 3 }, 80, framed(44, ['a', 'b', 'c'], 2)],
    ['the default limit is 20 lines', numbered(30).join('\n'), {}, 80, framed(44, numbered(20), 10)],
    ['exactly maxLines lines: no bar', numbered(3).join('\n'), { maxLines: 3 }, 80, framed(44, numbered(3))],
    ['a cut box is never padded: minHeight is capped by the rows it already fills', 'a\nb\nc\nd\ne', { maxLines: 3, minHeight: 5 }, 80, framed(44, ['a', 'b', 'c'], 2)],
    ['a cut box at exactly minHeight rows gets nothing more', 'a\nb\nc\nd\ne', { maxLines: 2, minHeight: 2 }, 80, framed(44, ['a', 'b'], 3)],
  ]
  for (const [what, content, props, columns, expected] of cases) {
    test(
      what,
      async () => {
        expect(linesOf(await still(<PreviewBox content={content} {...props} />, columns))).toEqual(expected.map(line => line.trimEnd()))
      },
      SLOW,
    )
  }

  test(
    'a run of blank lines is one paragraph break, kept as one blank row',
    async () => {
      const frame = await still(<PreviewBox content={'top\n\n\nbottom'} />, 80)
      expect(frame.split('\n').map(line => line.trimEnd())).toEqual(framed(44, ['top', '', 'bottom']))
    },
    SLOW,
  )
})

describe('PreviewBox: content is markdown', () => {
  const cases: Array<[string, string, string[]]> = [
    ['a heading loses its hashes, emphasis its stars', '# Title\n\nsee **bold** and *soft*', ['Title', '', '', 'see bold and soft']],
    ['a fenced block shows its code without the fences', '```ts\nconst x: number = 1\n```', ['const x: number = 1']],
    ['a list keeps its markers', '- one\n- two', ['- one', '- two']],
    ['plain multi-line text is kept line for line', 'first\n  indented\nlast', ['first', '  indented', 'last']],
  ]
  for (const [what, content, body] of cases) {
    test(
      what,
      async () => {
        const frame = await still(<PreviewBox content={content} maxWidth={60} />, 80)
        expect(frame.split('\n').map(line => line.trimEnd())).toEqual(framed(44, body))
      },
      SLOW,
    )
  }

  test(
    'a markdown link shows its text and links it to the URL',
    async () => {
      const styled = await stillStyled(<PreviewBox content={'see [the docs](https://docs.example.com/x)'} />, 80)
      expect(styled).toMatch(/\u001B\]8;[^;]*;https:\/\/docs\.example\.com\/x\u0007(\u001B\[[0-9;]*m)*the docs\u001B\]8;;\u0007/)
      expect(linesOf(await still(<PreviewBox content={'see [the docs](https://docs.example.com/x)'} />, 80))[1]).toBe(`│ ${'see the docs'.padEnd(40)} │`)
    },
    SLOW,
  )
})

describe('PreviewBox: styling', () => {
  const reference = async (props: React.ComponentProps<typeof Text>) => {
    const probe = await mount(<Text {...props}>SAMPLE</Text>)
    const codes = styleBefore(probe.styled(), 'SAMPLE')
    await probe.close()
    return codes
  }

  test(
    'the frame is dim, the cut bar is in the warning colour, the text keeps its own colour',
    async () => {
      const box = await mount(<PreviewBox content={'plain \u001B[31mred\u001B[0m\nb\nc'} maxLines={1} />, { columns: 80 })
      const styled = box.styled()
      const dim = await reference({ dimColor: true })
      expect(styleBefore(styled, '┌')).toBe(dim)
      expect(styleBefore(styled, '└')).toBe(dim)
      expect(styleBefore(styled, '│ ')).toBe(dim)
      expect(styleBefore(styled, '├')).toBe(await reference({ color: 'warning' }))
      expect(styleBefore(styled, 'red')).toMatch(/\u001B\[31m/)
      expect(styleBefore(styled, 'plain')).not.toBe(dim)
    },
    SLOW,
  )

  test(
    'with syntax highlighting turned off in the settings the box still draws its code',
    async () => {
      const settings = { ...getDefaultAppState().settings, syntaxHighlightingDisabled: true }
      const frame = await still(<PreviewBox content={'```ts\nconst x = 1\n```'} />, 80, 'default', { settings })
      expect(linesOf(frame)).toEqual(framed(44, ['const x = 1']))
    },
    SLOW,
  )
})

describe('PreviewBox: what model text may send to the terminal', () => {
  // The preview is written by the model. Only colour may reach the terminal from it.
  const ESC = '\u001B'
  const BEL = '\u0007'
  const controls = {
    'wipe the screen': `${ESC}[2J`,
    'lift the cursor five rows': `${ESC}[5A`,
    'enter the alternate buffer': `${ESC}[?1049h`,
    'retitle the window': `${ESC}]0;owned${BEL}`,
    'sound the bell': BEL,
  }
  for (const [what, sequence] of Object.entries(controls)) {
    test(
      `a sequence to ${what} is dropped, the text around it kept`,
      async () => {
        const styled = await stillStyled(<PreviewBox content={`before${sequence}after`} />, 80)
        expect(styled).not.toContain(sequence)
        expect(linesOf(await still(<PreviewBox content={`before${sequence}after`} />, 80))[1]).toBe(`│ ${'beforeafter'.padEnd(40)} │`)
      },
      SLOW,
    )
  }
})

const colourChild = process.env.FORCE_COLOR === '3'

if (!colourChild) {
  test('passes again where the highlighter may colour', async () => {
    const checkout = join(dirname(import.meta.path), '..', '..', '..', '..')
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: checkout,
      env: { ...process.env, FORCE_COLOR: '3' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const output = `${out}\n${err}`
    const passed = Number(/(\d+) pass/.exec(output)?.[1] ?? '0')
    const failed = Number(/(\d+) fail/.exec(output)?.[1] ?? '1')
    if (exit !== 0 || failed !== 0 || passed === 0) throw new Error(`the coloured run did not pass (exit ${exit}):\n${output}`)
    expect(passed).toBeGreaterThan(0)
  }, 120_000)
}

describe('PreviewBox: syntax highlighting', () => {
  const code = '```ts\nconst total: number = 1\n```'
  /** Waits for the highlighter to load, then gives the escape codes in front of `word`. */
  const codesBefore = async (word: string, state: Parameters<typeof mount>[1] = {}) => {
    const box = await mount(<PreviewBox content={code} />, { columns: 80, ...state })
    await Bun.sleep(400)
    return styleBefore(box.styled(), word)
  }
  const setsForeground = /\u001B\[(3[0-8])[;m]/

  test.if(colourChild)(
    'a fenced block in a known language is coloured',
    async () => {
      expect(await codesBefore('const')).toMatch(setsForeground)
      expect(await codesBefore('number')).toMatch(setsForeground)
    },
    SLOW,
  )

  test.if(colourChild)(
    'the settings switch turns the colouring off',
    async () => {
      const settings = { ...getDefaultAppState().settings, syntaxHighlightingDisabled: true }
      expect(await codesBefore('const', { appState: { settings } })).not.toMatch(setsForeground)
    },
    SLOW,
  )
})
