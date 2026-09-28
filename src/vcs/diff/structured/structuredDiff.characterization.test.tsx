/**
 * Characterization suite for the patch renderer in src/vcs/diff/structured/:
 * `StructuredDiff` draws one hunk, `StructuredDiffList` draws several with a
 * separator between them, and a plain fallback takes over when syntax
 * highlighting is off. It was written before the clean-base rewrite, and the
 * new implementation has to pass it unchanged.
 *
 * Everything is observed the way a user sees it: a real Ink root on a fake
 * terminal, and the last frame it painted, replayed into cells (character,
 * foreground, background, dim). The highlighted path is compared with what
 * the syntax renderer in src/native-ts/color-diff draws for the same inputs;
 * the fallback with the theme's diff colours. The spec that goes with it is
 * docs/tech/rewrite/vcs/structuredDiff.md.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import { type StructuredPatchHunk, structuredPatch } from 'diff'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import { ColorDiff } from 'src/native-ts/color-diff/index.js'
import { getOriginalCwd, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import type { SettingsJson } from 'src/platform/settings/types.js'
import { createFakeTerminal, type FakeTerminal, lastPaintedFrame } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot, ThemeProvider, usePreviewTheme } from 'src/terminal/ink.js'
import { AppStateProvider, useSetAppState } from 'src/terminal/state/AppState.js'
import { type AppState, getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import { getTheme, type ThemeName } from 'src/terminal/theme/theme.js'
import { StructuredDiff } from 'src/vcs/diff/structured/StructuredDiff.js'
import { StructuredDiffList } from 'src/vcs/diff/structured/StructuredDiffList.js'

// Each test mounts at least one Ink root; keep clear of bun's 5 s default.
const TIMEOUT = 30_000

// --- process state the suite pins and puts back ----------------------------------

const PINNED_VARIABLES = ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_NO_FLICKER', 'CLAUDIN_SYNTAX_HIGHLIGHT', 'COLORTERM'] as const
const variablesBefore = new Map<string, string | undefined>()
let cwdBefore = ''
let colourLevelBefore = chalk.level
let sandbox = ''

beforeAll(() => {
  for (const name of PINNED_VARIABLES) variablesBefore.set(name, process.env[name])
  cwdBefore = getOriginalCwd()
  colourLevelBefore = chalk.level
  // The fallback draws through chalk, which is off when stdout is not a TTY.
  // Truecolor makes the theme's colours readable in the frame.
  chalk.level = 3
  process.env.COLORTERM = 'truecolor'
})

beforeEach(() => {
  // Settings are read from the user's config dir and from the project, so
  // both point at a fresh directory that holds nothing.
  sandbox = mkdtempSync(join(tmpdir(), 'structured-diff-'))
  mkdirSync(join(sandbox, 'config'))
  mkdirSync(join(sandbox, 'project'))
  process.env.CLAUDIN_CONFIG_DIR = join(sandbox, 'config')
  setOriginalCwd(join(sandbox, 'project'))
  delete process.env.CLAUDIN_SYNTAX_HIGHLIGHT
  process.env.CLAUDIN_NO_FLICKER = '0'
})

afterEach(() => {
  setOriginalCwd(cwdBefore)
  rmSync(sandbox, { recursive: true, force: true })
})

afterAll(() => {
  chalk.level = colourLevelBefore
  setOriginalCwd(cwdBefore)
  for (const [name, value] of variablesBefore) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

// --- replaying the frame into cells --------------------------------------------

/** A painted cell: its character and the pen it was drawn with. */
type Cell = { ch: string; fg: string; bg: string; dim: boolean }
type Row = Cell[]
type Pen = Omit<Cell, 'ch'>

/** CSI (with its parameters and final byte), OSC, or a two-byte escape. */
const ESCAPE = /\u001B(?:\[([\d;?]*)([@-~])|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/y

function colourFrom(codes: number[], at: number): { colour: string; used: number } {
  if (codes[at + 1] === 2) return { colour: `rgb(${codes.slice(at + 2, at + 5).join(',')})`, used: 4 }
  return { colour: `256:${codes[at + 2]}`, used: 2 }
}

function applySgr(pen: Pen, parameters: string): void {
  const codes = parameters === '' ? [0] : parameters.split(';').map(Number)
  for (let at = 0; at < codes.length; at++) {
    const code = codes[at]!
    if (code === 38 || code === 48) {
      const { colour, used } = colourFrom(codes, at)
      if (code === 38) pen.fg = colour
      else pen.bg = colour
      at += used
    } else if (code === 0) {
      pen.fg = ''
      pen.bg = ''
      pen.dim = false
    } else if (code === 2) pen.dim = true
    else if (code === 22) pen.dim = false
    else if (code === 39) pen.fg = ''
    else if (code === 49) pen.bg = ''
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) pen.fg = `ansi:${code}`
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) pen.bg = `ansi:${code}`
  }
}

/** Cells that nothing was drawn in: trailing spaces with no background. */
function withoutTrailingBlanks(row: Row): Row {
  let end = row.length
  while (end > 0 && row[end - 1]!.ch === ' ' && row[end - 1]!.bg === '') end--
  return row.slice(0, end)
}

/** Replays text and escape codes into rows of cells. */
function replay(stream: string): Row[] {
  const rows: Row[] = [[]]
  const pen: Pen = { fg: '', bg: '', dim: false }
  let at = 0
  while (at < stream.length) {
    ESCAPE.lastIndex = at
    const escape = ESCAPE.exec(stream)
    if (escape) {
      at = ESCAPE.lastIndex
      const [, parameters = '', final] = escape
      if (final === 'm' && !parameters.startsWith('?')) applySgr(pen, parameters)
      if (final === 'C') {
        for (let n = Number(parameters || 1); n > 0; n--) rows.at(-1)!.push({ ch: ' ', fg: '', bg: '', dim: false })
      }
      continue
    }
    const ch = String.fromCodePoint(stream.codePointAt(at)!)
    at += ch.length
    if (ch === '\n') rows.push([])
    else if (ch !== '\r') rows.at(-1)!.push({ ch, ...pen })
  }
  return rows.map(withoutTrailingBlanks)
}

const textOf = (row: Row): string => row.map(cell => cell.ch).join('')
const textsOf = (rows: Row[]): string[] => rows.map(textOf)

/** The cells under the first occurrence of `fragment` in the row. */
function cellsUnder(row: Row, fragment: string): Row {
  const at = textOf(row).indexOf(fragment)
  if (at < 0) throw new Error(`"${fragment}" is not in the row "${textOf(row)}"`)
  return row.slice(at, at + fragment.length)
}

