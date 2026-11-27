// monitor_mcp has two kinds, and the footer lists them apart: an MCP event
// stream joins the shell Monitors, a backgrounded MCP tool call gets its own
// "MCP tasks" group right after them.

import { describe, expect, test } from 'bun:test'
import type { TaskState } from 'src/agent/tasks/types.js'
import {
  countFooterTaskRows,
  FOOTER_GROUP_LABELS,
  FOOTER_GROUP_ORDER,
  getFooterGroupCounts,
  matchGroupKey,
} from 'src/agent/ui/tasks/footerTaskGeometry.js'
import { taskFixture } from 'src/agent/ui/tasks/__testutils__/taskFixtures.js'

const events = (id: string) => taskFixture('monitor_mcp', { id, kind: 'events' }) as TaskState
const call = (id: string) => taskFixture('monitor_mcp', { id, kind: 'call' }) as TaskState
const shellMonitor = (id: string) => taskFixture('local_bash', { id, kind: 'monitor' }) as TaskState

const asRecord = (...tasks: TaskState[]) => Object.fromEntries(tasks.map(t => [t.id, t]))

describe('matchGroupKey for monitor_mcp', () => {
  test('an event stream is a monitor, a tool call is an MCP task', () => {
    expect(matchGroupKey(events('m1'))).toBe('monitors')
    expect(matchGroupKey(call('m2'))).toBe('mcpTasks')
  })

  // Rows written before the kinds existed carry none; they were monitors.
  test('a row with no kind stays a monitor', () => {
    expect(matchGroupKey(taskFixture('monitor_mcp', { kind: undefined }) as TaskState)).toBe('monitors')
  })
})

describe('the MCP tasks group', () => {
  test('sits right after monitors, labelled "MCP tasks"', () => {
    const at = FOOTER_GROUP_ORDER.indexOf('mcpTasks')
    expect(FOOTER_GROUP_ORDER[at - 1]).toBe('monitors')
    expect(FOOTER_GROUP_LABELS.mcpTasks).toBe('MCP tasks')
  })

  test('counts calls apart from every monitor', () => {
    const tasks = asRecord(shellMonitor('b1'), events('m1'), call('m2'), call('m3'))
    const counts = getFooterGroupCounts(tasks, undefined)
    expect(counts.get('monitors')).toBe(2)
    expect(counts.get('mcpTasks')).toBe(2)
  })

  test('adds its own header row, and collapses on its own key', () => {
    const tasks = asRecord(events('m1'), call('m2'), call('m3'))
    // monitors header + 1, MCP tasks header + 2.
    expect(countFooterTaskRows(tasks, undefined, [])).toBe(5)
    expect(countFooterTaskRows(tasks, undefined, ['mcpTasks'])).toBe(3)
  })
})
