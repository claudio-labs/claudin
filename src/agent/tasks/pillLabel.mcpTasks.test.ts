// The pill words for monitor_mcp's two kinds. The single-kind wording before
// kinds existed ("1 monitor", "N monitors") is pinned in pillLabel.cover.test.ts.

import { describe, expect, test } from 'bun:test'

import { getPillLabel } from 'src/agent/tasks/pillLabel.js'
import { taskFixture } from 'src/agent/ui/tasks/__testutils__/taskFixtures.js'

const events = (id: string) => taskFixture('monitor_mcp', { id, kind: 'events' })
const call = (id: string) => taskFixture('monitor_mcp', { id, kind: 'call' })

describe('getPillLabel — monitor_mcp kinds', () => {
  test('event streams read as monitors', () => {
    expect(getPillLabel([events('a')])).toBe('1 monitor')
    expect(getPillLabel([events('a'), events('b')])).toBe('2 monitors')
  })

  test('tool calls read as MCP tasks', () => {
    expect(getPillLabel([call('a')])).toBe('1 MCP task')
    expect(getPillLabel([call('a'), call('b'), call('c')])).toBe('3 MCP tasks')
  })

  test('both kinds: monitors first, each counted on its own', () => {
    expect(getPillLabel([call('a'), events('b')])).toBe('1 monitor, 1 MCP task')
    expect(getPillLabel([events('a'), call('b'), events('c'), call('d')])).toBe('2 monitors, 2 MCP tasks')
  })

  test('beside another type, the generic count still wins', () => {
    expect(getPillLabel([call('a'), taskFixture('local_bash')])).toBe('2 background tasks')
  })
})
