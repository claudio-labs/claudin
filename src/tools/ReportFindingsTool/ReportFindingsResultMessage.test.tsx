import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import { renderToString } from 'src/terminal/render/staticRender.js'
import {
  ReportFindingsTool,
  type Output,
} from 'src/tools/ReportFindingsTool/ReportFindingsTool.js'

// A summary long enough to wrap at every width we sweep — this is the shape a
// model that ignores the "one sentence" hint produces, and the one that made
// the missing hanging indent visible.
const LONG_SUMMARY =
  'the download and upload routes never call session.commit(), so the Subtitle row written during the request is rolled back when the session closes'
const LONG_SCENARIO =
  'user downloads a subtitle from the UI, the .srt lands on disk and the response shows the new Subtitle, but the INSERT is reverted when the request session closes'

// The renderer ignores the options bag (theme/tools/verbose), so stub it.
const renderResult = ReportFindingsTool.renderToolResultMessage!

function render(content: Output, columns: number): Promise<string> {
  return renderToString(renderResult(content, [], {} as never), columns).then(
    stripAnsi,
  )
}

const ONE_FINDING: Output = {
  findings: [
    {
      file: 'src/backend/media_library/router.py',
      line: 256,
      summary: LONG_SUMMARY,
      failure_scenario: LONG_SCENARIO,
      verdict: 'CONFIRMED' as const,
    },
  ],
}

describe('ReportFindings result message', () => {
  // Only a width that forces a wrap can tell a hanging indent from a flat one.
  for (const columns of [60, 80, 100]) {
    test(`wrapped lines stay indented under the marker at ${columns} columns`, async () => {
      const out = await render(ONE_FINDING, columns)
      const body = out
        .split('\n')
        .map(l => l.trimEnd())
        .filter(l => l !== '' && !l.includes('Reported '))

      // The summary wrapped, otherwise this test proves nothing.
      expect(body.length).toBeGreaterThan(2)

      let inScenario = false
      for (const line of body) {
        // Every row either opens a finding ("· ") or continues one, and a
        // continuation must land exactly on its marker's text column — the
        // space the wrap broke on is trimmed, so never one column further.
        if (line.startsWith('· ')) {
          inScenario = false
          continue
        }
        if (line.startsWith('  ↳ ')) {
          inScenario = true
          continue
        }
        const indent = line.length - line.trimStart().length
        expect(indent).toBe(inScenario ? 4 : 2)
      }
      // Exactly one row opens the finding, and exactly one carries the arrow.
      expect(body.filter(l => l.startsWith('· '))).toHaveLength(1)
      expect(body.filter(l => l.includes('↳'))).toHaveLength(1)
    })
  }

  test('keeps each logical line contiguous instead of splitting it into columns', async () => {
    const flat = (await render(ONE_FINDING, 80)).replace(/\s+/g, ' ')
    expect(flat).toContain('Reported 1 finding:')
    expect(flat).toContain('src/backend/media_library/router.py:256 — ')
    expect(flat).toContain(LONG_SUMMARY)
    expect(flat).toContain('(CONFIRMED)')
    expect(flat).toContain(LONG_SCENARIO)
  })

  test('renders the empty case with no finding rows', async () => {
    const out = await render({ findings: [] }, 80)
    expect(out).toContain('No findings survived verification.')
    expect(out).not.toContain('↳')
  })
})
