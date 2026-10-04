/**
 * Characterization of how the REPL combines the MCP clients it was started
 * with (`initialMcpClients`, e.g. SDK or IDE servers set up before the UI)
 * with the clients the connection manager keeps in app state.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import React from 'react'
import { mergeClients, useMergedClients } from 'src/mcp/hooks/useMergedClients.js'
import type { MCPServerConnection } from 'src/mcp/types.js'
import { createFakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot } from 'src/terminal/ink.js'
import { until } from 'src/mcp/__testutils__/connectionRig.js'

function entry(name: string, type: MCPServerConnection['type'] = 'pending', tag = ''): MCPServerConnection {
  return { name, type, config: { command: `cmd-${name}${tag}`, args: [], scope: 'user' } } as MCPServerConnection
}

const ide = entry('ide', 'pending', '-initial')
const sdk = entry('sdk', 'pending', '-initial')
const live = entry('live')
const liveIde = entry('ide', 'connected', '-live')

type Case = { why: string; initial: MCPServerConnection[] | undefined; fromState: MCPServerConnection[] | undefined; out: MCPServerConnection[] }

const cases: Case[] = [
  { why: 'nothing on either side gives an empty list', initial: undefined, fromState: undefined, out: [] },
  // Missing initial clients with a non-empty app state gives [] today; that
  // drops every managed server (Findings, 6: fix), so it is not pinned.
  { why: 'an empty app state keeps the initial clients', initial: [ide, sdk], fromState: [], out: [ide, sdk] },
  { why: 'a missing app state keeps the initial clients', initial: [ide], fromState: undefined, out: [ide] },
  { why: 'both: initial first, then app state', initial: [ide, sdk], fromState: [live], out: [ide, sdk, live] },
  { why: 'a name on both sides keeps the initial entry', initial: [ide], fromState: [liveIde, live], out: [ide, live] },
  { why: 'repeats within app state collapse to the first', initial: [sdk], fromState: [live, entry('live', 'failed')], out: [sdk, live] },
]

describe('mergeClients', () => {
  for (const c of cases) {
    test(c.why, () => {
      expect(mergeClients(c.initial, c.fromState)).toEqual(c.out)
    })
  }

  test('returns the initial array itself when app state adds nothing', () => {
    const initial = [ide]
    expect(mergeClients(initial, [])).toBe(initial)
    expect(mergeClients(initial, undefined)).toBe(initial)
  })

  test('never changes its inputs', () => {
    const initial = [ide]
    const fromState = [liveIde, live]
    mergeClients(initial, fromState)
    expect(initial).toEqual([ide])
    expect(fromState).toEqual([liveIde, live])
  })
})

describe('useMergedClients', () => {
  const teardown: Array<() => void> = []
  afterEach(() => {
    while (teardown.length) teardown.pop()?.()
  })

  test('gives the merge, and the same array until one of its inputs changes', async () => {
    const terminal = createFakeTerminal()
    const root = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, exitOnCtrlC: false, patchConsole: false })
    teardown.push(() => {
      root.unmount()
      terminal.close()
    })
    const results: MCPServerConnection[][] = []
    function Host(props: { initial: MCPServerConnection[]; fromState: MCPServerConnection[]; tick: number }): React.ReactNode {
      results.push(useMergedClients(props.initial, props.fromState))
      return null
    }
    const initial = [ide]
    const fromState = [live]
    root.render(<Host initial={initial} fromState={fromState} tick={1} />)
    await until('first render', () => results.length === 1)
    root.render(<Host initial={initial} fromState={fromState} tick={2} />)
    await until('second render', () => results.length === 2)
    const other = [live, entry('more')]
    root.render(<Host initial={initial} fromState={other} tick={3} />)
    await until('third render', () => results.length === 3)

    expect(results[0]).toEqual([ide, live])
    expect(results[1]).toBe(results[0] as MCPServerConnection[])
    expect(results[2]).toEqual([ide, live, entry('more')])
  })
})
