import { describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import React from 'react'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { renderToAnsiString, renderToString } from 'src/terminal/render/staticRender.js'
import { ShellProgressMessage } from 'src/tools/BashTool/ui/ShellProgressMessage.js'

function render(output: string, totalLines?: number): Promise<string> {
  return renderToString(
    <AppStateProvider>
      <ShellProgressMessage output={output} fullOutput={output} totalLines={totalLines} verbose={false} />
    </AppStateProvider>,
  )
}

describe('ShellProgressMessage', () => {
  test('shows the last five lines of a running command', async () => {
    const output = Array.from({ length: 7 }, (_, i) => `INFO step ${i + 1}`).join('\n')
    const out = await render(output, 7)
    expect(out).not.toContain('INFO step 2')
    for (let i = 3; i <= 7; i++) expect(out).toContain(`INFO step ${i}`)
    expect(out).toContain('+2 lines')
  })

  test('colors the levels of the lines it shows', async () => {
    const savedLevel = chalk.level
    chalk.level = 3
    try {
      const out = await renderToAnsiString(
        <AppStateProvider>
          <ShellProgressMessage output="ERROR boom" fullOutput="ERROR boom" verbose={false} />
        </AppStateProvider>,
      )
      // dark's `error` is rgb(255,107,128); the message goes back to the
      // block's dim gray, which is dark's `inactive` rgb(153,153,153).
      const at = out.indexOf('ERROR')
      expect(out.slice(Math.max(0, at - 30), at)).toContain('38;2;255;107;128')
      expect(out).toContain('ERROR\x1b[38;2;153;153;153m boom')
    } finally {
      chalk.level = savedLevel
    }
  })
})