const backgroundsOf = (cells: Row): string[] => [...new Set(cells.map(cell => cell.bg))]

// --- what the syntax renderer and the theme say ----------------------------------

type Drawing = {
  width: number
  filePath: string
  theme?: ThemeName
  dim?: boolean
  firstLine?: string | null
  fileContent?: string | null
}

/** The rows the syntax renderer draws for a hunk, as cells. */
function rendererRows(hunk: StructuredPatchHunk, drawing: Drawing): Row[] {
  const renderer = new ColorDiff(hunk, drawing.firstLine ?? null, drawing.filePath, drawing.fileContent ?? null)
  const lines = renderer.render(drawing.theme ?? 'dark', drawing.width, drawing.dim ?? false)
  if (!lines) throw new Error('the syntax renderer drew nothing')
  return lines.map(line => replay(line)[0]!)
}

/** The theme colours the fallback draws with, in the form the replay reports. */
function fallbackColours(theme: ThemeName) {
  const colours = getTheme(theme)
  const plain = (value: string) => value.replace(/\s+/g, '')
  return {
    added: plain(colours.diffAdded),
    removed: plain(colours.diffRemoved),
    addedWord: plain(colours.diffAddedWord),
    removedWord: plain(colours.diffRemovedWord),
    addedDimmed: plain(colours.diffAddedDimmed),
    removedDimmed: plain(colours.diffRemovedDimmed),
    text: plain(colours.text),
  }
}

// --- hunks --------------------------------------------------------------------

/** A hunk that starts at the same line on both sides. Fresh object per call. */
function hunkAt(start: number, lines: string[]): StructuredPatchHunk {
  return {
    oldStart: start,
    oldLines: lines.filter(line => !line.startsWith('+')).length,
    newStart: start,
    newLines: lines.filter(line => !line.startsWith('-')).length,
    lines,
  }
}

const CONFIG_BEFORE = [
  "import { readFile } from 'node:fs/promises'",
  '',
  'export async function loadConfig(path) {',
  "  const raw = await readFile(path, 'utf8')",
  '  return JSON.parse(raw)',
  '}',
  '',
].join('\n')

const CONFIG_AFTER = CONFIG_BEFORE.replace("'utf8'", "'latin1'").replace(
  'return JSON.parse(raw)',
  'return { ...JSON.parse(raw), source: path }',
)

/** The hunk an edit of config.js produces, the way the edit tools compute it. */
function configEdit(): StructuredPatchHunk {
  return structuredPatch('config.js', 'config.js', CONFIG_BEFORE, CONFIG_AFTER, '', '', { context: 3 }).hunks[0]!
}

// --- mounting -------------------------------------------------------------------

type Levers = { setAppState: ReturnType<typeof useSetAppState>; previewTheme: (theme: ThemeName) => void }

/** Hands the test the two ways the app changes a mounted diff: settings and theme. */
function LeverGrip({ onGrip }: { onGrip: (levers: Levers) => void }): null {
  const setAppState = useSetAppState()
  const { setPreviewTheme } = usePreviewTheme()
  onGrip({ setAppState, previewTheme: setPreviewTheme })
  return null
}

type Stage = { theme?: ThemeName; settings?: SettingsJson; columns: number }

type Mounted = {
  rows: () => Row[]
  transcript: () => string
  /** Renders a new diff element in place of the old one and waits for the repaint. */
  swap: (node: React.ReactNode) => Promise<void>
  setSettings: (settings: SettingsJson) => Promise<void>
  previewTheme: (theme: ThemeName) => Promise<void>
}

/** Waits until the terminal has taken new output and gone quiet. */
async function untilRepainted(terminal: FakeTerminal, lengthBefore: number, mustPaint: boolean): Promise<void> {
  const giveUp = Date.now() + 8_000
  let length = terminal.transcript().length
  let quietFrom = Date.now()
  while (Date.now() < giveUp) {
    await Bun.sleep(20)
    const now = terminal.transcript().length
    if (now !== length) {
      length = now
      quietFrom = Date.now()
    } else if ((now > lengthBefore || !mustPaint) && Date.now() - quietFrom >= 150) {
      return
    }
  }
  if (mustPaint) throw new Error(`Nothing new was painted. Output so far:\n${terminal.transcript().slice(-600)}`)
}

async function onTerminal(
  node: React.ReactNode,
  stage: Stage,
  inspect: (mounted: Mounted) => Promise<void> | void,
  mustPaint = true,
): Promise<void> {
  const terminal = createFakeTerminal({ columns: stage.columns })
  const root = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, patchConsole: false })
  const initialState = { ...getDefaultAppState(), settings: stage.settings ?? {} } as AppState
  let levers: Levers | undefined
  const draw = (diff: React.ReactNode) =>
    root.render(
      <AppStateProvider initialState={initialState}>
        <ThemeProvider initialState={stage.theme ?? 'dark'} onThemeSave={() => {}}>
          <LeverGrip onGrip={grip => (levers = grip)} />
          {diff}
        </ThemeProvider>
      </AppStateProvider>,
    )
  const change = async (act: () => void) => {
    const before = terminal.transcript().length
    act()
    await untilRepainted(terminal, before, true)
  }
  try {
    draw(node)
    await untilRepainted(terminal, 0, mustPaint)
    await inspect({
      rows: () => replay(lastPaintedFrame(terminal.transcript())),
      transcript: () => terminal.transcript(),
      swap: next => change(() => draw(next)),
      setSettings: settings =>
        change(() => levers!.setAppState(state => ({ ...state, settings: settings as AppState['settings'] }))),
      previewTheme: theme => change(() => levers!.previewTheme(theme)),
    })
  } finally {
    root.unmount()
    terminal.close()
  }
}

/** Mounts a diff, returns what it painted, and takes it down. */
async function paint(node: React.ReactNode, stage: Stage): Promise<Row[]> {
  let rows: Row[] = []
  await onTerminal(node, stage, mounted => {
    rows = mounted.rows()
  })
  return rows
}

/** The terminal is wider than the diff, so a row that overflowed would show. */
const roomFor = (width: number): number => Math.ceil(width) + 20

const WITHOUT_HIGHLIGHTING: SettingsJson = { syntaxHighlightingDisabled: true }

// --- the suite ------------------------------------------------------------------

