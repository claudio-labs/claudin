import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import type { StructuredPatchHunk } from 'diff'
import stripAnsi from 'strip-ansi'
import { ColorDiff, type Hunk } from 'src/native-ts/color-diff/index.js'
import { color } from 'src/terminal/design-system/color.js'
import { stringWidth } from 'src/terminal/ink/stringWidth.js'
import { type HighlightedPicture, highlightedPicture } from 'src/vcs/diff/structured/highlighted/picture.js'

const NOTE = '\\ No newline at end of file'

let levelBefore = chalk.level
beforeAll(() => {
  levelBefore = chalk.level
  chalk.level = 3
})
afterAll(() => {
  chalk.level = levelBefore
})

type Request = Parameters<typeof highlightedPicture>[0]

function requestFor(hunk: StructuredPatchHunk, changes: Partial<Request> = {}): Request {
  return {
    hunk,
    themeName: 'dark',
    width: 40,
    dim: false,
    filePath: 'notes.txt',
    firstLine: null,
    fileContent: null,
    fenced: false,
    ...changes,
  }
}

type Call = {
  hunk: Hunk
  firstLine: string | null
  filePath: string
  fileContent: string | null | undefined
  themeName: string
  width: number
  dim: boolean
}

/** The real renderer, recording what it is given; `draw` can replace what it returns. */
function recordingRenderer(draw?: () => string[] | null) {
  const calls: Call[] = []
  class RecordingRenderer extends ColorDiff {
    readonly #given: Omit<Call, 'themeName' | 'width' | 'dim'>
    constructor(hunk: Hunk, firstLine: string | null, filePath: string, fileContent?: string | null) {
      super(hunk, firstLine, filePath, fileContent)
      this.#given = { hunk, firstLine, filePath, fileContent }
    }
    override render(themeName: string, width: number, dim: boolean): string[] | null {
      calls.push({ ...this.#given, themeName, width, dim })
      return draw ? draw() : super.render(themeName, width, dim)
    }
  }
  return { Renderer: RecordingRenderer, calls }
}

function hunkOf(lines: string[], start = 1): StructuredPatchHunk {
  const counted = lines.filter(line => !line.startsWith('\\'))
  return {
    oldStart: start,
    oldLines: counted.filter(line => !line.startsWith('+')).length,
    newStart: start,
    newLines: counted.filter(line => !line.startsWith('-')).length,
    lines,
  }
}

const plainRows = (rows: string[]): string[] => rows.map(row => stripAnsi(row).trimEnd())

function wholeRows(picture: HighlightedPicture | null): string[] {
  if (picture?.kind !== 'whole') throw new Error(`expected the rows in one piece, got ${JSON.stringify(picture)}`)
  return picture.rows
}

describe('highlightedPicture: what the renderer draws', () => {
  test('a hunk with nothing to clean is painted exactly as the renderer draws it', () => {
    const hunk = hunkOf([' keep = 1', '-value = 2', '+value = 3'], 3)
    expect(highlightedPicture(requestFor(hunk), ColorDiff)).toEqual({
      kind: 'whole',
      rows: new ColorDiff(hunk, null, 'notes.txt', null).render('dark', 40, false)!,
    })
  })

  test('the renderer is handed the sanitized hunk without its notes, and every parameter', () => {
    const { Renderer, calls } = recordingRenderer()
    const hunk = hunkOf([' keep\u001B[8m', '-old\r', NOTE, '+new\tone', NOTE], 7)
    highlightedPicture(
      requestFor(hunk, {
        themeName: 'light',
        width: 33,
        dim: true,
        filePath: 'bin/tool',
        firstLine: '#!/bin/sh',
        fileContent: 'keep\nold',
      }),
      Renderer,
    )
    expect(calls).toEqual([
      {
        hunk: { oldStart: 7, oldLines: 2, newStart: 7, newLines: 2, lines: [' keep', '-old', '+new one'] },
        firstLine: '#!/bin/sh',
        filePath: 'bin/tool',
        fileContent: 'keep\nold',
        themeName: 'light',
        width: 33,
        dim: true,
      },
    ])
    expect(hunk.lines).toEqual([' keep\u001B[8m', '-old\r', NOTE, '+new\tone', NOTE])
  })

  test('the renderer drawing nothing means the plain diff has to stand in', () => {
    const { Renderer } = recordingRenderer(() => null)
    expect(highlightedPicture(requestFor(hunkOf(['+a'])), Renderer)).toBeNull()
  })

  test('tabs reach the renderer expanded, so no row runs past the width', () => {
    const rows = wholeRows(
      highlightedPicture(requestFor(hunkOf(['+\tif (ready) {\t// start\tthe engine now']), { width: 30 }), ColorDiff),
    )
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      expect(row).not.toContain('\t')
      expect(stringWidth(stripAnsi(row))).toBeLessThanOrEqual(30)
    }
  })
})

describe('highlightedPicture: the no-newline note', () => {
  const noted = () =>
    hunkOf([' one', '-two, a line long enough to wrap at this width', NOTE, '+two', '+three'])

  test('sits under every row of the line it qualifies, with no number, and the numbers after it do not move', () => {
    expect(plainRows(wholeRows(highlightedPicture(requestFor(noted(), { width: 30 }), ColorDiff)))).toEqual([
      ' 1  one',
      ' 2 -two, a line long enough to',
      '   - wrap at this width',
      '   \\ No newline at end of file',
      ' 2 +two',
      ' 3 +three',
    ])
  })

  test("is drawn in the theme's quiet colour, as the plain diff draws it", () => {
    const rows = wholeRows(highlightedPicture(requestFor(noted(), { width: 30, themeName: 'light' }), ColorDiff))
    expect(rows[3]).toBe(color('inactive', 'light')('   \\ No newline at end of file'))
  })

  test('before any line of code, and after the last, it is still drawn in its place', () => {
    const hunk: StructuredPatchHunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [NOTE, '-a', '+b', NOTE] }
    expect(plainRows(wholeRows(highlightedPicture(requestFor(hunk), ColorDiff)))).toEqual([
      '   \\ No newline at end of file',
      ' 1 -a',
      ' 1 +b',
      '   \\ No newline at end of file',
    ])
  })

  test('rows that cannot be mapped onto the lines keep all their rows, and the notes go after them', () => {
    const unnumbered = recordingRenderer(() => ['first row', 'second row'])
    expect(plainRows(wholeRows(highlightedPicture(requestFor(noted()), unnumbered.Renderer)))).toEqual([
      'first row',
      'second row',
      '   \\ No newline at end of file',
    ])
    const headed = recordingRenderer(() => ['a heading row', ' 1 -a', ' 1 +b'])
    const hunk: StructuredPatchHunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', NOTE, '+b'] }
    expect(plainRows(wholeRows(highlightedPicture(requestFor(hunk), headed.Renderer)))).toEqual([
      'a heading row',
      ' 1 -a',
      ' 1 +b',
      '   \\ No newline at end of file',
    ])
  })
})

