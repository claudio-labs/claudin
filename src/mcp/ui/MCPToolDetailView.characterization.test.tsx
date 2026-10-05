/**
 * Characterization of `MCPToolDetailView`, the screen /mcp and the plugin
 * manager show for one MCP tool: its names, its hints, its description and
 * its parameters. Tools are built by the MCP client from `tools/list` entries.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import React from 'react'
import { enterWorld, leaveWorld } from 'src/mcp/__testutils__/mcpConfigWorld.js'
import { MCPToolDetailView } from 'src/mcp/ui/MCPToolDetailView.js'
import { listedTool, server } from 'src/mcp/ui/__testutils__/settingsUiRig.js'
import { flat, KEYS, linesOf, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import type { Tool } from 'src/tools/Tool.js'

beforeEach(() => {
  enterWorld()
})
afterEach(() => {
  leaveWorld()
})

async function show(tool: Tool, serverName = 'srv', ready?: (frame: string) => boolean) {
  let backs = 0
  const screen = await mount(<MCPToolDetailView tool={tool} server={server(serverName)} onBack={() => backs++} />, {
    columns: 120,
    ready: ready ?? (frame => frame.includes('Full name:')),
  })
  const lines = () =>
    linesOf(screen.text())
      .map(line => line.trim())
      .filter(line => line !== '' && !/^[─]+$/.test(line))
  return { screen, lines, backs: () => backs }
}

describe('the header', () => {
  const cases: Array<{ hints: Record<string, boolean>; title: string }> = [
    { hints: {}, title: 'probe' },
    { hints: { readOnlyHint: true }, title: 'probe [read-only]' },
    { hints: { destructiveHint: true }, title: 'probe [destructive]' },
    { hints: { openWorldHint: true }, title: 'probe [open-world]' },
    { hints: { readOnlyHint: true, destructiveHint: true, openWorldHint: true }, title: 'probe [read-only] [destructive] [open-world]' },
  ]
  for (const c of cases) {
    test(
      `hints ${JSON.stringify(c.hints)} read "${c.title}", with the server as subtitle`,
      async () => {
        const view = await show(listedTool('srv', { name: 'probe', annotations: c.hints }))
        expect(view.lines().slice(0, 2)).toEqual([c.title, 'srv'])
      },
      SLOW,
    )
  }

  test(
    'a titled tool is headed by its title; the names below stay the protocol ones',
    async () => {
      const view = await show(listedTool('srv', { name: 'raw', annotations: { title: 'Friendly' } }))
      expect(view.lines().slice(0, 4)).toEqual(['Friendly', 'srv', 'Tool name: raw', 'Full name: mcp__srv__raw'])
    },
    SLOW,
  )

  test(
    'a server name with characters a tool name cannot carry is normalised in the full name only',
    async () => {
      const view = await show(listedTool('My Server.v2', { name: 'do-it' }), 'My Server.v2')
      expect(view.lines().slice(0, 4)).toEqual(['do-it', 'My Server.v2', 'Tool name: do-it', 'Full name: mcp__My_Server_v2__do-it'])
    },
    SLOW,
  )

  test(
    'a tool with no display name of its own is headed by its name without the server prefix',
    async () => {
      const bare = { ...listedTool('srv', { name: 'naked' }), userFacingName: undefined } as unknown as Tool
      const view = await show(bare)
      expect(view.lines()[0]).toBe('naked')
    },
    SLOW,
  )
})

describe('the description', () => {
  test(
    'is loaded from the tool and shown under its own heading',
    async () => {
      const view = await show(listedTool('srv', { name: 'probe', description: 'Looks things up.\nTwo lines.' }), 'srv', frame =>
        frame.includes('Two lines.'),
      )
      expect(view.lines().slice(4, 7)).toEqual(['Description:', 'Looks things up.', 'Two lines.'])
    },
    SLOW,
  )

  test(
    'an empty description leaves the heading out',
    async () => {
      const view = await show(listedTool('srv', { name: 'probe' }))
      await Bun.sleep(100)
      expect(flat(view.screen.text())).not.toContain('Description:')
    },
    SLOW,
  )

  test(
    'a description that cannot be loaded says so',
    async () => {
      const failing = {
        ...listedTool('srv', { name: 'probe' }),
        description: async () => {
          throw new Error('server went away')
        },
      } as unknown as Tool
      const view = await show(failing, 'srv', frame => frame.includes('Failed to load'))
      expect(view.lines().slice(4, 6)).toEqual(['Description:', 'Failed to load description'])
    },
    SLOW,
  )
})

describe('the parameters', () => {
  test(
    'one bullet per property, in schema order, with required, type and description',
    async () => {
      const tool = listedTool('srv', {
        name: 'probe',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to look for' },
            limit: { type: 'number' },
            anything: { description: 'No type given' },
            flag: true,
          },
          required: ['query', 'flag'],
        } as never,
      })
      const view = await show(tool, 'srv', frame => frame.includes('Parameters:'))
      const lines = view.lines()
      const at = lines.indexOf('Parameters:')
      expect(lines.slice(at, at + 5)).toEqual([
        'Parameters:',
        '• query (required): string - What to look for',
        '• limit: number',
        '• anything: unknown - No type given',
        '• flag (required): unknown',
      ])
    },
    SLOW,
  )

  for (const [why, schema] of [
    ['no properties', { type: 'object' }],
    ['an empty property list', { type: 'object', properties: {} }],
  ] as const) {
    test(
      `a schema with ${why} has no parameter section`,
      async () => {
        const view = await show(listedTool('srv', { name: 'probe', inputSchema: schema as never }))
        expect(flat(view.screen.text())).not.toContain('Parameters:')
      },
      SLOW,
    )
  }
})

describe('keys', () => {
  test(
    'Esc goes back, and the hint says so',
    async () => {
      const view = await show(listedTool('srv', { name: 'probe' }))
      expect(view.lines().at(-1)).toBe('Esc to go back')
      await view.screen.press(KEYS.esc)
      expect(view.backs()).toBe(1)
    },
    SLOW,
  )

  test(
    'a first Ctrl+C asks for a second one in place of the hint',
    async () => {
      const view = await show(listedTool('srv', { name: 'probe' }))
      await view.screen.press(KEYS.ctrlC)
      expect(view.lines().at(-1)).toBe('Press Ctrl-C again to exit')
      expect(view.backs()).toBe(0)
    },
    SLOW,
  )
})