describe('StructuredDiff: the syntax-highlighted path', () => {
  test(
    'paints, cell for cell, the rows the syntax renderer draws for the hunk, at 80, 40 and 24 columns',
    async () => {
      for (const width of [80, 40, 24]) {
        const hunk = configEdit()
        const drawing = { width, filePath: 'src/config.js', firstLine: CONFIG_BEFORE.split('\n')[0]!, fileContent: CONFIG_BEFORE }
        const rows = await paint(
          <StructuredDiff
            patch={hunk}
            dim={false}
            width={width}
            filePath={drawing.filePath}
            firstLine={drawing.firstLine}
            fileContent={drawing.fileContent}
          />,
          { columns: roomFor(width) },
        )
        expect(rows).toEqual(rendererRows(hunk, drawing))
      }
    },
    TIMEOUT,
  )

  test(
    'reads as a gutter (the line number, then the marker) followed by the code, and the changed word stands out',
    async () => {
      const rows = await paint(
        <StructuredDiff patch={configEdit()} dim={false} width={80} filePath="config.js" firstLine={null} />,
        { columns: 100 },
      )
      expect(textsOf(rows).map(line => line.trimEnd())).toEqual([
        " 1  import { readFile } from 'node:fs/promises'",
        ' 2',
        ' 3  export async function loadConfig(path) {',
        " 4 -  const raw = await readFile(path, 'utf8')",
        ' 5 -  return JSON.parse(raw)',
        " 4 +  const raw = await readFile(path, 'latin1')",
        ' 5 +  return { ...JSON.parse(raw), source: path }',
        ' 6  }',
      ])
      const removed = rows[3]!
      expect(backgroundsOf(cellsUnder(removed, 'utf8'))).not.toEqual(backgroundsOf(cellsUnder(removed, 'readFile(path')))
      const added = rows[5]!
      expect(backgroundsOf(cellsUnder(added, 'latin1'))).not.toEqual(backgroundsOf(cellsUnder(added, 'readFile(path')))
    },
    TIMEOUT,
  )

  test(
    'a removed line shows its number in the old file; added and context lines show theirs in the new one',
    async () => {
      // Two lines were added above this hunk, so the two sides are offset.
      const hunk: StructuredPatchHunk = {
        oldStart: 10,
        oldLines: 4,
        newStart: 12,
        newLines: 5,
        lines: [' ctx one', '-old line here', '-second old', '+new line here', '+second new', '+third new', ' ctx two'],
      }
      const rows = await paint(
        <StructuredDiff patch={hunk} dim={false} width={40} filePath="notes.txt" firstLine={null} />,
        { columns: 60 },
      )
      expect(rows).toEqual(rendererRows(hunk, { width: 40, filePath: 'notes.txt' }))
      expect(textsOf(rows).map(line => line.trimEnd())).toEqual([
        ' 12  ctx one',
        ' 11 -old line here',
        ' 12 -second old',
        ' 13 +new line here',
        ' 14 +second new',
        ' 15 +third new',
        ' 16  ctx two',
      ])
    },
    TIMEOUT,
  )

  test(
    'follows the theme in effect: dark, light and an ANSI-only theme each paint what the renderer draws for it',
    async () => {
      const pictures = new Set<string>()
      for (const theme of ['dark', 'light', 'dark-ansi'] as const) {
        const hunk = configEdit()
        const rows = await paint(
          <StructuredDiff patch={hunk} dim={false} width={60} filePath="config.js" firstLine={null} />,
          { columns: 80, theme },
        )
        const expected = rendererRows(hunk, { width: 60, filePath: 'config.js', theme })
        expect(rows).toEqual(expected)
        pictures.add(JSON.stringify(expected))
      }
      // Three different pictures, so each comparison above means something.
      expect(pictures.size).toBe(3)
    },
    TIMEOUT,
  )

  test(
    'dim reaches the renderer: every cell is dimmed and no word stands out',
    async () => {
      const hunk = configEdit()
      const rows = await paint(
        <StructuredDiff patch={hunk} dim width={60} filePath="config.js" firstLine={null} />,
        { columns: 80 },
      )
      expect(rows).toEqual(rendererRows(hunk, { width: 60, filePath: 'config.js', dim: true }))
      expect(rows.flat().every(cell => cell.dim)).toBe(true)
      for (const row of rows) expect(backgroundsOf(row).length).toBeLessThanOrEqual(1)
      expect(rows).not.toEqual(rendererRows(configEdit(), { width: 60, filePath: 'config.js' }))
    },
    TIMEOUT,
  )

  test(
    'the file path decides which language the code is coloured as',
    async () => {
      const pictures: Row[][] = []
      for (const filePath of ['geometry.py', 'geometry.txt']) {
        const hunk = hunkAt(4, [' import math', '-def area(r): return 3.14 * r * r', '+def area(r): return math.pi * r * r'])
        const rows = await paint(
          <StructuredDiff patch={hunk} dim={false} width={60} filePath={filePath} firstLine={null} />,
          { columns: 80 },
        )
        expect(rows).toEqual(rendererRows(hunk, { width: 60, filePath }))
        pictures.push(rows)
      }
      expect(pictures[0]).not.toEqual(pictures[1])
    },
    TIMEOUT,
  )

  test(
    'the first line of the file reaches the renderer, so a shebang sets the language of a file with no extension',
    async () => {
      const pictures: Row[][] = []
      for (const firstLine of ['#!/usr/bin/env python3', null]) {
        const hunk = hunkAt(2, [' import sys', '-print(sys.argv[1])', '+print(sys.argv[1:], file=sys.stderr)'])
        const rows = await paint(
          <StructuredDiff patch={hunk} dim={false} width={60} filePath="bin/deploy" firstLine={firstLine} />,
          { columns: 80 },
        )
        expect(rows).toEqual(rendererRows(hunk, { width: 60, filePath: 'bin/deploy', firstLine }))
        pictures.push(rows)
      }
      expect(pictures[0]).not.toEqual(pictures[1])
    },
    TIMEOUT,
  )

  test(
    'a fractional width is rounded down, and a width under one column counts as one',
    async () => {
      const cases: [given: number, used: number][] = [
        [40.9, 40],
        [0, 1],
        [-7, 1],
      ]
      for (const [given, used] of cases) {
        const hunk = configEdit()
        const rows = await paint(
          <StructuredDiff patch={hunk} dim={false} width={given} filePath="config.js" firstLine={null} />,
          { columns: 80 },
        )
        expect(rows).toEqual(rendererRows(hunk, { width: used, filePath: 'config.js' }))
      }
      // Rounding up instead would pad every changed row one column further.
      expect(rendererRows(configEdit(), { width: 40, filePath: 'config.js' })).not.toEqual(
        rendererRows(configEdit(), { width: 41, filePath: 'config.js' }),
      )
    },
    TIMEOUT,
  )

  test(
    'a line longer than the width wraps inside it: continuation rows repeat the marker and leave the number out',
    async () => {
      const long = 'const message = `a line long enough to need several rows at this width, and then some`'
      for (const width of [40, 30]) {
        const hunk = hunkAt(9, [' let unchanged = 0', `+${long}`])
        const rows = await paint(
          <StructuredDiff patch={hunk} dim={false} width={width} filePath="notes.js" firstLine={null} />,
          { columns: roomFor(width) },
        )
        expect(rows).toEqual(rendererRows(hunk, { width, filePath: 'notes.js' }))
        const texts = textsOf(rows)
        expect(texts[0]).toBe('  9  let unchanged = 0')
        expect(texts[1]!.startsWith(' 10 +')).toBe(true)
        expect(texts.length).toBeGreaterThan(3)
        for (const text of texts.slice(2)) expect(text.startsWith('    +')).toBe(true)
        for (const text of texts) expect(Bun.stringWidth(text)).toBeLessThanOrEqual(width)
        expect(
          texts
            .slice(1)
            .map(text => text.slice(5))
            .join('')
            .trimEnd(),
        ).toBe(long)
      }
    },
    TIMEOUT,
  )
})

