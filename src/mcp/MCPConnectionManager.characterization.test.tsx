/**
 * Characterization of `<MCPConnectionManager>` as a component: it renders
 * what it wraps, and it is the only place the three action hooks work.
 * What the actions do is pinned in the useManageMCPConnections suites,
 * which reach them through this component.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import React from 'react'
import { enterWorld, leaveWorld } from 'src/mcp/__testutils__/mcpConfigWorld.js'
import { MCPConnectionManager, useMcpDisconnect, useMcpReconnect, useMcpToggleEnabled } from 'src/mcp/MCPConnectionManager.js'
import { createFakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot, Text } from 'src/terminal/ink.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { until } from 'src/mcp/__testutils__/connectionRig.js'

const teardown: Array<() => void> = []
afterEach(() => {
  while (teardown.length) teardown.pop()?.()
})

async function draw(tree: React.ReactNode) {
  const terminal = createFakeTerminal({ columns: 60 })
  const root = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, exitOnCtrlC: false, patchConsole: false })
  root.render(tree)
  teardown.push(() => {
    root.unmount()
    terminal.close()
  })
  return terminal
}

const hooks = [
  ['useMcpReconnect', useMcpReconnect],
  ['useMcpToggleEnabled', useMcpToggleEnabled],
  ['useMcpDisconnect', useMcpDisconnect],
] as const

describe('the action hooks', () => {
  for (const [name, hook] of hooks) {
    test(`${name} throws outside the manager, naming itself and the manager`, async () => {
      const seen: { error?: unknown } = {}
      function Outside(): React.ReactNode {
        try {
          hook()
        } catch (error) {
          seen.error = error
        }
        return null
      }
      await draw(
        <AppStateProvider>
          <Outside />
        </AppStateProvider>,
      )
      await until('the component to render', () => seen.error !== undefined)
      expect(seen.error).toBeInstanceOf(Error)
      expect((seen.error as Error).message).toContain(name)
      expect((seen.error as Error).message).toContain('MCPConnectionManager')
    })
  }

  test('inside the manager each hook hands back a function', async () => {
    enterWorld()
    teardown.push(leaveWorld)
    const got: Record<string, unknown> = {}
    function Inside(): React.ReactNode {
      for (const [name, hook] of hooks) got[name] = hook()
      return null
    }
    await draw(
      <AppStateProvider>
        <MCPConnectionManager dynamicMcpConfig={undefined} isStrictMcpConfig={false}>
          <Inside />
        </MCPConnectionManager>
      </AppStateProvider>,
    )
    await until('the hooks to run', () => Object.keys(got).length === 3)
    for (const [name] of hooks) expect(typeof got[name]).toBe('function')
  })
})

describe('the component', () => {
  test('renders what it wraps', async () => {
    enterWorld()
    teardown.push(leaveWorld)
    const terminal = await draw(
      <AppStateProvider>
        <MCPConnectionManager dynamicMcpConfig={undefined} isStrictMcpConfig={true}>
          <Text>wrapped content</Text>
        </MCPConnectionManager>
      </AppStateProvider>,
    )
    await until('the child on screen', () => terminal.screen().includes('wrapped content'))
  })
})
