/**
 * Characterization of `MCPSettings`, the /mcp panel, over the app state it
 * reads: the MCP clients and the agents' inline servers. These tests stay on
 * screens that need no live connection (the list, the agent-server menu, the
 * empty case); MCPSettings.actions.characterization.test.tsx drives the
 * server menus against real servers.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import React from 'react'
import { enterWorld, leaveWorld } from 'src/mcp/__testutils__/mcpConfigWorld.js'
import type { MCPServerConnection } from 'src/mcp/types.js'
import { MCPSettings } from 'src/mcp/ui/index.js'
import { completions } from 'src/mcp/ui/__testutils__/settingsUiRig.js'
import { flat, KEYS, linesOf, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { Box, Text } from 'src/terminal/ink.js'
import { type AppState, getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

beforeEach(() => {
  enterWorld()
})
afterEach(() => {
  leaveWorld()
})

/**
 * The facts the empty message must state. The binary it names is a finding
 * (it names another product's CLI), so the name itself is not pinned.
 */
function expectNoServersMessage(log: Array<{ result?: string; options?: unknown }>): void {
  expect(log).toHaveLength(1)
  expect(log[0]?.options).toBeUndefined()
  const message = log[0]?.result ?? ''
  expect(message.startsWith('No MCP servers configured.')).toBe(true)
  expect(message).toContain('/doctor')
  expect(message).toMatch(/`\S+ mcp --help`/)
  expect(message).toContain('https://code.claude.com/docs/en/mcp')
}

function client(name: string, type: MCPServerConnection['type'], config: Record<string, unknown>): MCPServerConnection {
  return { name, type, config } as unknown as MCPServerConnection
}

const stdio = (scope: string) => ({ command: 'run', scope })
const proxy = { type: 'claudeai-proxy', url: 'https://connectors.test/x', id: 'x', scope: 'claudeai' }

/** An agent definition as far as the panel reads it: its type and inline servers. */
function agent(agentType: string, mcpServers: unknown[]) {
  return { agentType, mcpServers, source: 'userSettings', whenToUse: '', getSystemPrompt: () => '' }
}

type Seed = { clients?: MCPServerConnection[]; agents?: ReturnType<typeof agent>[] }

async function open(seed: Seed, ready?: (frame: string) => boolean) {
  const done = completions()
  const base = getDefaultAppState()
  const appState: Partial<AppState> = {
    mcp: { ...base.mcp, clients: seed.clients ?? [] },
    agentDefinitions: { ...base.agentDefinitions, allAgents: (seed.agents ?? []) as never, activeAgents: [] },
  }
  const screen = await mount(
    <Box flexDirection="column">
      <MCPSettings onComplete={done.onComplete} />
      <Text>[end]</Text>
    </Box>,
    { columns: 160, appState, ready: ready ?? (frame => frame.includes('Manage MCP servers')) },
  )
  return { screen, done }
}

describe('which servers the panel lists', () => {
  test(
    'every client but the IDE’s, grouped as the list panel groups them',
    async () => {
      const { screen } = await open({
        clients: [
          client('zed', 'connected', stdio('user')),
          client('ide', 'connected', { type: 'sse-ide', url: 'http://127.0.0.1:1/ide', scope: 'dynamic' }),
          client('apple', 'failed', stdio('project')),
          client('claude.ai Notes', 'needs-auth', proxy),
        ],
      })
      const text = flat(screen.text())
      expect(text).toContain('Manage MCP servers 3 servers')
      expect(text).toContain('Project MCPs')
      expect(text).toContain('apple · ✘ failed')
      expect(text).toContain('User MCPs')
      expect(text).toContain('zed · ✔ connected')
      expect(text).toContain('claude.ai claude.ai Notes · △ needs authentication')
      expect(text).not.toContain('ide ·')
    },
    SLOW,
  )

  test(
    'a server only an agent declares is listed under that agent',
    async () => {
      const { screen, done } = await open({
        agents: [agent('reviewer', [{ helper: { command: 'run-helper' } }, 'by-reference']), agent('writer', [{ remote: { type: 'http', url: 'https://r.test/mcp' } }])],
      })
      const text = flat(screen.text())
      expect(text).toContain('Manage MCP servers 2 servers')
      expect(text).toContain('Agent MCPs @reviewer ❯ helper · ◯ agent-only @writer remote · △ may need auth')
      expect(done.log).toEqual([])
    },
    SLOW,
  )
})

describe('when there is nothing to show', () => {
  for (const [why, seed] of [
    ['no clients and no agent servers', {}],
    ['only the IDE’s client', { clients: [client('ide', 'connected', { type: 'sse-ide', url: 'http://127.0.0.1:1/ide', scope: 'dynamic' })] }],
    ['agents that only name servers configured elsewhere', { agents: [agent('reviewer', ['some-server'])] }],
  ] as const) {
    test(
      `${why}: the panel closes at once with a pointer to the docs`,
      async () => {
        const { screen, done } = await open(seed as Seed, frame => frame.includes('[end]'))
        await Bun.sleep(150)
        expectNoServersMessage(done.log)
        expect(linesOf(screen.text()).filter(Boolean)).toEqual(['[end]'])
      },
      SLOW,
    )
  }

  test(
    'clients that are still being looked at never trigger the empty message',
    async () => {
      const { done } = await open({ clients: [client('slow', 'pending', stdio('user'))] })
      await Bun.sleep(200)
      expect(done.log).toEqual([])
    },
    SLOW,
  )
})

describe('the agent-server menu', () => {
  test(
    'Enter opens it for the selected agent server; Esc comes back to the list',
    async () => {
      const { screen, done } = await open({
        clients: [client('kit', 'connected', stdio('user'))],
        agents: [agent('reviewer', [{ helper: { command: 'run-helper' } }]), agent('writer', [{ helper: { command: 'other' } }])],
      })
      await screen.press(KEYS.down, KEYS.enter)
      const menu = await screen.until(frame => frame.includes('Helper MCP Server'), 'the agent server menu')
      expect(flat(menu)).toContain('Used by: reviewer, writer')
      expect(flat(menu)).toContain('Command: run-helper')
      await screen.press(KEYS.esc)
      const list = await screen.until(frame => frame.includes('Manage MCP servers'), 'the list again')
      expect(flat(list)).toContain('helper · ◯ agent-only')
      expect(done.log).toEqual([])
    },
    SLOW,
  )

  test(
    'Back in the agent-server menu also comes back to the list',
    async () => {
      const { screen, done } = await open({ agents: [agent('reviewer', [{ helper: { command: 'run-helper' } }])] })
      await screen.press(KEYS.enter)
      await screen.until(frame => frame.includes('Helper MCP Server'), 'the agent server menu')
      await screen.press(KEYS.enter)
      await screen.until(frame => frame.includes('Manage MCP servers'), 'the list again')
      expect(done.log).toEqual([])
    },
    SLOW,
  )
})

describe('leaving', () => {
  test(
    'Esc on the list closes the panel with a system message',
    async () => {
      const { screen, done } = await open({ clients: [client('kit', 'connected', stdio('user'))] })
      await screen.press(KEYS.esc)
      expect(done.log).toEqual([{ result: 'MCP dialog dismissed', options: { display: 'system' } }])
    },
    SLOW,
  )
})