describe('StructuredDiff: fullscreen', () => {
  test(
    'fullscreen leaves the picture as it is, at any width',
    async () => {
      process.env.CLAUDIN_NO_FLICKER = '1'
      for (const width of [60, 24, 12]) {
        const hunk = configEdit()
        const rows = await paint(
          <StructuredDiff patch={hunk} dim={false} width={width} filePath="config.js" firstLine={null} />,
          { columns: roomFor(width) },
        )
        expect(rows).toEqual(rendererRows(hunk, { width, filePath: 'config.js' }))
      }
    },
    TIMEOUT,
  )

  test(
    'with the width no wider than the line-number gutter, fullscreen still shows the code',
    async () => {
      process.env.CLAUDIN_NO_FLICKER = '1'
      // One-digit line numbers make a four-column gutter.
      for (const width of [5, 4, 3]) {
        const hunk = hunkAt(1, ['-abc', '+abd'])
        const rows = await paint(
          <StructuredDiff patch={hunk} dim={false} width={width} filePath="a.txt" firstLine={null} />,
          { columns: 20 },
        )
        expect(rows).toEqual(rendererRows(hunk, { width, filePath: 'a.txt' }))
        expect(textsOf(rows)).toEqual([' 1 -a', '   -b', '   -c', ' 1 +a', '   +b', '   +d'])
      }
    },
    TIMEOUT,
  )
})

// The hunk the path tests draw. The fallback and the renderer print the same
// characters for it, and colour them differently.
const CHOICE = [' keep = 1', '-value = 2', '+value = 3']
const CHOICE_ROWS = [' 3  keep = 1', ' 4 -value = 2', ' 4 +value = 3']

function expectHighlighted(rows: Row[], hunk: StructuredPatchHunk, width: number, theme: ThemeName = 'dark'): void {
  expect(rows).toEqual(rendererRows(hunk, { width, filePath: 'choice.py', theme }))
}

function expectFallback(rows: Row[], theme: ThemeName = 'dark'): void {
  const colours = fallbackColours(theme)
  expect(textsOf(rows).map(text => text.trimEnd())).toEqual(CHOICE_ROWS)
  expect(backgroundsOf(cellsUnder(rows[1]!, 'value = '))).toEqual([colours.removed])
  expect(backgroundsOf(cellsUnder(rows[2]!, 'value = '))).toEqual([colours.added])
}

const choiceDiff = (hunk: StructuredPatchHunk, extra: { skipHighlighting?: boolean } = {}) => (
  <StructuredDiff patch={hunk} dim={false} width={40} filePath="choice.py" firstLine={null} {...extra} />
)

