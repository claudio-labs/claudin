// Box-drawing line chart, written to replace the `asciichart` package: the fork
// never received it, so `scripts/build/build.ts` resolved it to the native stub
// whose every export is `() => null` — the Models tab of `/stats` printed the
// literal "null" under its "Tokens per Day" heading.

export type LineChartOptions = {
  height?: number // Rows in the plot area, excluding the top one (default 8)
  colors?: string[] // ANSI opening sequences, one per series, reused cyclically
  labelWidth?: number // Columns reserved for the y-axis labels (default 6)
  format?: (value: number) => string // Y-axis label for a value
}

const RESET = '\x1b[39m'

// Row 0 is the top of the chart, so a *smaller* row index means a *larger* value.
const AXIS = '┤'
const AXIS_ZERO = '┼'
const FLAT = '─'
const RISE_TOP = '╭'
const RISE_BOTTOM = '╯'
const FALL_TOP = '╮'
const FALL_BOTTOM = '╰'
const VERTICAL = '│'

function paint(char: string, color: string | undefined): string {
  return color ? `${color}${char}${RESET}` : char
}

/**
 * Renders one or more series as a single line chart.
 *
 * Every row is `labelWidth` columns of right-aligned label, one column of axis,
 * then one column per data point — so a caller can align an x-axis legend under
 * the plot by indenting it `labelWidth + 1`. A label longer than `labelWidth` is
 * never truncated, it just pushes that row's axis right.
 */
export function renderLineChart(
  series: number[][],
  options: LineChartOptions = {},
): string {
  const { height = 8, colors = [], labelWidth = 6 } = options
  const format = options.format ?? ((value: number) => value.toFixed(2))

  const plotted = series.filter(values => values.length > 0)
  if (plotted.length === 0) return ''

  let min = Infinity
  let max = -Infinity
  for (const values of plotted) {
    for (const value of values) {
      if (!Number.isFinite(value)) continue
      if (value < min) min = value
      if (value > max) max = value
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return ''

  const range = max - min
  const ratio = range !== 0 ? height / range : 1
  const bottom = Math.round(min * ratio)
  const rows = Math.max(0, Math.round(max * ratio) - bottom)
  const width = Math.max(...plotted.map(values => values.length))

  const grid: string[][] = []
  for (let row = 0; row <= rows; row++) {
    grid.push(new Array<string>(width).fill(' '))
  }

  // The zero line gets a distinct axis glyph, but only when the data brackets it.
  const zeroRow =
    range !== 0 && min <= 0 && max >= 0 ? Math.round((max * rows) / range) : -1
  const axis: string[] = []
  const labels: string[] = []
  for (let row = 0; row <= rows; row++) {
    labels.push(format(rows === 0 ? max : max - (row * range) / rows))
    axis.push(row === zeroRow ? AXIS_ZERO : AXIS)
  }

  const rowOf = (value: number): number => {
    const row = rows - (Math.round(value * ratio) - bottom)
    return Math.min(rows, Math.max(0, row))
  }

  for (let i = 0; i < plotted.length; i++) {
    const values = plotted[i]!
    const color = colors.length > 0 ? colors[i % colors.length] : undefined

    // Anchor the line to the axis at its first point.
    axis[rowOf(values[0]!)] = paint(AXIS_ZERO, color)

    for (let x = 0; x < values.length; x++) {
      const from = rowOf(values[x]!)
      const to = x + 1 < values.length ? rowOf(values[x + 1]!) : from
      if (from === to) {
        grid[from]![x] = paint(FLAT, color)
        continue
      }
      const rising = to < from
      grid[to]![x] = paint(rising ? RISE_TOP : FALL_BOTTOM, color)
      grid[from]![x] = paint(rising ? RISE_BOTTOM : FALL_TOP, color)
      for (let row = Math.min(from, to) + 1; row < Math.max(from, to); row++) {
        grid[row]![x] = paint(VERTICAL, color)
      }
    }
  }

  return grid
    .map(
      (cells, row) =>
        `${labels[row]!.padStart(labelWidth)}${axis[row]!}${cells.join('')}`.trimEnd(),
    )
    .join('\n')
}
