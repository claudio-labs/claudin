// Characterization of the footer-pill label, pinned before monitor_mcp grows
// real MCP-backed kinds (events, long tool calls) and its own pill wording.
// The footer pill and the turn-duration transcript line both read this, so a
// change here shows up on two surfaces.

import { describe, expect, test } from 'bun:test'

import { getPillLabel } from 'src/agent/tasks/pillLabel.js'
import { TASK_TYPES, taskFixture } from 'src/agent/ui/tasks/__testutils__/taskFixtures.js'

const shell = (id: string) => taskFixture('local_bash', { id, kind: 'bash' })
const monitor = (id: string) => taskFixture('local_bash', { id, kind: 'monitor' })
const mcpMonitor = (id: string) => taskFixture('monitor_mcp', { id })
const teammate = (id: string, teamName: string) =>
  taskFixture('in_process_teammate', { id, identity: { agentName: id, teamName } })

describe('getPillLabel — one task of each type', () => {
  const single: Record<string, string> = {
    local_bash: '1 shell',
    remote_agent: '\u25c7 1 cloud session',
    local_agent: '1 local agent',
    in_process_teammate: '1 team',
    local_workflow: '1 background workflow',
    monitor_mcp: '1 monitor',
    dream: 'dreaming',
    rule_map: 'mapping',
    // No arm of their own: the generic fallback.
    container: '1 background task',
    mcp_server: '1 background task',
  }

  test('every fixture type has a pinned label', () => {
    expect(Object.keys(single).sort()).toEqual([...TASK_TYPES].sort())
  })

  for (const type of TASK_TYPES) {
    test(`${type}`, () => {
      expect(getPillLabel([taskFixture(type)])).toBe(single[type]!)
    })
  }
})

describe('getPillLabel — several tasks of one type', () => {
  test('plural counts per type', () => {
    expect(getPillLabel([shell('a'), shell('b')])).toBe('2 shells')
    expect(getPillLabel([taskFixture('local_agent', { id: 'a' }), taskFixture('local_agent', { id: 'b' })])).toBe(
      '2 local agents',
    )
    expect(
      getPillLabel([taskFixture('remote_agent', { id: 'a' }), taskFixture('remote_agent', { id: 'b' }), taskFixture('remote_agent', { id: 'c' })]),
    ).toBe('\u25c7 3 cloud sessions')
    expect(getPillLabel([taskFixture('local_workflow', { id: 'a' }), taskFixture('local_workflow', { id: 'b' })])).toBe(
      '2 background workflows',
    )
    expect(getPillLabel([mcpMonitor('a'), mcpMonitor('b')])).toBe('2 monitors')
    expect(getPillLabel([taskFixture('container', { id: 'a' }), taskFixture('container', { id: 'b' })])).toBe(
      '2 background tasks',
    )
  })

  test('dream and rule_map do not count', () => {
    expect(getPillLabel([taskFixture('dream', { id: 'a' }), taskFixture('dream', { id: 'b' })])).toBe('dreaming')
    expect(getPillLabel([taskFixture('rule_map', { id: 'a' }), taskFixture('rule_map', { id: 'b' })])).toBe('mapping')
  })

  test('teammates count distinct teams, not members', () => {
    expect(getPillLabel([teammate('ada', 'core'), teammate('bob', 'core')])).toBe('1 team')
    expect(getPillLabel([teammate('ada', 'core'), teammate('bob', 'infra'), teammate('cy', 'infra')])).toBe('2 teams')
  })
})

describe('getPillLabel — shells and monitors share local_bash', () => {
  test('monitors alone', () => {
    expect(getPillLabel([monitor('m1')])).toBe('1 monitor')
    expect(getPillLabel([monitor('m1'), monitor('m2')])).toBe('2 monitors')
  })

  test('shells first, then monitors, singular and plural independently', () => {
    expect(getPillLabel([shell('s1'), monitor('m1')])).toBe('1 shell, 1 monitor')
    expect(getPillLabel([monitor('m1'), shell('s1'), shell('s2')])).toBe('2 shells, 1 monitor')
    expect(getPillLabel([shell('s1'), monitor('m1'), monitor('m2'), monitor('m3')])).toBe('1 shell, 3 monitors')
  })

  test('a local_bash task with no kind counts as a shell', () => {
    expect(getPillLabel([taskFixture('local_bash', { kind: undefined }), monitor('m1')])).toBe('1 shell, 1 monitor')
  })
})

describe('getPillLabel — mixed types fall back to a count', () => {
  test('any two types', () => {
    expect(getPillLabel([shell('s1'), taskFixture('local_agent')])).toBe('2 background tasks')
    expect(getPillLabel([taskFixture('dream'), taskFixture('rule_map'), taskFixture('container')])).toBe(
      '3 background tasks',
    )
  })

  // A shell monitor and an MCP monitor both read "monitor" alone, but not together.
  test('a shell monitor beside a monitor_mcp task is not "2 monitors"', () => {
    expect(getPillLabel([monitor('m1'), mcpMonitor('m2')])).toBe('2 background tasks')
  })
})