describe('StructuredDiff: when the plain fallback is drawn instead', () => {
  test(
    'by default the syntax renderer draws the diff',
    async () => {
      const hunk = hunkAt(3, CHOICE)
      expectHighlighted(await paint(choiceDiff(hunk), { columns: 60 }), hunk, 40)
    },
    TIMEOUT,
  )

  test(
    'skipHighlighting draws the fallback',
    async () => {
      expectFallback(await paint(choiceDiff(hunkAt(3, CHOICE), { skipHighlighting: true }), { columns: 60 }))
    },
    TIMEOUT,
  )

  test(
    'the syntaxHighlightingDisabled setting draws the fallback',
    async () => {
      expectFallback(await paint(choiceDiff(hunkAt(3, CHOICE)), { columns: 60, settings: WITHOUT_HIGHLIGHTING }))
    },
    TIMEOUT,
  )

  test(
    'CLAUDIN_SYNTAX_HIGHLIGHT set to 0, false, no or off draws the fallback; any other value keeps the highlighting',
    async () => {
      for (const value of ['0', 'false', 'No', ' OFF ']) {
        process.env.CLAUDIN_SYNTAX_HIGHLIGHT = value
        expectFallback(await paint(choiceDiff(hunkAt(3, CHOICE)), { columns: 60 }))
      }
      for (const value of ['1', 'true', 'Monokai Extended', '']) {
        process.env.CLAUDIN_SYNTAX_HIGHLIGHT = value
        const hunk = hunkAt(3, CHOICE)
        expectHighlighted(await paint(choiceDiff(hunk), { columns: 60 }), hunk, 40)
      }
    },
    TIMEOUT,
  )

  test(
    'switching the setting while the diff is on screen repaints it the other way, and back',
    async () => {
      const hunk = hunkAt(3, CHOICE)
      await onTerminal(choiceDiff(hunk), { columns: 60 }, async screen => {
        expectHighlighted(screen.rows(), hunk, 40)
        await screen.setSettings({ syntaxHighlightingDisabled: true })
        expectFallback(screen.rows())
        await screen.setSettings({ syntaxHighlightingDisabled: false })
        expectHighlighted(screen.rows(), hunk, 40)
      })
    },
    TIMEOUT,
  )

  test(
    'a theme change while the diff is on screen repaints it in the new theme, on either path',
    async () => {
      const hunk = hunkAt(3, CHOICE)
      await onTerminal(choiceDiff(hunk), { columns: 60 }, async screen => {
        await screen.previewTheme('light')
        expectHighlighted(screen.rows(), hunk, 40, 'light')
      })
      await onTerminal(choiceDiff(hunkAt(3, CHOICE)), { columns: 60, settings: WITHOUT_HIGHLIGHTING }, async screen => {
        expectFallback(screen.rows(), 'dark')
        await screen.previewTheme('light')
        expectFallback(screen.rows(), 'light')
      })
      expect(fallbackColours('light').removed).not.toBe(fallbackColours('dark').removed)
    },
    TIMEOUT,
  )

  test(
    'new props on a diff that is on screen repaint it: dim, width, file path and the hunk itself',
    async () => {
      const first = configEdit()
      const second = hunkAt(3, CHOICE)
      const at = (patch: StructuredPatchHunk, dim: boolean, width: number, filePath: string) => (
        <StructuredDiff patch={patch} dim={dim} width={width} filePath={filePath} firstLine={null} />
      )
      await onTerminal(at(first, false, 60, 'config.js'), { columns: 80 }, async screen => {
        expect(screen.rows()).toEqual(rendererRows(first, { width: 60, filePath: 'config.js' }))
        await screen.swap(at(first, true, 60, 'config.js'))
        expect(screen.rows()).toEqual(rendererRows(first, { width: 60, filePath: 'config.js', dim: true }))
        await screen.swap(at(first, true, 44, 'config.js'))
        expect(screen.rows()).toEqual(rendererRows(first, { width: 44, filePath: 'config.js', dim: true }))
        await screen.swap(at(first, false, 44, 'config.txt'))
        expect(screen.rows()).toEqual(rendererRows(first, { width: 44, filePath: 'config.txt' }))
        await screen.swap(at(second, false, 44, 'config.txt'))
        expect(screen.rows()).toEqual(rendererRows(second, { width: 44, filePath: 'config.txt' }))
      })
    },
    TIMEOUT,
  )

  test(
    'one hunk object drawn again and again with other parameters never shows a stale picture',
    async () => {
      const hunk = hunkAt(1, [' import os', '-print(os.getcwd())', '+print(os.getcwd(), flush=True)'])
      const variants: Drawing[] = [
        { width: 50, filePath: 'tool.py' },
        { width: 50, filePath: 'tool.py', dim: true },
        { width: 36, filePath: 'tool.py' },
        { width: 50, filePath: 'tool.py', theme: 'light' },
        { width: 50, filePath: 'tool', firstLine: '#!/usr/bin/env python3' },
        { width: 50, filePath: 'tool' },
        { width: 50, filePath: 'tool.py' },
      ]
      for (const variant of variants) {
        const rows = await paint(
          <StructuredDiff
            patch={hunk}
            dim={variant.dim ?? false}
            width={variant.width}
            filePath={variant.filePath}
            firstLine={variant.firstLine ?? null}
          />,
          { columns: 70, theme: variant.theme },
        )
        expect(rows).toEqual(rendererRows(hunk, variant))
      }
      // Each variant draws differently from the one before it, so a stale picture would show.
      for (let at = 1; at < variants.length; at++) {
        expect(rendererRows(hunk, variants[at]!)).not.toEqual(rendererRows(hunk, variants[at - 1]!))
      }
    },
    TIMEOUT,
  )
})

/** OSC sequences, which end in a bell: hyperlinks the renderer writes itself. */
const OSC_SEQUENCE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g

describe('StructuredDiff: control sequences inside the code', () => {
  test(
    'never reach the terminal as a clipboard write, a cursor move, a clear, a bell or a backspace, on either path',
    async () => {
      // Each line hides one control sequence between two visible words.
      const planted: [before: string, sequence: string, after: string][] = [
        ['copied', '\u001B]52;c;SGVsbG8=\u0007', 'clipboard'],
        ['wiped', '\u001B[2J\u001B[H', 'screen'],
        ['moved', '\u001B[37A', 'cursor'],
        ['rang', '\u0007', 'bell'],
        ['typed', '\b\b\b\b\b', 'over'],
      ]
      const lines = [' keep', ...planted.map(([before, sequence, after]) => `+${before}${sequence}${after}`)]
      for (const settings of [{}, WITHOUT_HIGHLIGHTING]) {
        await onTerminal(
          <StructuredDiff patch={hunkAt(1, lines)} dim={false} width={60} filePath="notes.sh" firstLine={null} />,
          { columns: 80, settings },
          screen => {
            const written = screen.transcript()
            expect(written).not.toContain(']52;')
            expect(written).not.toContain('\u001B[2J')
            expect(written).not.toContain('\u001B[37A')
            expect(written.replace(OSC_SEQUENCE, '')).not.toContain('\u0007')
            expect(written).not.toContain('\b')
            // The words on both sides of each sequence are still shown, in order.
            const texts = textsOf(screen.rows())
            for (const [before, , after] of planted) {
              const row = texts.find(text => text.includes(before))
              expect(row).toBeDefined()
              expect(row!.indexOf(after)).toBeGreaterThan(row!.indexOf(before))
            }
          },
        )
      }
    },
    TIMEOUT,
  )
})

// --- the fallback ----------------------------------------------------------------

/** Draws a hunk the way a user with syntax highlighting turned off sees it. */
async function paintPlain(hunk: StructuredPatchHunk, width: number, options: { dim?: boolean; theme?: ThemeName } = {}) {
  return paint(
    <StructuredDiff patch={hunk} dim={options.dim ?? false} width={width} filePath="plain.ts" firstLine={null} />,
    { columns: roomFor(width), settings: WITHOUT_HIGHLIGHTING, theme: options.theme },
  )
}

type LogicalLine = { number: string; marker: string; fragments: string[] }

/** Groups rows into the lines they draw: a numbered row, and the rows that continue it. */
function logicalLines(rows: Row[], gutter: number): LogicalLine[] {
  const lines: LogicalLine[] = []
  for (const text of textsOf(rows)) {
    const number = text.slice(0, gutter - 2).trim()
    const marker = text.charAt(gutter - 1)
    const code = text.slice(gutter)
    if (number !== '') lines.push({ number, marker, fragments: [code] })
    else {
      const line = lines.at(-1)!
      expect(marker).toBe(line.marker)
      line.fragments.push(code)
    }
  }
  return lines
}

const oneSpaced = (text: string): string => text.replace(/\s+/g, ' ').trim()
const unspaced = (text: string): string => text.replace(/\s+/g, '')

