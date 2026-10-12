import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import React from 'react'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { ThemeProvider } from 'src/terminal/design-system/ThemeProvider.js'
import { renderToAnsiString } from 'src/terminal/render/staticRender.js'
import { OutputLine } from 'src/tools/BashTool/ui/OutputLine.js'

// dark (the theme without a provider) paints `error` as rgb(255,107,128).
const DARK_ERROR_SGR = '38;2;255;107;128'

const savedLevel = chalk.level
beforeAll(() => {
  chalk.level = 3
})
afterAll(() => {
  chalk.level = savedLevel
})

function render(node: React.ReactNode): Promise<string> {
  return renderToAnsiString(<AppStateProvider>{node}</AppStateProvider>)
}

/** The escape sequences written right before `word`. */
function escapesBefore(out: string, word: string): string {
  const at = out.indexOf(word)
  expect(at).toBeGreaterThan(-1)
  return out.slice(Math.max(0, at - 30), at)
}

describe('OutputLine log highlighting', () => {
  test('highlightLogs paints the level with the theme', async () => {
    const out = await render(<OutputLine content="ERROR boom" highlightLogs />)
    expect(escapesBefore(out, 'ERROR')).toContain(DARK_ERROR_SGR)
    // The color closes right after the level: the message stays plain.
    expect(out).toContain('ERROR\x1b[39m boom')
  })

  test('the color follows the active theme', async () => {
    const out = await render(
      <ThemeProvider initialState="dark-ansi" onThemeSave={() => {}}>
        <OutputLine content="ERROR boom" highlightLogs />
      </ThemeProvider>,
    )
    // dark-ansi's `error` is ansi:redBright → SGR 91.
    expect(out).toContain('\x1b[91mERROR\x1b[39m boom')
  })

  test('without it (MCP results) the text stays plain', async () => {
    const out = await render(<OutputLine content="ERROR boom" />)
    expect(out).not.toContain(DARK_ERROR_SGR)
  })
})
