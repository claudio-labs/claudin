import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import figures from 'figures'
import { readFileSync } from 'fs'
import { join } from 'path'
import { getTaskIcon } from 'src/agent/ui/taskStatusIcons.js'

let saved: string | undefined
beforeEach(() => {
  saved = process.env.CLAUDIN_NERD_FONT
})
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDIN_NERD_FONT
  else process.env.CLAUDIN_NERD_FONT = saved
})

describe('getTaskIcon', () => {
  test('without a Nerd Font: the figures glyphs TaskListV2 always had', () => {
    process.env.CLAUDIN_NERD_FONT = '0'
    expect(getTaskIcon('completed')).toEqual({ icon: figures.tick, color: 'success' })
    expect(getTaskIcon('in_progress')).toEqual({ icon: figures.squareSmallFilled, color: 'claude' })
    expect(getTaskIcon('pending')).toEqual({ icon: figures.squareSmall, color: undefined })
  })

  test('with a Nerd Font: the nf-md circle set, same colors', () => {
    process.env.CLAUDIN_NERD_FONT = '1'
    expect(getTaskIcon('completed')).toEqual({ icon: '\u{f0134}', color: 'success' })
    expect(getTaskIcon('in_progress')).toEqual({ icon: '\u{f0996}', color: 'claude' })
    expect(getTaskIcon('pending')).toEqual({ icon: '\u{f0130}', color: undefined })
  })

  test('TaskListV2 takes its row and totals icons from here', () => {
    // TaskListV2.tsx is React Compiler output that no test renders; pin that
    // it delegates instead of keeping a copy of the table.
    const source = readFileSync(join(import.meta.dir, 'TaskListV2.tsx'), 'utf8')
    expect(source).toContain("import { getTaskIcon } from 'src/agent/ui/taskStatusIcons.js'")
    expect(source).not.toContain('function getTaskIcon')
    expect(source.match(/getTaskIcon\(/g)).toHaveLength(2)
  })
})
