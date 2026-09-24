import { describe, expect, test } from 'bun:test'
import { join } from 'path'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import { Text } from 'src/terminal/ink.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { outputSchema, type Output } from 'src/tools/FileReadTool/schemas.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  userFacingName,
} from 'src/tools/FileReadTool/UI.js'

// The renderers had no test at all before the batch Read. The first describe
// pins what they printed on the day it landed, so a batch arm that bleeds into
// the single-file arms shows up here.

// MessageResponse's `⎿` gutter pads with a non-breaking space.
const NBSP_RE = /\u00a0/g

function render(node: React.ReactNode): Promise<string> {
  return renderToString(node, 100).then(out =>
    stripAnsi(out).replace(NBSP_RE, ' ').trim(),
  )
}

/** AssistantToolUseMessage prints the tool-use node inside `<Text>(…)</Text>`;
 *  a bare fragment with a string child only renders the way it ships there. */
function renderUseLine(node: React.ReactNode): Promise<string> {
  return render(<Text>{node}</Text>)
}

const IN_CWD = join(process.cwd(), 'src', 'example.ts')

describe('Read UI — single-file renderers (pinned before the batch Read)', () => {
  test('the tool-use line is the display path, plus pages or a verbose range', async () => {
    expect(
      await renderUseLine(renderToolUseMessage({ file_path: IN_CWD }, { verbose: false })),
    ).toBe('src/example.ts')
    expect(
      await renderUseLine(
        renderToolUseMessage({ file_path: IN_CWD, pages: '1-3' }, { verbose: false }),
      ),
    ).toBe('src/example.ts · pages 1-3')
    expect(
      await renderUseLine(
        renderToolUseMessage({ file_path: IN_CWD, offset: 10, limit: 10 }, { verbose: true }),
      ),
    ).toBe(`${IN_CWD} · lines 10-19`)
    expect(
      await renderUseLine(
        renderToolUseMessage({ file_path: IN_CWD, offset: 10 }, { verbose: true }),
      ),
    ).toBe(`${IN_CWD} · from line 10`)
  })

  test('the tool-use line is empty without a file_path', () => {
    expect(renderToolUseMessage({}, { verbose: false })).toBeNull()
  })

  test('summary and name come from the path', () => {
    expect(getToolUseSummary({ file_path: IN_CWD })).toBe('src/example.ts')
    expect(getToolUseSummary({})).toBeNull()
    expect(getToolUseSummary(undefined)).toBeNull()
    expect(userFacingName({ file_path: IN_CWD })).toBe('Read')
    expect(userFacingName(undefined)).toBe('Read')
  })

  const results: [string, Output, string][] = [
    [
      'text, several lines',
      {
        type: 'text',
        file: { filePath: IN_CWD, content: 'a\nb', numLines: 12, startLine: 1, totalLines: 12 },
      },
      '⎿  Read 12 lines',
    ],
    [
      'text, one line',
      {
        type: 'text',
        file: { filePath: IN_CWD, content: 'a', numLines: 1, startLine: 1, totalLines: 1 },
      },
      '⎿  Read 1 line',
    ],
    ['file_unchanged', { type: 'file_unchanged', file: { filePath: IN_CWD } }, '⎿  Unchanged since last read'],
    [
      'outline',
      {
        type: 'outline',
        file: { filePath: IN_CWD, content: 'x', totalLines: 300, symbolCount: 3 },
      },
      '⎿  Read outline (3 symbols)',
    ],
    [
      'outline, one symbol',
      {
        type: 'outline',
        file: { filePath: IN_CWD, content: 'x', totalLines: 300, symbolCount: 1 },
      },
      '⎿  Read outline (1 symbol)',
    ],
    [
      'preview',
      {
        type: 'outline',
        file: { filePath: IN_CWD, content: 'x', totalLines: 120, symbolCount: 0, preview: true },
      },
      '⎿  Read preview (120 lines)',
    ],
    [
      'notebook',
      { type: 'notebook', file: { filePath: IN_CWD, cells: [{}, {}] } },
      '⎿  Read 2 cells',
    ],
    [
      'empty notebook',
      { type: 'notebook', file: { filePath: IN_CWD, cells: [] } },
      'No cells found in notebook',
    ],
    [
      'pdf',
      { type: 'pdf', file: { filePath: IN_CWD, base64: '', originalSize: 2048 } },
      '⎿  Read PDF (2KB)',
    ],
    [
      'pdf pages',
      {
        type: 'parts',
        file: { filePath: IN_CWD, originalSize: 2048, count: 3, outputDir: '/tmp/x' },
      },
      '⎿  Read 3 pages (2KB)',
    ],
    [
      'image',
      { type: 'image', file: { base64: '', type: 'image/png', originalSize: 2048 } },
      '⎿  Read image (2KB)',
    ],
    [
      'clip-pin fallback (no arm of its own)',
      {
        type: 'clip_pin_fallback',
        file: { filePath: IN_CWD, message: 'x', servedOutline: true },
      },
      '',
    ],
  ]

  for (const [name, output, expected] of results) {
    test(`result line — ${name}`, async () => {
      expect(await render(renderToolResultMessage(output))).toBe(expected)
    })
  }
})

