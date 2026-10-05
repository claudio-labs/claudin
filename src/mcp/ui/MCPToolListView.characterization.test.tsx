/**
 * Characterization of `MCPToolListView`, the "Tools for <server>" screen of
 * /mcp and of the plugin manager. The tools come from the app state's MCP
 * pool, built by the MCP client from `tools/list` entries.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import React from 'react'
import { enterWorld, leaveWorld } from 'src/mcp/__testutils__/mcpConfigWorld.js'
import { MCPToolListView } from 'src/mcp/ui/MCPToolListView.js'
import { listedTool, server, type Kind } from 'src/mcp/ui/__testutils__/settingsUiRig.js'
import type { ServerInfo } from 'src/mcp/ui/types.js'
import { flat, KEYS, linesOf, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import type { Tool } from 'src/tools/Tool.js'

beforeEach(() => {
  enterWorld()
})
afterEach(() => {
  leaveWorld()
})

const POOL: Tool[] = [
  listedTool('srv', { name: 'plain' }),
  listedTool('other', { name: 'not-mine' }),
  listedTool('srv', { name: 'reader', annotations: { readOnlyHint: true } }),
  listedTool('srv', { name: 'wiper', annotations: { destructiveHint: true } }),
  listedTool('srv', { name: 'surfer', annotations: { openWorldHint: true } }),
  listedTool('srv', { name: 'all-hints', annotations: { readOnlyHint: true, destructiveHint: true, openWorldHint: true } }),
]

type Shown = {
  text: () => string
  styled: () => string
  press: (...keys: string[]) => Promise<void>
  selected: Array<{ name: string; index: number }>
  backs: () => number
}

async function show(target: ServerInfo, tools: Tool[] = POOL): Promise<Shown> {
  const selected: Array<{ name: string; index: number }> = []
  let backs = 0
  const base = getDefaultAppState()
  const screen = await mount(
    <MCPToolListView server={target} onSelectTool={(tool, index) => selected.push({ name: tool.name, index })} onBack={() => backs++} />,
    { columns: 120, appState: { mcp: { ...base.mcp, tools } } },
  )
  return { text: screen.text, styled: screen.styled, press: screen.press, selected, backs: () => backs }
}

/** The option rows: `label` and what follows it on the same line. */
const optionRows = (frame: string) =>
  linesOf(frame)
    .map(line => line.trim())
    .filter(line => /^(❯ )?\d+\. /.test(line))
    .map(line => line.replace(/^(❯ )?\d+\. /, '').replace(/\s{2,}/g, ' | '))

describe('what it lists', () => {
  test(
    'the server’s own tools, in pool order, by display name, with their hints',
    async () => {
      const view = await show(server('srv'))
      const text = flat(view.text())
      expect(text).toContain('Tools for srv 5 tools')
      expect(optionRows(view.text())).toEqual([
        'plain',
        'reader | read-only',
        'wiper | destructive',
        'surfer | open-world',
        'all-hints | read-only, destructive, open-world',
      ])
      expect(text).not.toContain('not-mine')
    },
    SLOW,
  )

  test(
    'a tool the server gave a title is listed by that title',
    async () => {
      const view = await show(server('srv'), [listedTool('srv', { name: 'raw', annotations: { title: 'Nice Title' } })])
      expect(optionRows(view.text())).toEqual(['Nice Title'])
    },
    SLOW,
  )

  test(
    'one tool is counted in the singular',
    async () => {
      const view = await show(server('srv'), [listedTool('srv', { name: 'only' })])
      expect(flat(view.text())).toContain('Tools for srv 1 tool ')
    },
    SLOW,
  )

  test(
    'a tool with no display name of its own shows its name without the server prefix',
    async () => {
      const bare = { ...listedTool('srv', { name: 'raw-name' }), userFacingName: undefined } as unknown as Tool
      const view = await show(server('srv'), [bare])
      expect(optionRows(view.text())).toEqual(['raw-name'])
    },
    SLOW,
  )

  const empty: Array<{ why: string; kind: Kind; tools: Tool[] }> = [
    { why: 'a server that is not connected', kind: 'failed', tools: POOL },
    { why: 'a disabled server', kind: 'disabled', tools: POOL },
    { why: 'a connected server with no tools', kind: 'connected', tools: [listedTool('other', { name: 'x' })] },
  ]
  for (const c of empty) {
    test(
      `${c.why} lists nothing`,
      async () => {
        const view = await show(server('srv', { kind: c.kind }), c.tools)
        const text = flat(view.text())
        expect(text).toContain('Tools for srv 0 tools No tools available')
        expect(optionRows(view.text())).toEqual([])
      },
      SLOW,
    )
  }

  test(
    'the key hints say select and back',
    async () => {
      const view = await show(server('srv'))
      expect(flat(view.text()).endsWith('↑↓ to navigate · Enter to select · Esc to back')).toBe(true)
    },
    SLOW,
  )
})

describe('keys', () => {
  test(
    'Enter picks the highlighted tool and hands over its position in the list',
    async () => {
      const view = await show(server('srv'))
      await view.press(KEYS.enter)
      await view.press(KEYS.down, KEYS.down, KEYS.enter)
      expect(view.selected).toEqual([
        { name: 'mcp__srv__plain', index: 0 },
        { name: 'mcp__srv__wiper', index: 2 },
      ])
      expect(view.backs()).toBe(0)
    },
    SLOW,
  )

  test(
    'Esc goes back',
    async () => {
      const view = await show(server('srv'))
      await view.press(KEYS.esc)
      expect(view.backs()).toBe(1)
      expect(view.selected).toEqual([])
    },
    SLOW,
  )

  test(
    'Esc goes back from the empty list too',
    async () => {
      const view = await show(server('srv', { kind: 'failed' }))
      await view.press(KEYS.esc)
      expect(view.backs()).toBe(1)
    },
    SLOW,
  )

  test(
    'a first Ctrl+C asks for a second one in place of the hints',
    async () => {
      const view = await show(server('srv'))
      await view.press(KEYS.ctrlC)
      expect(flat(view.text())).toContain('Press Ctrl-C again to exit')
      expect(view.backs()).toBe(0)
    },
    SLOW,
  )
})
