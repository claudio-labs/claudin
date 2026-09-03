import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'

import { renderLineChart } from 'src/terminal/render/lineChart.js'

const RED = '\x1b[31m'

describe('renderLineChart', () => {
  test('draws a rising series with corner glyphs', () => {
    const chart = renderLineChart([[0, 1, 2]], {
      height: 2,
      labelWidth: 3,
      format: value => String(value),
    })

    expect(chart.split('\n')).toEqual(['  2┤ ╭─', '  1┤╭╯', '  0┼╯'])
  })

  test('draws a falling series with the mirrored glyphs', () => {
    const chart = renderLineChart([[2, 1, 0]], {
      height: 2,
      labelWidth: 3,
      format: value => String(value),
    })

    expect(chart.split('\n')).toEqual(['  2┼╮', '  1┤╰╮', '  0┼ ╰─'])
  })

  test('puts the axis one column past the labels on every row', () => {
    const chart = renderLineChart([[5, 900, 12, 430, 7]], {
      height: 6,
      labelWidth: 8,
      format: value => `${Math.round(value)}`,
    })

    const rows = stripAnsi(chart).split('\n')
    expect(rows.length).toBe(7)
    for (const row of rows) {
      expect(row[8]).toMatch(/[┤┼]/)
      // The label is right-aligned into the columns before the axis.
      expect(row.slice(0, 8)).toMatch(/^ *\d+$/)
    }
  })

  test('marks the zero line only when the data brackets it', () => {
    const spansZero = renderLineChart([[-4, 0, 4]], {
      height: 4,
      labelWidth: 3,
      format: value => String(value),
    })
    expect(spansZero.split('\n')[2]).toStartWith('  0┼')

    // Wholly positive data: the axis carries no zero marker of its own, only
    // the anchor the first point puts on it.
    const positive = renderLineChart([[10, 20, 30]], {
      height: 4,
      labelWidth: 3,
      format: value => String(value),
    })
    const anchored = positive.split('\n').filter(row => row.includes('┼'))
    expect(anchored).toHaveLength(1)
    expect(anchored[0]).toStartWith(' 10┼')
  })

  test('colors only the glyphs it draws', () => {
    const options = {
      height: 3,
      labelWidth: 4,
      format: (value: number) => String(value),
    }
    const plain = renderLineChart([[1, 3, 2]], options)
    const colored = renderLineChart([[1, 3, 2]], { ...options, colors: [RED] })

    expect(colored).toContain(RED)
    expect(stripAnsi(colored)).toBe(plain)
  })

  test('cycles the palette across series', () => {
    const colored = renderLineChart([[1, 2], [2, 1], [1, 2]], {
      height: 2,
      labelWidth: 3,
      colors: [RED, '\x1b[32m'],
      format: value => String(value),
    })

    expect(colored).toContain(RED)
    expect(colored).toContain('\x1b[32m')
  })

  test('returns an empty string when there is nothing to plot', () => {
    expect(renderLineChart([])).toBe('')
    expect(renderLineChart([[]])).toBe('')
    expect(renderLineChart([[NaN, NaN]])).toBe('')
  })

  test('collapses a flat series onto a single row', () => {
    const chart = renderLineChart([[7, 7, 7]], {
      height: 4,
      labelWidth: 3,
      format: value => String(value),
    })

    expect(chart.split('\n')).toEqual(['  7┼───'])
  })
})
