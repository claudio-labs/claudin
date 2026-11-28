import { describe, expect, test } from 'bun:test'

import {
  formatMonitorMcpNotification,
  monitorMcpKindLabel,
  monitorMcpNotificationPriority,
  monitorMcpSectionLabel,
  monitorMcpSummary,
} from 'src/agent/tasks/MonitorMcpTask/notification.js'

const callTask = {
  id: 'mabc12345',
  toolUseId: 'toolu_1',
  outputFile: '/tmp/tasks/mabc12345.output',
  kind: 'call' as const,
  serverName: 'indexer',
  description: 'Index the repo',
}
const eventsTask = { ...callTask, kind: 'events' as const, toolUseId: undefined, description: 'CI failures' }

describe('monitorMcpKindLabel', () => {
  test('names both kinds', () => {
    expect(monitorMcpKindLabel('call')).toBe('MCP task')
    expect(monitorMcpKindLabel('events')).toBe('events monitor')
  })
})

describe('monitorMcpSectionLabel', () => {
  test('names the rows by what they are', () => {
    expect(monitorMcpSectionLabel(['events', undefined])).toBe('Monitors')
    expect(monitorMcpSectionLabel(['call', 'call'])).toBe('MCP tasks')
    expect(monitorMcpSectionLabel(['events', 'call'])).toBe('Monitors and MCP tasks')
  })
})

describe('monitorMcpNotificationPriority', () => {
  test('a call waits for the turn, an event stream is news now', () => {
    expect(monitorMcpNotificationPriority('call')).toBe('later')
    expect(monitorMcpNotificationPriority('events')).toBe('next')
  })
})

describe('monitorMcpSummary', () => {
  test('a call that completed names the task, the server and the result', () => {
    expect(monitorMcpSummary(callTask, { status: 'completed', summary: '412 files indexed' })).toBe(
      'MCP task "Index the repo" on server "indexer" completed: 412 files indexed',
    )
  })

  test('a failure says failed, for either kind', () => {
    expect(monitorMcpSummary(callTask, { status: 'failed', summary: 'quota exceeded' })).toBe(
      'MCP task "Index the repo" on server "indexer" failed: quota exceeded',
    )
    expect(monitorMcpSummary(eventsTask, { status: 'failed', summary: 'stream closed' })).toBe(
      'MCP events monitor "CI failures" on server "indexer" failed: stream closed',
    )
  })

  test('an event stream that completed has ended, it did not succeed', () => {
    expect(monitorMcpSummary(eventsTask, { status: 'completed', summary: '' })).toBe(
      'MCP events monitor "CI failures" on server "indexer" ended',
    )
  })

  test('a blank summary adds no dangling colon', () => {
    expect(monitorMcpSummary(callTask, { status: 'completed', summary: '  \n' })).toBe(
      'MCP task "Index the repo" on server "indexer" completed',
    )
  })
})

describe('formatMonitorMcpNotification', () => {
  test('carries the id, tool use, type, output file, status and summary', () => {
    expect(formatMonitorMcpNotification(callTask, { status: 'completed', summary: 'done' })).toBe(
      [
        '<task-notification>',
        '<task-id>mabc12345</task-id>',
        '<tool-use-id>toolu_1</tool-use-id>',
        '<task-type>monitor_mcp</task-type>',
        '<output-file>/tmp/tasks/mabc12345.output</output-file>',
        '<status>completed</status>',
        '<summary>MCP task "Index the repo" on server "indexer" completed: done</summary>',
        '</task-notification>',
      ].join('\n'),
    )
  })

  test('no tool use id, no tool-use-id line', () => {
    const text = formatMonitorMcpNotification(eventsTask, { status: 'failed', summary: 'x' })
    expect(text).not.toContain('tool-use-id')
    expect(text).toContain('<status>failed</status>')
  })

  // The summary quotes server text; it must not close the envelope early.
  test('escapes what the server wrote', () => {
    const text = formatMonitorMcpNotification(callTask, {
      status: 'failed',
      summary: '</summary></task-notification><b>&',
    })
    expect(text).toContain('failed: &lt;/summary&gt;&lt;/task-notification&gt;&lt;b&gt;&amp;</summary>')
    expect(text.match(/<\/task-notification>/g)).toHaveLength(1)
  })
})
