/**
 * Characterization suite for src/vcs/diff/structured/colorDiff.ts, the switch
 * in front of the syntax renderer in src/native-ts/color-diff. Its callers
 * (the diff pane, highlighted code blocks, the explorer's editor, the theme
 * picker) ask it for the renderer's classes and for the syntax palette of a
 * theme, and get null instead when the user turned highlighting off through
 * CLAUDIN_SYNTAX_HIGHLIGHT. Written before the clean-base rewrite; the spec is
 * docs/tech/rewrite/vcs/structuredDiff.md.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import * as renderer from 'src/native-ts/color-diff/index.js'
import { THEME_NAMES } from 'src/terminal/theme/theme.js'
import {
  expectColorDiff,
  expectColorFile,
  expectEditorHighlighter,
  getColorModuleUnavailableReason,
  getSyntaxTheme,
} from 'src/vcs/diff/structured/colorDiff.js'

let valueBefore: string | undefined

beforeEach(() => {
  valueBefore = process.env.CLAUDIN_SYNTAX_HIGHLIGHT
  delete process.env.CLAUDIN_SYNTAX_HIGHLIGHT
})

afterEach(() => {
  if (valueBefore === undefined) delete process.env.CLAUDIN_SYNTAX_HIGHLIGHT
  else process.env.CLAUDIN_SYNTAX_HIGHLIGHT = valueBefore
})

/** Values that turn highlighting off: the four words, in any case, with blanks around them. */
const TURNED_OFF = ['0', 'false', 'no', 'off', 'FALSE', 'No', 'oFf', ' off ', '\tno\n']
/** Anything else leaves it on, the empty string included. */
const LEFT_ON = ['', '1', 'true', 'yes', 'on', 'Monokai Extended', 'nope', '00', 'offline']

function everyAnswer() {
  return {
    reason: getColorModuleUnavailableReason(),
    colorDiff: expectColorDiff(),
    colorFile: expectColorFile(),
    editorHighlighter: expectEditorHighlighter(),
    syntaxTheme: getSyntaxTheme('dark'),
  }
}

describe('colorDiff: is highlighting available', () => {
  test('with CLAUDIN_SYNTAX_HIGHLIGHT unset it is, and each accessor hands out the renderer\'s own class', () => {
    expect(everyAnswer()).toEqual({
      reason: null,
      colorDiff: renderer.ColorDiff,
      colorFile: renderer.ColorFile,
      editorHighlighter: renderer.EditorHighlighter,
      syntaxTheme: renderer.getSyntaxTheme('dark'),
    })
    expect(expectColorDiff()).toBe(renderer.ColorDiff)
    expect(expectColorFile()).toBe(renderer.ColorFile)
    expect(expectEditorHighlighter()).toBe(renderer.EditorHighlighter)
  })

  test('0, false, no and off turn it off, for the reason "env", and every accessor answers null', () => {
    for (const value of TURNED_OFF) {
      process.env.CLAUDIN_SYNTAX_HIGHLIGHT = value
      expect({ value, ...everyAnswer() }).toEqual({
        value,
        reason: 'env',
        colorDiff: null,
        colorFile: null,
        editorHighlighter: null,
        syntaxTheme: null,
      })
    }
  })

  test('any other value leaves it on, the empty string included', () => {
    for (const value of LEFT_ON) {
      process.env.CLAUDIN_SYNTAX_HIGHLIGHT = value
      const answers = everyAnswer()
      expect({ value, reason: answers.reason }).toEqual({ value, reason: null })
      expect(answers.colorDiff).toBe(renderer.ColorDiff)
      expect(answers.colorFile).toBe(renderer.ColorFile)
      expect(answers.editorHighlighter).toBe(renderer.EditorHighlighter)
      expect(answers.syntaxTheme).toEqual(renderer.getSyntaxTheme('dark'))
    }
  })

  test('the variable is read on every call, so a change takes effect at once, both ways', () => {
    expect(getColorModuleUnavailableReason()).toBeNull()
    process.env.CLAUDIN_SYNTAX_HIGHLIGHT = 'off'
    expect(getColorModuleUnavailableReason()).toBe('env')
    expect(expectColorDiff()).toBeNull()
    delete process.env.CLAUDIN_SYNTAX_HIGHLIGHT
    expect(getColorModuleUnavailableReason()).toBeNull()
    expect(expectColorDiff()).toBe(renderer.ColorDiff)
  })
})

describe('colorDiff: getSyntaxTheme', () => {
  test('describes the syntax palette of every theme exactly as the renderer does', () => {
    for (const theme of THEME_NAMES) {
      expect({ theme, palette: getSyntaxTheme(theme) }).toEqual({ theme, palette: renderer.getSyntaxTheme(theme) })
    }
    // What the theme picker shows next to "Syntax theme:".
    expect(getSyntaxTheme('dark')).toEqual({ theme: 'Monokai Extended', source: null })
    expect(getSyntaxTheme('light')).toEqual({ theme: 'GitHub', source: null })
  })

  test('answers null for every theme while highlighting is off', () => {
    process.env.CLAUDIN_SYNTAX_HIGHLIGHT = 'false'
    for (const theme of THEME_NAMES) expect({ theme, palette: getSyntaxTheme(theme) }).toEqual({ theme, palette: null })
  })
})

describe('colorDiff: the classes, used the way their callers use them', () => {
  test('a ColorDiff draws a hunk as numbered, marked rows of the requested width', () => {
    const Diff = expectColorDiff()!
    const hunk = { oldStart: 4, oldLines: 2, newStart: 4, newLines: 2, lines: [' keep', '-old', '+new'] }
    const rows = new Diff(hunk, null, 'notes.txt', null).render('dark', 20, false)!
    expect(rows.map(row => stripAnsi(row).trimEnd())).toEqual([' 4  keep', ' 5 -old', ' 5 +new'])
  })

  test('a ColorFile draws a whole file as numbered rows', () => {
    const File = expectColorFile()!
    const rows = new File('first\nsecond\n', 'notes.txt').render('dark', 20, false)!
    expect(rows.map(row => stripAnsi(row).trimEnd())).toEqual([' 1 first', ' 2 second'])
  })

  test('an EditorHighlighter draws a window of one line, padded to its width', () => {
    const Highlighter = expectEditorHighlighter()!
    const highlighter = new Highlighter('notes.txt', null, 'dark')
    expect(stripAnsi(highlighter.renderLineWindow('abcdefgh', 2, 4))).toBe('cdef')
    expect(stripAnsi(highlighter.renderLineWindow('ab', 0, 4))).toBe('ab  ')
  })
})
