import { describe, expect, test } from 'bun:test'

import { scanSymbols } from 'src/tools/shared/codeOutline/scanSymbols.js'
import { renderOutline } from 'src/tools/shared/codeOutline/renderOutline.js'

describe('scanSymbols — Markdown', () => {
  test('headings nest by level and bound their sections', () => {
    const src = [
      '# Guide',
      '',
      'Intro text.',
      '',
      '## Install',
      '',
      'Step one.',
      '',
      '### From source',
      '',
      'Build it.',
      '',
      '## Usage ##',
      '',
      'Run it.',
    ].join('\n')
    const syms = scanSymbols(src, 'markdown')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.Guide).toMatchObject({
      kind: 'heading',
      depth: 0,
      startLine: 1,
      endLine: 15,
    })
    expect(byName.Install).toMatchObject({
      depth: 1,
      startLine: 5,
      endLine: 12,
    })
    expect(byName['From source']).toMatchObject({ depth: 2, endLine: 12 })
    // Trailing closing hashes are stripped from the name.
    expect(byName.Usage).toMatchObject({ depth: 1, endLine: 15 })
    expect(byName.Usage.signature).toBe('## Usage ##')
  })

  test('comment lines inside fenced code blocks are not headings', () => {
    const src = [
      '# Real',
      '',
      '```bash',
      '# not a heading',
      '~~~',
      '```',
      '',
      '~~~py',
      '# also not a heading',
      '~~~',
      '',
      '## Also real',
    ].join('\n')
    const syms = scanSymbols(src, 'markdown')

    expect(syms.map(s => s.name)).toEqual(['Real', 'Also real'])
  })

  test('empty or heading-free documents fail open', () => {
    expect(scanSymbols('', 'markdown')).toEqual([])
    expect(scanSymbols('just prose\nno headings\n', 'markdown')).toEqual([])
  })

  test('depth is normalized to the shallowest heading level', () => {
    const src = ['## Setup', '', 'text', '', '### Linux', '', '## Use'].join(
      '\n',
    )
    const syms = scanSymbols(src, 'markdown')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    // An h2-only document renders flush, not pre-indented one level.
    expect(byName.Setup).toMatchObject({ depth: 0 })
    expect(byName.Linux).toMatchObject({ depth: 1 })
    expect(byName.Use).toMatchObject({ depth: 0 })
  })

  test('the drill-in hint skips heading names containing a quote', () => {
    const src = ["# Don't panic", '', 'text', '', '## Towel'].join('\n')
    const syms = scanSymbols(src, 'markdown')
    const out = renderOutline(syms, 'guide.md', 5)

    // `symbol='Don't panic'` would render with broken quoting — the hint
    // falls back to the first quote-free name; the entry itself remains.
    expect(out).toContain("symbol='Towel'")
    expect(out).toContain("# Don't panic")
  })
})