describe('highlightedPicture: kept pictures', () => {
  test('drawing a hunk object again with the same parameters does not run the renderer again', () => {
    const { Renderer, calls } = recordingRenderer()
    const hunk = hunkOf([' a', '-b', '+c'])
    const first = highlightedPicture(requestFor(hunk), Renderer)
    expect(highlightedPicture(requestFor(hunk), Renderer)).toBe(first)
    expect(calls.length).toBe(1)
  })

  test('any other parameter, or another hunk object with the same lines, is drawn afresh', () => {
    const { Renderer, calls } = recordingRenderer()
    const hunk = hunkOf([' a', '-b', '+c'])
    const variants: Partial<Request>[] = [
      {},
      { themeName: 'light' },
      { width: 41 },
      { dim: true },
      { filePath: 'notes.py' },
      { firstLine: '#!/usr/bin/env python3' },
      { fenced: true },
    ]
    for (const variant of variants) highlightedPicture(requestFor(hunk, variant), Renderer)
    highlightedPicture(requestFor(hunkOf([' a', '-b', '+c'])), Renderer)
    expect(calls.length).toBe(variants.length + 1)
  })

  test('only the latest few pictures of a hunk are kept, so resizing does not pile them up', () => {
    const { Renderer, calls } = recordingRenderer()
    const hunk = hunkOf([' a', '-b', '+c'])
    for (let width = 20; width <= 40; width++) highlightedPicture(requestFor(hunk, { width }), Renderer)
    expect(calls.length).toBe(21)
    highlightedPicture(requestFor(hunk, { width: 40 }), Renderer)
    expect(calls.length).toBe(21)
    highlightedPicture(requestFor(hunk, { width: 20 }), Renderer)
    expect(calls.length).toBe(22)
  })
})

describe('highlightedPicture: the fullscreen fence', () => {
  test('sets the gutter apart as its own column, and the two columns put together are the rows', () => {
    const hunk = () => hunkOf([' one', '-two, a line long enough to wrap at this width', NOTE, '+two'])
    const whole = wholeRows(highlightedPicture(requestFor(hunk(), { width: 30 }), ColorDiff))
    const picture = highlightedPicture(requestFor(hunk(), { width: 30, fenced: true }), ColorDiff)
    if (picture?.kind !== 'fenced') throw new Error('expected a fenced picture')
    expect(picture.gutterWidth).toBe(4)
    expect(picture.gutter.map(row => stripAnsi(row))).toEqual([' 1  ', ' 2 -', '   -', '   \\', ' 2 +'])
    expect(picture.gutter.map((gutter, at) => stripAnsi(gutter + picture.code[at])).map(row => row.trimEnd())).toEqual(
      plainRows(whole),
    )
  })

  test("the gutter is as wide as the digits of the hunk's last line on the longer side, plus three", () => {
    const grown = hunkOf([' a', '+b', '+c'], 8)
    const shrunk = hunkOf([' a', '-b', '-c'], 8)
    for (const [hunk, gutter] of [
      [grown, ['  8  ', '  9 +', ' 10 +']],
      [shrunk, ['  8  ', '  9 -', ' 10 -']],
    ] as const) {
      const picture = highlightedPicture(requestFor(hunk, { width: 30, fenced: true }), ColorDiff)
      if (picture?.kind !== 'fenced') throw new Error('expected a fenced picture')
      expect(picture.gutterWidth).toBe(5)
      expect(picture.gutter.map(row => stripAnsi(row))).toEqual([...gutter])
    }
  })

  test('with the width no wider than the gutter, nothing is set apart', () => {
    const picture = highlightedPicture(requestFor(hunkOf(['-abc', '+abd']), { width: 4, fenced: true }), ColorDiff)
    expect(picture?.kind).toBe('whole')
    const wider = highlightedPicture(requestFor(hunkOf(['-abc', '+abd']), { width: 5, fenced: true }), ColorDiff)
    expect(wider?.kind).toBe('fenced')
  })
})
