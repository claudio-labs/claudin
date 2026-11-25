import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { z } from 'zod/v4'
import { AssistantToolUseMessage } from 'src/agent/ui/messages/AssistantToolUseMessage.js'
import { EXTENSION_ICONS } from 'src/terminal/fileIcons.js'
import { renderToAnsiString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { NerdFontGlyphsContext } from 'src/terminal/terminalFont.js'
import { getTheme } from 'src/terminal/theme/theme.js'
import type { Tool, Tools } from 'src/tools/Tool.js'

// The icon decisions are tested in toolRowIcons.test.ts; this pins how the
// row lays them out: tool icon before the name, file icon inside the parens.

const EDIT_ICON = '\u{f0dc9}'
const BASH_ICON = '\u{f018d}'
const TS_ICON = EXTENSION_ICONS['.ts']!
// Every Nerd Font codepoint lives in a Private Use Area.
const PUA_RE = /[\u{e000}-\u{f8ff}\u{f0000}-\u{ffffd}]/u

let saved: string | undefined
beforeEach(() => {
  saved = process.env.CLAUDIN_NERD_FONT
})
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDIN_NERD_FONT
  else process.env.CLAUDIN_NERD_FONT = saved
})

function fakeTool(name: string, displayName: string, render: (input: Input) => string): Tool {
  return {
    name,
    inputSchema: z.object({ file_path: z.string().optional(), command: z.string().optional() }),
    userFacingName: () => displayName,
    renderToolUseMessage: render,
  } as unknown as Tool
}
type Input = { file_path?: string; command?: string }

const EDIT = fakeTool('Edit', 'Update', input => input.file_path ?? '')
const BASH = fakeTool('Bash', 'Bash', input => input.command ?? '')

function renderRowAnsi(
  tool: Tool,
  input: Input,
  {
    nerd,
    columns = 100,
    shouldShowDot = true,
    errored = false,
    glyphs,
  }: { nerd: boolean; columns?: number; shouldShowDot?: boolean; errored?: boolean; glyphs?: boolean },
): Promise<string> {
  process.env.CLAUDIN_NERD_FONT = nerd ? '1' : '0'
  const id = 'toolu_1'
  return renderToAnsiString(
    <AppStateProvider>
      <NerdFontGlyphsContext.Provider value={glyphs}>
        <AssistantToolUseMessage
          param={{ type: 'tool_use', id, name: tool.name, input }}
          addMargin={false}
          tools={[tool] as Tools}
          commands={[]}
          verbose={false}
          inProgressToolUseIDs={new Set()}
          progressMessagesForMessage={[]}
          shouldAnimate={false}
          shouldShowDot={shouldShowDot}
          lookups={
            {
              resolvedToolUseIDs: new Set([id]),
              erroredToolUseIDs: new Set(errored ? [id] : []),
              asyncLaunchedToolUseIDs: new Set(),
            } as unknown as React.ComponentProps<typeof AssistantToolUseMessage>['lookups']
          }
        />
      </NerdFontGlyphsContext.Provider>
    </AppStateProvider>,
    columns,
  )
}

function renderRow(tool: Tool, input: Input, opts: Parameters<typeof renderRowAnsi>[2]): Promise<string> {
  return renderRowAnsi(tool, input, opts).then(stripAnsi)
}

describe('AssistantToolUseMessage — Nerd Font icons', () => {
  test('a file tool shows its icon before the name and the file icon before the path', async () => {
    const out = await renderRow(EDIT, { file_path: '/repo/src/a.ts' }, { nerd: true })
    expect(out).toContain(`${EDIT_ICON} Update(${TS_ICON} /repo/src/a.ts)`)
  })

  test('a tool without a file shows only its own icon', async () => {
    const out = await renderRow(BASH, { command: 'ls -la' }, { nerd: true })
    expect(out).toContain(`${BASH_ICON} Bash(ls -la)`)
    expect(out.match(new RegExp(PUA_RE.source, 'gu'))).toHaveLength(1)
  })

  test('without a Nerd Font the row is exactly the old one', async () => {
    const out = await renderRow(EDIT, { file_path: '/repo/src/a.ts' }, { nerd: false })
    expect(out).toContain('Update(/repo/src/a.ts)')
    expect(out).not.toMatch(PUA_RE)
  })

  test('a render whose text leaves the terminal has no icons, whatever the terminal', async () => {
    const out = await renderRow(EDIT, { file_path: '/repo/src/a.ts' }, { nerd: true, glyphs: false })
    expect(out).toContain('● Update(/repo/src/a.ts)')
    expect(out).not.toMatch(PUA_RE)
  })

  test('an empty tool-use message drops the parens and the file icon with them', async () => {
    const hidden = fakeTool('Edit', 'Update', () => '')
    const out = await renderRow(hidden, { file_path: '/repo/src/a.ts' }, { nerd: true })
    expect(out).toContain(`${EDIT_ICON} Update`)
    expect(out).not.toContain('(')
    expect(out).not.toContain(TS_ICON)
  })

  test('the icons stay glued to the name and the path at a narrow width', async () => {
    // A sibling Text in a row Box becomes its own column (rules/ink-tui.md §10);
    // a width that forces a wrap is what would split them.
    const path = '/repo/src/agent/ui/messages/a-file-with-a-long-name.ts'
    for (const columns of [30, 50]) {
      const out = await renderRow(EDIT, { file_path: path }, { nerd: true, columns })
      expect(out).toContain(`${EDIT_ICON} Update(`)
      expect(out.replace(/\s+/g, '')).toContain(`(${TS_ICON}${path})`)
    }
  })

  test('the tool icon takes the status dot’s place', async () => {
    const nerd = await renderRow(BASH, { command: 'ls' }, { nerd: true })
    expect(nerd.trimStart().startsWith(`${BASH_ICON} Bash(ls)`)).toBe(true)
    expect(nerd).not.toContain('●')
    expect(await renderRow(BASH, { command: 'ls' }, { nerd: false })).toContain('● Bash(ls)')
  })

  test('a row that shows no dot still shows its icon', async () => {
    const out = await renderRow(BASH, { command: 'ls' }, { nerd: true, shouldShowDot: false })
    expect(out).toContain(`${BASH_ICON} Bash(ls)`)
  })

  test('the icon carries the row’s status: red on an error, default color when done', async () => {
    const saved = chalk.level
    chalk.level = 3
    try {
      const error = `\u001b[38;2;${getTheme('dark').error.match(/\d+/g)!.join(';')}m`
      const errored = await renderRowAnsi(BASH, { command: 'ls' }, { nerd: true, errored: true })
      expect(errored.slice(0, errored.indexOf(BASH_ICON))).toContain(error)
      // A row without a dot has no status to show, error or not.
      const dotless = await renderRowAnsi(BASH, { command: 'ls' }, { nerd: true, errored: true, shouldShowDot: false })
      expect(dotless.slice(0, dotless.indexOf(BASH_ICON))).not.toContain(error)
    } finally {
      chalk.level = saved
    }
  })
})