describe('Read UI — the batch Read', () => {
  const inCwd = (name: string) => join(process.cwd(), 'src', name)

  test('the tool-use line counts the files and names the first few', async () => {
    const three = [inCwd('a.ts'), inCwd('b.ts'), inCwd('c.ts')]
    expect(
      await renderUseLine(renderToolUseMessage({ file_paths: three }, { verbose: false })),
    ).toBe('3 files: src/a.ts, src/b.ts, src/c.ts')
    const five = [...three, inCwd('d.ts'), inCwd('e.ts')]
    expect(
      await renderUseLine(renderToolUseMessage({ file_paths: five }, { verbose: false })),
    ).toBe('5 files: src/a.ts, src/b.ts, src/c.ts, +2 more')
    expect(getToolUseSummary({ file_paths: five })).toBe(
      '5 files: src/a.ts, src/b.ts, src/c.ts, +2 more',
    )
    expect(userFacingName({ file_paths: five })).toBe('Read')
  })

  test('several symbols of one file keep the single-file line', async () => {
    expect(
      await renderUseLine(
        renderToolUseMessage({ file_path: IN_CWD, symbol: ['a', 'b'] }, { verbose: false }),
      ),
    ).toBe('src/example.ts')
  })

  const batch = (files: { filePath: string; lines: number }[], notShown: string[] = []): Output => ({
    type: 'batch',
    files,
    notShown,
    content: 'irrelevant to the renderer',
  })

  test('the result line counts files and the numbered lines they showed', async () => {
    const two = [
      { filePath: inCwd('a.ts'), lines: 400 },
      { filePath: inCwd('b.ts'), lines: 12 },
    ]
    expect(await render(renderToolResultMessage(batch(two)))).toBe('⎿  Read 2 files (412 lines)')
    expect(await render(renderToolResultMessage(batch(two, ['c.ts', 'd.ts'])))).toBe(
      '⎿  Read 2 of 4 files (412 lines)',
    )
    // Outlines and stubs show no numbered lines; the count is then left out.
    expect(
      await render(renderToolResultMessage(batch([{ filePath: inCwd('a.ts'), lines: 0 }]))),
    ).toBe('⎿  Read 1 file')
  })

  test('outputSchema keeps every field the batch renderer reads', () => {
    // UserToolSuccessMessage hands the renderer the PARSED result, and a
    // z.object strips what it does not declare (typescript-patterns.md).
    const full = batch([{ filePath: inCwd('a.ts'), lines: 3 }], ['b.ts'])
    expect(outputSchema().parse(full)).toEqual(full)
  })
})
