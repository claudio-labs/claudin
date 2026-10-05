/**
 * Characterization of `MCPListPanel`, the first screen of /mcp: which
 * servers it lists and under which heading, how each one's state reads, and
 * what the keys do. The panel is mounted on a fake terminal inside the app
 * state and key-binding providers, and driven with real key presses.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'path'
import React from 'react'
import { enterWorld, leaveWorld, writeMcpJson, type World } from 'src/mcp/__testutils__/mcpConfigWorld.js'
import { MCPListPanel } from 'src/mcp/ui/MCPListPanel.js'
import { agentServer, completions, server } from 'src/mcp/ui/__testutils__/settingsUiRig.js'
import type { AgentMcpServerInfo, ServerInfo } from 'src/mcp/ui/types.js'
import { flat, KEYS, linesOf, mount, SLOW, withTruecolor } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { isDebugMode } from 'src/shared/debug.js'
import { getGlobalClaudeFile } from 'src/shared/env.js'
import { Box, Text } from 'src/terminal/ink.js'

let world: World
beforeEach(() => {
  world = enterWorld()
})
afterEach(() => {
  leaveWorld()
})

type Opened = {
  text: () => string
  styled: () => string
  press: (...keys: string[]) => Promise<void>
  picked: string[]
  done: ReturnType<typeof completions>
}

async function open(
  servers: ServerInfo[],
  agents?: AgentMcpServerInfo[],
  options: { agentHandler?: boolean; columns?: number } = {},
): Promise<Opened> {
  const picked: string[] = []
  const done = completions()
  const screen = await mount(
    <MCPListPanel
      servers={servers}
      agentServers={agents}
      onSelectServer={s => picked.push(s.name)}
      onSelectAgentServer={options.agentHandler === false ? undefined : s => picked.push(`agent:${s.name}`)}
      onComplete={done.onComplete}
    />,
    { columns: options.columns ?? 220 },
  )
  return { text: screen.text, styled: screen.styled, press: screen.press, picked, done }
}

/** Positions of each needle in the flattened frame; every needle must be there. */
function order(frame: string, needles: string[]): number[] {
  const text = flat(frame)
  return needles.map(needle => {
    const at = text.indexOf(needle)
    if (at < 0) throw new Error(`${JSON.stringify(needle)} is not on the screen:\n${frame}`)
    return at
  })
}

const ascending = (xs: number[]) => xs.every((x, i) => i === 0 || xs[i - 1]! < x)

/** The row that carries `name`, trimmed. */
const rowOf = (frame: string, name: string) =>
  linesOf(frame)
    .map(line => line.trim())
    .find(line => line.replace(/^❯ /, '').startsWith(`${name} · `))

const EVERY_SCOPE: ServerInfo[] = [
  server('zeta', { scope: 'project' }),
  server('alpha', { scope: 'project' }),
  server('loc', { scope: 'local' }),
  server('usr', { scope: 'user' }),
  server('ent', { scope: 'enterprise' }),
  server('web-b', { scope: 'claudeai', transport: 'claudeai-proxy' }),
  server('web-a', { scope: 'claudeai', transport: 'claudeai-proxy' }),
  server('plug-z', { scope: 'dynamic' }),
  server('plug-a', { scope: 'dynamic' }),
]

describe('what is listed, and where', () => {
  test(
    'groups come in a fixed order: project, local, user, enterprise, claude.ai, agents, built-in',
    async () => {
      const panel = await open(EVERY_SCOPE, [agentServer('helper', ['reviewer'])])
      const frame = panel.text()
      const positions = order(frame, [
        'Manage MCP servers',
        'Project MCPs',
        'Local MCPs',
        'User MCPs',
        'Enterprise MCPs',
        'claude.ai web-a',
        'Agent MCPs',
        'Built-in MCPs',
      ])
      expect(ascending(positions)).toBe(true)
    },
    SLOW,
  )

  test(
    'each heading names where its servers are configured',
    async () => {
      const panel = await open(EVERY_SCOPE)
      const text = flat(panel.text())
      const globalFile = getGlobalClaudeFile()
      expect(text).toContain(`Project MCPs (${join(world.project, '.mcp.json')})`)
      expect(text).toContain(`Local MCPs (${globalFile} [project: ${world.project}])`)
      expect(text).toContain(`User MCPs (${globalFile})`)
      expect(text).toContain('Built-in MCPs (always available)')
      // Enterprise and claude.ai name no file.
      expect(text).toContain('Enterprise MCPs ent ·')
      expect(text).toContain('claude.ai web-a ·')
    },
    SLOW,
  )

  test(
    'a group with no servers has no heading',
    async () => {
      const panel = await open([server('only', { scope: 'user' })])
      const text = flat(panel.text())
      expect(text).toContain('User MCPs')
      for (const absent of ['Project MCPs', 'Local MCPs', 'Enterprise MCPs', 'Agent MCPs', 'Built-in MCPs', 'claude.ai ']) {
        expect(text).not.toContain(absent)
      }
    },
    SLOW,
  )

  test(
    'servers sort by name inside every group',
    async () => {
      const panel = await open(EVERY_SCOPE)
      const frame = panel.text()
      for (const pair of [
        ['alpha ·', 'zeta ·'],
        ['web-a ·', 'web-b ·'],
        ['plug-a ·', 'plug-z ·'],
      ]) {
        expect(ascending(order(frame, pair))).toBe(true)
      }
    },
    SLOW,
  )

  test(
    'a claude.ai connector is listed under claude.ai by its transport, whatever its scope says',
    async () => {
      const panel = await open([server('conn', { scope: 'user', transport: 'claudeai-proxy' }), server('plain', { scope: 'user' })])
      const text = flat(panel.text())
      expect(text).toContain('User MCPs')
      expect(text).toContain('claude.ai conn ·')
      expect(text).not.toContain('conn · ✔ connected plain')
    },
    SLOW,
  )

  test(
    'agent servers sit under their agent, once per agent that declares them',
    async () => {
      const panel = await open([], [agentServer('helper', ['reviewer', 'writer']), agentServer('remote', ['writer'], true)])
      const frame = panel.text()
      expect(ascending(order(frame, ['Agent MCPs', '@reviewer', 'helper ·', '@writer', 'remote ·']))).toBe(true)
      expect(flat(frame).lastIndexOf('helper ·')).toBeGreaterThan(flat(frame).indexOf('@writer'))
      expect(rowOf(frame, 'remote')).toBe('remote · △ may need auth')
      const helperRows = linesOf(frame).filter(line => line.includes('helper ·'))
      expect(helperRows.map(line => line.trim().replace(/^❯ /, ''))).toEqual(['helper · ◯ agent-only', 'helper · ◯ agent-only'])
    },
    SLOW,
  )
})

