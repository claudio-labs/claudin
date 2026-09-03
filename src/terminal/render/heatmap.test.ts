import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'

import { generateHeatmap } from 'src/terminal/render/heatmap.js'
import { toDateString } from 'src/platform/statsCache.js'
import type { DailyActivity } from 'src/platform/stats.js'

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** Columns of grid the heatmap derives from a terminal width. */
function gridWidth(terminalWidth: number): number {
  return Math.min(52, Math.max(10, terminalWidth - 4))
}

/**
 * The Sunday that opens column `week` of a grid `width` columns wide. The grid
 * ends on the week containing today, so column `width - 1` is the current week.
 */
function weekStart(width: number, week: number): Date {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const start = new Date(today)
  start.setDate(today.getDate() - today.getDay() - (width - 1 - week) * 7)
  return start
}

/** A year of activity ending today, so every month in the window has data. */
function buildActivity(days: number): DailyActivity[] {
  const activity: DailyActivity[] = []
  const day = new Date()
  day.setHours(0, 0, 0, 0)
  for (let i = 0; i < days; i++) {
    activity.push({
      date: toDateString(day),
      messageCount: (i % 7) * 10 + 1,
      sessionCount: 1,
      toolCallCount: i % 5,
    })
    day.setDate(day.getDate() - 1)
  }
  return activity
}

const ACTIVITY = buildActivity(370)

describe('generateHeatmap', () => {
  test.each([56, 40])(
    'places every month label on the column of its first week (width %i)',
    terminalWidth => {
      const width = gridWidth(terminalWidth)
      const monthLine = stripAnsi(
        generateHeatmap(ACTIVITY, { terminalWidth }),
      ).split('\n')[0]!

      const labels = [...monthLine.matchAll(/[A-Z][a-z]{2}/g)]
      expect(labels.length).toBeGreaterThan(1)

      for (const label of labels) {
        // The line is indented by the 4-column day-label gutter.
        const column = label.index - 4
        expect(column).toBeGreaterThanOrEqual(0)
        expect(MONTH_NAMES[weekStart(width, column).getMonth()]).toBe(label[0])
      }
    },
  )

  test('keeps the intensity legend intact', () => {
    const output = stripAnsi(generateHeatmap(ACTIVITY, { terminalWidth: 56 }))
    expect(output).toContain('Less ░ ▒ ▓ █ More')
  })

  test('renders seven day rows, labelled only on Mon/Wed/Fri', () => {
    const lines = stripAnsi(
      generateHeatmap(ACTIVITY, { terminalWidth: 56 }),
    ).split('\n')
    const grid = lines.slice(1, 8)

    expect(grid).toHaveLength(7)
    expect(grid[1]!.startsWith('Mon ')).toBe(true)
    expect(grid[3]!.startsWith('Wed ')).toBe(true)
    expect(grid[5]!.startsWith('Fri ')).toBe(true)
    for (const unlabelled of [0, 2, 4, 6]) {
      expect(grid[unlabelled]!.startsWith('    ')).toBe(true)
    }
  })

  test('never draws wider than the terminal it was given', () => {
    for (const terminalWidth of [80, 60, 40]) {
      const lines = stripAnsi(
        generateHeatmap(ACTIVITY, { terminalWidth }),
      ).split('\n')
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(terminalWidth)
      }
    }
  })
})