describe('the fallback: rows and numbers', () => {
  const RUN = [' alpha', '-bravo one', '-charlie two', '+bravo uno', '+charlie dos', '+delta tres', ' echo']

  test(
    'one row per line: the number right-aligned, a space, the marker, then the code, at 80 and 40 columns',
    async () => {
      for (const width of [80, 40]) {
        const rows = await paintPlain(hunkAt(7, RUN), width)
        expect(textsOf(rows).map(text => text.trimEnd())).toEqual([
          '  7  alpha',
          '  8 -bravo one',
          '  9 -charlie two',
          '  8 +bravo uno',
          '  9 +charlie dos',
          ' 10 +delta tres',
          ' 11  echo',
        ])
      }
    },
    TIMEOUT,
  )

  test(
    'the number column is as wide as the largest number, plus one',
    async () => {
      const rows = await paintPlain(
        hunkAt(98, [' ninety-eight', '-ninety-nine', '+ninety-nine again', ' one hundred', ' one hundred one']),
        60,
      )
      expect(textsOf(rows).map(text => text.trimEnd())).toEqual([
        '  98  ninety-eight',
        '  99 -ninety-nine',
        '  99 +ninety-nine again',
        ' 100  one hundred',
        ' 101  one hundred one',
      ])
    },
    TIMEOUT,
  )

  test(
    "added and removed rows are filled with the theme's diff colour across the whole width; context rows are not coloured",
    async () => {
      for (const theme of ['dark', 'light'] as const) {
        const colours = fallbackColours(theme)
        const rows = await paintPlain(hunkAt(1, [' same', '-the first wording', '+nothing alike here']), 36, { theme })
        expect(textsOf(rows).map(text => text.trimEnd())).toEqual([' 1  same', ' 2 -the first wording', ' 2 +nothing alike here'])
        expect(backgroundsOf(rows[0]!)).toEqual([''])
        expect(rows[1]!.length).toBe(36)
        expect(backgroundsOf(rows[1]!)).toEqual([colours.removed])
        expect(rows[2]!.length).toBe(36)
        expect(backgroundsOf(rows[2]!)).toEqual([colours.added])
      }
    },
    TIMEOUT,
  )

  test(
    "the code on added and removed rows is drawn in the theme's text colour",
    async () => {
      const colours = fallbackColours('dark')
      // A whole-row change, then a one-word change.
      const rows = await paintPlain(hunkAt(1, ['-the first wording', '+nothing alike here', ' ---', '-size = 1', '+size = 2']), 40)
      for (const [row, code] of [
        [rows[0]!, 'the first wording'],
        [rows[1]!, 'nothing alike here'],
        [rows[3]!, 'size = 1'],
        [rows[4]!, 'size = 2'],
      ] as const) {
        expect([...new Set(cellsUnder(row, code).map(cell => cell.fg))]).toEqual([colours.text])
      }
    },
    TIMEOUT,
  )
})

describe('the fallback: words that changed', () => {
  test(
    'a removed line right before an added one: only the words that changed stand out',
    async () => {
      for (const theme of ['dark', 'light'] as const) {
        const colours = fallbackColours(theme)
        const rows = await paintPlain(
          hunkAt(1, ['-const value = computeThing(alpha);', '+const value = computeThing(beta);']),
          50,
          { theme },
        )
        const [removed, added] = rows
        expect(textsOf(rows).map(text => text.trimEnd())).toEqual([
          ' 1 -const value = computeThing(alpha);',
          ' 1 +const value = computeThing(beta);',
        ])
        expect(backgroundsOf(cellsUnder(removed!, 'alpha'))).toEqual([colours.removedWord])
        expect(backgroundsOf(cellsUnder(removed!, ' 1 -const value = computeThing('))).toEqual([colours.removed])
        expect(backgroundsOf(cellsUnder(removed!, ');'))).toEqual([colours.removed])
        expect(backgroundsOf(cellsUnder(added!, 'beta'))).toEqual([colours.addedWord])
        expect(backgroundsOf(cellsUnder(added!, ' 1 +const value = computeThing('))).toEqual([colours.added])
        expect(backgroundsOf(cellsUnder(added!, ');'))).toEqual([colours.added])
        // The row is still filled to the width.
        expect(removed!.length).toBe(50)
        expect(backgroundsOf(removed!.slice(-3))).toEqual([colours.removed])
      }
    },
    TIMEOUT,
  )

  test(
    'whitespace is compared too: a double space that became single stands out on both rows',
    async () => {
      const colours = fallbackColours('dark')
      const [removed, added] = await paintPlain(hunkAt(1, ['-let total = a  + b', '+let total = a + b']), 40)
      expect(textOf(removed!).trimEnd()).toBe(' 1 -let total = a  + b')
      expect(textOf(added!).trimEnd()).toBe(' 1 +let total = a + b')
      expect(backgroundsOf(cellsUnder(removed!, 'a  +').slice(1, 3))).toEqual([colours.removedWord])
      expect(backgroundsOf(cellsUnder(removed!, 'let total = a'))).toEqual([colours.removed])
      expect(backgroundsOf(cellsUnder(added!, 'a + b').slice(1, 2))).toEqual([colours.addedWord])
      expect(backgroundsOf(cellsUnder(added!, 'let total = a'))).toEqual([colours.added])
    },
    TIMEOUT,
  )

  test(
    'a change of case is a change',
    async () => {
      const colours = fallbackColours('dark')
      const [removed, added] = await paintPlain(hunkAt(1, ['-let Total = 1', '+let total = 1']), 40)
      expect(backgroundsOf(cellsUnder(removed!, 'Total'))).toEqual([colours.removedWord])
      expect(backgroundsOf(cellsUnder(added!, 'total'))).toEqual([colours.addedWord])
      expect(backgroundsOf(cellsUnder(added!, ' = 1'))).toEqual([colours.added])
    },
    TIMEOUT,
  )

  test(
    'lines pair up in order, the first removed with the first added; a line left without a partner is drawn whole',
    async () => {
      const colours = fallbackColours('dark')
      const rows = await paintPlain(
        hunkAt(1, ['-alpha = one', '-bravo = two', '-charlie = three', '+alpha = uno', '+bravo = dos']),
        40,
      )
      expect(textsOf(rows).map(text => text.trimEnd())).toEqual([
        ' 1 -alpha = one',
        ' 2 -bravo = two',
        ' 3 -charlie = three',
        ' 1 +alpha = uno',
        ' 2 +bravo = dos',
      ])
      expect(backgroundsOf(cellsUnder(rows[0]!, 'one'))).toEqual([colours.removedWord])
      expect(backgroundsOf(cellsUnder(rows[1]!, 'two'))).toEqual([colours.removedWord])
      expect(backgroundsOf(rows[2]!)).toEqual([colours.removed])
      expect(backgroundsOf(cellsUnder(rows[3]!, 'uno'))).toEqual([colours.addedWord])
      expect(backgroundsOf(cellsUnder(rows[4]!, 'dos'))).toEqual([colours.addedWord])
      expect(backgroundsOf(cellsUnder(rows[4]!, 'bravo = '))).toEqual([colours.added])
    },
    TIMEOUT,
  )

  test(
    'a removed line and an added line with a context line between them are not paired',
    async () => {
      const colours = fallbackColours('dark')
      const rows = await paintPlain(hunkAt(1, ['-count = 1', ' keep', '+count = 2']), 30)
      expect(textsOf(rows).map(text => text.trimEnd())).toEqual([' 1 -count = 1', ' 1  keep', ' 2 +count = 2'])
      expect(backgroundsOf(rows[0]!)).toEqual([colours.removed])
      expect(backgroundsOf(rows[2]!)).toEqual([colours.added])
    },
    TIMEOUT,
  )

  test(
    'changes up to 40% of the two lines are shown word by word; above that both rows are drawn whole',
    async () => {
      const colours = fallbackColours('dark')
      // 12 changed characters out of 30: exactly 40%.
      const atLimit = await paintPlain(hunkAt(1, ['-let ab = oldval', '+let ab = newval']), 30)
      expect(backgroundsOf(cellsUnder(atLimit[0]!, 'oldval'))).toEqual([colours.removedWord])
      expect(backgroundsOf(cellsUnder(atLimit[1]!, 'newval'))).toEqual([colours.addedWord])
      // 12 out of 28: just over.
      const over = await paintPlain(hunkAt(1, ['-let a = oldval', '+let a = newval']), 30)
      expect(textsOf(over).map(text => text.trimEnd())).toEqual([' 1 -let a = oldval', ' 1 +let a = newval'])
      expect(backgroundsOf(over[0]!)).toEqual([colours.removed])
      expect(backgroundsOf(over[1]!)).toEqual([colours.added])
    },
    TIMEOUT,
  )

  test(
    'a dimmed diff highlights no words, uses the dimmed diff colours and dims the code',
    async () => {
      for (const theme of ['dark', 'light'] as const) {
        const colours = fallbackColours(theme)
        const rows = await paintPlain(
          hunkAt(1, [' keep', '-const value = computeThing(alpha);', '+const value = computeThing(beta);']),
          50,
          { dim: true, theme },
        )
        expect(textsOf(rows).map(text => text.trimEnd())).toEqual([
          ' 1  keep',
          ' 2 -const value = computeThing(alpha);',
          ' 2 +const value = computeThing(beta);',
        ])
        expect(backgroundsOf(rows[0]!)).toEqual([''])
        expect(backgroundsOf(rows[1]!)).toEqual([colours.removedDimmed])
        expect(backgroundsOf(rows[2]!)).toEqual([colours.addedDimmed])
        for (const row of rows) {
          for (const cell of row.filter(cell => cell.ch !== ' ')) {
            expect(cell.dim || cell.fg !== colours.text).toBe(true)
          }
        }
      }
    },
    TIMEOUT,
  )
})

