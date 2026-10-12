import { describe, expect, test } from 'bun:test'
import React from 'react'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
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
})