describe('how a server state reads', () => {
  const cases: Array<{ server: ServerInfo; row: string }> = [
    { server: server('a', { kind: 'connected' }), row: 'a · ✔ connected' },
    { server: server('b', { kind: 'failed' }), row: 'b · ✘ failed' },
    { server: server('c', { kind: 'needs-auth', transport: 'http' }), row: 'c · △ needs authentication' },
    { server: server('d', { kind: 'disabled' }), row: 'd · ◯ disabled' },
    { server: server('e', { kind: 'pending' }), row: 'e · ◯ connecting…' },
    { server: server('f', { kind: 'pending', attempt: [2, 5] }), row: 'f · ◯ reconnecting (2/5)…' },
  ]

  test(
    'each connection state has its own glyph and words',
    async () => {
      const panel = await open(cases.map(c => c.server))
      const frame = panel.text()
      for (const c of cases) expect(rowOf(frame, c.server.name)?.replace(/^❯ /, '')).toBe(c.row)
    },
    SLOW,
  )

  describe('in colour', () => {
    withTruecolor()

    /** The foreground colour in force where `glyph` is drawn on the row of `name`. */
    function glyphColour(styled: string, name: string, glyph: string): string {
      const row = styled.split('\n').find(line => line.includes(`${name}\u001B`) && line.includes(glyph))
      if (!row) throw new Error(`no row for ${name} with ${glyph}`)
      const before = row.slice(0, row.indexOf(glyph))
      return before.match(/\u001B\[(?:38;[0-9;]*|39)m/g)?.at(-1) ?? ''
    }

    test(
      'a server still connecting is greyed out like a disabled one; the other states each have a colour',
      async () => {
        const panel = await open(cases.slice(0, 5).map(c => c.server))
        const styled = panel.styled()
        const style = {
          connected: glyphColour(styled, 'a', '✔'),
          failed: glyphColour(styled, 'b', '✘'),
          needsAuth: glyphColour(styled, 'c', '△'),
          disabled: glyphColour(styled, 'd', '◯'),
          pending: glyphColour(styled, 'e', '◯'),
        }
        expect(style.pending).toBe(style.disabled)
        const distinct = new Set([style.connected, style.failed, style.needsAuth, style.disabled])
        expect(distinct.size).toBe(4)
        for (const s of Object.values(style)) expect(s).toMatch(/38;2;/)
        // The selected row's name is coloured; the others' names are not.
        const rows = styled.split('\n').filter(line => line.includes(' · '))
        expect(rows[0]).toMatch(/\u001B\[38;2;[0-9;]+m❯ a\u001B\[39m/)
        expect(rows[1]).toMatch(/^ {4}b\u001B/)
      },
      SLOW,
    )
  })

  test(
    'the failure hint shows only when some server failed',
    async () => {
      const healthy = await open([server('ok')])
      expect(healthy.text()).not.toContain('※')
      const broken = await open([server('ok'), server('bad', { kind: 'failed' })])
      // The command's name is a finding (it names another binary); the advice is what is pinned.
      expect(flat(broken.text())).toMatch(/※ Run \S+ --debug to see error logs/)
    },
    SLOW,
  )

  test(
    'with debug on, the failure hint says the logs are inline',
    async () => {
      const before = process.env.DEBUG
      process.env.DEBUG = '1'
      isDebugMode.cache.clear?.()
      try {
        const panel = await open([server('bad', { kind: 'failed' })])
        expect(flat(panel.text())).toContain('※ Error logs shown inline with --debug')
      } finally {
        if (before === undefined) delete process.env.DEBUG
        else process.env.DEBUG = before
        isDebugMode.cache.clear?.()
      }
    },
    SLOW,
  )
})

describe('the frame', () => {
  test(
    'the subtitle counts settings servers and agent servers together',
    async () => {
      const cases: Array<{ servers: ServerInfo[]; agents: AgentMcpServerInfo[]; subtitle: string }> = [
        { servers: [server('one')], agents: [], subtitle: 'Manage MCP servers 1 server ' },
        { servers: [], agents: [agentServer('solo', ['x'])], subtitle: 'Manage MCP servers 1 server ' },
        { servers: [server('a'), server('b')], agents: [agentServer('c', ['x'])], subtitle: 'Manage MCP servers 3 servers ' },
      ]
      for (const c of cases) {
        const panel = await open(c.servers, c.agents)
        expect(flat(panel.text())).toContain(c.subtitle)
      }
    },
    SLOW,
  )

  test(
    'the help link and the key hints close the panel',
    async () => {
      const panel = await open([server('one')])
      const text = flat(panel.text())
      expect(text).toContain('https://code.claude.com/docs/en/mcp for help')
      expect(text.endsWith('↑↓ to navigate · Enter to confirm · Esc to cancel')).toBe(true)
    },
    SLOW,
  )

  test(
    'config diagnostics, when there are any, sit above the panel',
    async () => {
      writeMcpJson('{ broken')
      const panel = await open([server('one')])
      const positions = order(panel.text(), ['MCP Config Diagnostics', '[Failed to parse] Project config', 'Manage MCP servers'])
      expect(ascending(positions)).toBe(true)
    },
    SLOW,
  )

  test(
    'the diagnostics are read once, when the panel opens',
    async () => {
      writeMcpJson('{ broken')
      const panel = await open([server('one'), server('two')])
      expect(panel.text()).toContain('MCP Config Diagnostics')
      writeMcpJson({ mcpServers: {} })
      await panel.press(KEYS.down)
      expect(linesOf(panel.text()).some(line => line.trim().startsWith('❯ two'))).toBe(true)
      expect(panel.text()).toContain('MCP Config Diagnostics')
    },
    SLOW,
  )

  test(
    'with no servers and no agent servers it draws nothing',
    async () => {
      const done = completions()
      const screen = await mount(
        <Box flexDirection="column">
          <Text>[above]</Text>
          <MCPListPanel servers={[]} onSelectServer={() => {}} onComplete={done.onComplete} />
          <Text>[below]</Text>
        </Box>,
        { ready: frame => frame.includes('[below]') },
      )
      expect(linesOf(screen.text()).filter(Boolean)).toEqual(['[above]', '[below]'])
      expect(done.log).toEqual([])
    },
    SLOW,
  )
})

describe('keys', () => {
  test(
    'the first row starts selected; down and up move through every row and wrap at both ends',
    async () => {
      const panel = await open(EVERY_SCOPE, [agentServer('helper', ['reviewer'])])
      const pointed = () => linesOf(panel.text()).find(line => line.trim().startsWith('❯'))?.trim()
      expect(pointed()).toBe('❯ alpha · ✔ connected')
      // Navigation order: project, local, user, enterprise, claude.ai, agents, built-in.
      const walk = ['zeta', 'loc', 'usr', 'ent', 'web-a', 'web-b', 'helper', 'plug-a', 'plug-z', 'alpha']
      for (const name of walk) {
        await panel.press(KEYS.down)
        expect(pointed()?.startsWith(`❯ ${name} · `)).toBe(true)
      }
      await panel.press(KEYS.up)
      expect(pointed()?.startsWith('❯ plug-z · ')).toBe(true)
      await panel.press(KEYS.up)
      expect(pointed()?.startsWith('❯ plug-a · ')).toBe(true)
    },
    SLOW,
  )

  test(
    'Enter and y open the selected server; an agent server goes to its own handler',
    async () => {
      const panel = await open([server('first'), server('second')], [agentServer('helper', ['reviewer'])])
      await panel.press(KEYS.enter)
      await panel.press(KEYS.down, 'y')
      await panel.press(KEYS.down, KEYS.enter)
      expect(panel.picked).toEqual(['first', 'second', 'agent:helper'])
      expect(panel.done.log).toEqual([])
    },
    SLOW,
  )

  test(
    'an agent server without a handler cannot be opened',
    async () => {
      const panel = await open([], [agentServer('helper', ['reviewer'])], { agentHandler: false })
      await panel.press(KEYS.enter)
      expect(panel.picked).toEqual([])
      expect(panel.done.log).toEqual([])
    },
    SLOW,
  )

  for (const [label, key] of [
    ['Esc', KEYS.esc],
    ['n', 'n'],
  ] as const) {
    test(
      `${label} closes the panel once, as a system message`,
      async () => {
        const panel = await open([server('one')])
        await panel.press(key)
        expect(panel.done.log).toEqual([{ result: 'MCP dialog dismissed', options: { display: 'system' } }])
        expect(panel.picked).toEqual([])
      },
      SLOW,
    )
  }
})