describe('the fallback: long lines', () => {
  const CONTEXT = 'the context line here is long enough to wrap more than once at the narrow widths'
  const ADDED = 'and the added line carries on for quite a while longer than the width it gets'

  test(
    'a long line wraps at word boundaries inside the width, in order, at 40, 28 and 20 columns',
    async () => {
      // Line numbers 9 and 10: a five-column gutter.
      const gutter = 5
      for (const width of [40, 28, 20]) {
        const rows = await paintPlain(hunkAt(9, [` ${CONTEXT}`, `+${ADDED}`]), width)
        for (const text of textsOf(rows)) expect(Bun.stringWidth(text)).toBeLessThanOrEqual(width)
        const lines = logicalLines(rows, gutter)
        expect(lines.map(line => [line.number, line.marker])).toEqual([
          ['9', ' '],
          ['10', '+'],
        ])
        for (const [line, original] of [
          [lines[0]!, CONTEXT],
          [lines[1]!, ADDED],
        ] as const) {
          expect(line.fragments.length).toBeGreaterThan(1)
          // Joined back with single spaces, the rows give the line: nothing lost,
          // nothing reordered, and no word cut in two.
          expect(oneSpaced(line.fragments.join(' '))).toBe(oneSpaced(original))
          // A row ends only where the next word would not have fitted.
          for (let at = 1; at < line.fragments.length; at++) {
            const kept = line.fragments[at - 1]!.trimEnd()
            const nextWord = line.fragments[at]!.trim().split(' ')[0]!
            expect(Bun.stringWidth(kept) + 1 + Bun.stringWidth(nextWord)).toBeGreaterThan(width - gutter - 1)
          }
        }
      }
    },
    TIMEOUT,
  )

  test(
    'a long pair with a small change wraps as well, and the changed word keeps its highlight',
    async () => {
      const colours = fallbackColours('dark')
      const before = 'the quick brown fox jumps over the lazy dog near the quiet river bank'
      const after = 'the quick brown fox leaps over the lazy dog near the quiet river bank'
      for (const width of [40, 28]) {
        const rows = await paintPlain(hunkAt(1, [`-${before}`, `+${after}`]), width)
        for (const text of textsOf(rows)) expect(Bun.stringWidth(text)).toBeLessThanOrEqual(width)
        const [removed, added] = logicalLines(rows, 4)
        expect([removed!.number, removed!.marker, added!.number, added!.marker]).toEqual(['1', '-', '1', '+'])
        expect(removed!.fragments.length).toBeGreaterThan(1)
        expect(unspaced(removed!.fragments.join(''))).toBe(unspaced(before))
        expect(unspaced(added!.fragments.join(''))).toBe(unspaced(after))
        for (const word of before.split(' ')) expect(removed!.fragments.some(fragment => fragment.includes(word))).toBe(true)
        const jumps = rows.find(row => textOf(row).includes('jumps'))!
        expect(backgroundsOf(cellsUnder(jumps, 'jumps'))).toEqual([colours.removedWord])
        const leaps = rows.find(row => textOf(row).includes('leaps'))!
        expect(backgroundsOf(cellsUnder(leaps, 'leaps'))).toEqual([colours.addedWord])
        const riverRow = rows.findLast(row => textOf(row).includes('bank'))!
        expect(backgroundsOf(cellsUnder(riverRow, 'bank'))).toEqual([colours.added])
      }
    },
    TIMEOUT,
  )

  test(
    'wide characters count for the columns they take',
    async () => {
      const wide = '日本語のテキストを折り返して表示します'
      for (const width of [20, 14]) {
        const rows = await paintPlain(hunkAt(1, [` ${wide}`, `+${wide}です`]), width)
        for (const text of textsOf(rows)) expect(Bun.stringWidth(text)).toBeLessThanOrEqual(width)
        const [context, added] = logicalLines(rows, 4)
        expect(context!.fragments.length).toBeGreaterThan(1)
        expect(unspaced(context!.fragments.join(''))).toBe(wide)
        expect(unspaced(added!.fragments.join(''))).toBe(`${wide}です`)
      }
    },
    TIMEOUT,
  )

  test(
    'a width under one column counts as one, and a fractional width is rounded down',
    async () => {
      const narrowest = textsOf(await paintPlain(hunkAt(1, ['-abc', '+abd']), 1))
      expect(narrowest).toEqual([' 1 -a', '   -b', '   -c', ' 1 +a', '   +b', '   +d'])
      for (const width of [0, -5]) {
        expect(textsOf(await paintPlain(hunkAt(1, ['-abc', '+abd']), width))).toEqual(narrowest)
      }
      const floored = await paintPlain(hunkAt(1, [` ${CONTEXT}`, `-${ADDED}`]), 30)
      expect(await paintPlain(hunkAt(1, [` ${CONTEXT}`, `-${ADDED}`]), 30.8)).toEqual(floored)
    },
    TIMEOUT,
  )
})

// --- the list ---------------------------------------------------------------------

const THIRTY_LINES = `${Array.from({ length: 30 }, (_, at) => `line ${at + 1}`).join('\n')}\n`

/** The hunks of an edit to a 30-line file, one per changed spot. */
function editsAt(...spots: number[]): StructuredPatchHunk[] {
  let after = THIRTY_LINES
  for (const spot of spots) after = after.replace(`line ${spot}\n`, `line number ${spot}, edited\n`)
  return structuredPatch('notes.txt', 'notes.txt', THIRTY_LINES, after, '', '', { context: 3 }).hunks
}

/** Splits a painted list at its separator rows. */
function splitAtSeparators(rows: Row[]): Row[][] {
  const parts: Row[][] = [[]]
  for (const row of rows) {
    if (textOf(row) === '...') parts.push([])
    else parts.at(-1)!.push(row)
  }
  return parts
}

describe('StructuredDiffList', () => {
  test(
    'draws the hunks in order with a "..." row between two of them, at the left edge',
    async () => {
      const hunks = editsAt(3, 25)
      expect(hunks.length).toBe(2)
      const rows = await paint(
        <StructuredDiffList hunks={hunks} dim={false} width={40} filePath="notes.txt" firstLine={null} />,
        { columns: 60 },
      )
      const first = rendererRows(hunks[0]!, { width: 40, filePath: 'notes.txt' })
      const second = rendererRows(hunks[1]!, { width: 40, filePath: 'notes.txt' })
      expect(rows).toEqual([...first, rows[first.length]!, ...second])
      expect(textOf(rows[first.length]!)).toBe('...')
      // Each hunk sizes its own number column.
      expect(textOf(rows[0]!)).toBe(' 1  line 1')
      expect(textOf(rows[first.length + 1]!)).toBe(' 22  line 22')
    },
    TIMEOUT,
  )

  test(
    'three hunks get two separators and one hunk gets none',
    async () => {
      const three = editsAt(2, 15, 28)
      expect(three.length).toBe(3)
      const rows = await paint(
        <StructuredDiffList hunks={three} dim={false} width={40} filePath="notes.txt" firstLine={null} />,
        { columns: 60 },
      )
      expect(splitAtSeparators(rows)).toEqual(three.map(hunk => rendererRows(hunk, { width: 40, filePath: 'notes.txt' })))
      const one = editsAt(15)
      const alone = await paint(
        <StructuredDiffList hunks={one} dim={false} width={40} filePath="notes.txt" firstLine={null} />,
        { columns: 60 },
      )
      expect(alone).toEqual(rendererRows(one[0]!, { width: 40, filePath: 'notes.txt' }))
    },
    TIMEOUT,
  )

  test(
    'no hunks paint nothing at all',
    async () => {
      await onTerminal(
        <StructuredDiffList hunks={[]} dim={false} width={40} filePath="notes.txt" firstLine={null} />,
        { columns: 60 },
        screen => {
          expect(screen.transcript()).toBe('')
        },
        false,
      )
    },
    TIMEOUT,
  )

  test(
    'dim, width, file path and first line reach every hunk',
    async () => {
      const shebang = '#!/usr/bin/env python3'
      const before = `${shebang}\n${Array.from({ length: 20 }, (_, at) => `value_${at} = ${at}`).join('\n')}\n`
      const after = before.replace('value_2 = 2', 'value_2 = 2.5').replace('value_17 = 17', 'value_17 = "seventeen"')
      const hunks = structuredPatch('deploy', 'deploy', before, after, '', '', { context: 2 }).hunks
      expect(hunks.length).toBe(2)
      for (const dim of [false, true]) {
        const rows = await paint(
          <StructuredDiffList hunks={hunks} dim={dim} width={36} filePath="deploy" firstLine={shebang} />,
          { columns: 60 },
        )
        expect(splitAtSeparators(rows)).toEqual(
          hunks.map(hunk => rendererRows(hunk, { width: 36, filePath: 'deploy', firstLine: shebang, dim })),
        )
      }
      // Without the first line the file has no language, and it shows.
      expect(rendererRows(hunks[1]!, { width: 36, filePath: 'deploy', firstLine: shebang })).not.toEqual(
        rendererRows(hunks[1]!, { width: 36, filePath: 'deploy' }),
      )
    },
    TIMEOUT,
  )

  test(
    'with highlighting turned off, every hunk is drawn by the fallback',
    async () => {
      const colours = fallbackColours('dark')
      const hunks = editsAt(3, 25)
      const rows = await paint(
        <StructuredDiffList hunks={hunks} dim={false} width={40} filePath="notes.txt" firstLine={null} />,
        { columns: 60, settings: WITHOUT_HIGHLIGHTING },
      )
      const parts = splitAtSeparators(rows)
      expect(parts.length).toBe(2)
      for (const part of parts) {
        const removed = part.find(row => textOf(row).includes(' -line'))!
        const added = part.find(row => textOf(row).includes(' +line'))!
        expect(backgroundsOf(cellsUnder(removed, '-line'))).toEqual([colours.removed])
        expect(backgroundsOf(cellsUnder(added, '+line'))).toEqual([colours.added])
      }
    },
    TIMEOUT,
  )
})

