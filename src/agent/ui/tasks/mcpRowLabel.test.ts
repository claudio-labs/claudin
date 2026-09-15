import { describe, expect, test } from 'bun:test'
import figures from 'figures'
import {
  mcpRowBody,
  mcpRowGlyph,
  mcpRowLabel,
  mcpRowTone,
} from 'src/agent/ui/tasks/mcpRowLabel.js'
import type { McpServerTaskState } from 'src/agent/tasks/McpServerTask/types.js'

function task(over: Partial<McpServerTaskState> = {}): McpServerTaskState {
  return {
    id: 'mcp_github',
    type: 'mcp_server',
    status: 'running',
    description: 'github',
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    serverName: 'github',
    connectionType: 'connected',
    transport: 'http',
    scope: 'project',
    toolCount: 12,
    resourceCount: 0,
    serverInfo: null,
    error: null,
    ...over,
  }
}

describe('mcpRowGlyph', () => {
  test('gives needs-auth its own shape, not the idle one', () => {
    // Colour alone cannot carry it: amber covers three states, and a terminal
    // without colour would show three identical rows.
    expect(mcpRowGlyph(task({ connectionType: 'needs-auth' }))).toBe(
      figures.triangleUpOutline,
    )
    expect(mcpRowGlyph(task({ connectionType: 'pending' }))).toBe(figures.radioOff)
  })

  test('connected and failed are the tick and the cross', () => {
    expect(mcpRowGlyph(task())).toBe(figures.tick)
    expect(mcpRowGlyph(task({ connectionType: 'failed' }))).toBe(figures.cross)
  })
})

describe('mcpRowTone', () => {
  test('green connected, amber waiting, red failed', () => {
    expect(mcpRowTone(task())).toBe('success')
    expect(mcpRowTone(task({ connectionType: 'pending' }))).toBe('warning')
    expect(mcpRowTone(task({ connectionType: 'needs-auth' }))).toBe('warning')
    expect(mcpRowTone(task({ connectionType: 'disabled' }))).toBe('warning')
    expect(mcpRowTone(task({ connectionType: 'failed' }))).toBe('error')
  })
})

describe('mcpRowBody', () => {
  test('a connected server leads with its tool count', () => {
    expect(mcpRowBody(task())).toBe('github · connected · 12 tools')
  })

  test('one tool is singular', () => {
    expect(mcpRowBody(task({ toolCount: 1 }))).toBe('github · connected · 1 tool')
  })

  test('a tool-less server falls back to its resources', () => {
    expect(mcpRowBody(task({ toolCount: 0, resourceCount: 3 }))).toBe(
      'github · connected · 3 resources',
    )
  })

  test('a server contributing nothing says only that it is connected', () => {
    expect(mcpRowBody(task({ toolCount: 0, resourceCount: 0 }))).toBe(
      'github · connected',
    )
  })

  test('only a connected server advertises what it contributes', () => {
    // The pool still holds a failed server's tools for a moment; claiming it
    // offers 12 of them while it is down is the one thing the row must not do.
    expect(
      mcpRowBody(task({ connectionType: 'failed', toolCount: 12 })),
    ).not.toContain('12 tools')
  })

  test('a retry reports which attempt it is on', () => {
    expect(
      mcpRowBody(
        task({
          connectionType: 'pending',
          reconnectAttempt: 2,
          maxReconnectAttempts: 5,
        }),
      ),
    ).toBe('github · reconnecting (2/5)…')
  })

  test('a disconnected row does not claim to be disabled', () => {
    expect(mcpRowBody(task({ connectionType: 'disabled' }))).toBe(
      'github · disconnected',
    )
  })

  test('a failure carries its first line and nothing more', () => {
    expect(
      mcpRowBody(
        task({ connectionType: 'failed', error: 'connection refused\n  at foo()\n  at bar()' }),
      ),
    ).toBe('github · failed · connection refused')
  })

  test('a long failure is cut rather than allowed to fill the footer', () => {
    const body = mcpRowBody(
      task({ connectionType: 'failed', error: 'x'.repeat(500) }),
    )
    expect(body.length).toBeLessThan(120)
    expect(body).toContain('…')
  })

  test('an empty error message adds no trailing separator', () => {
    expect(mcpRowBody(task({ connectionType: 'failed', error: '   ' }))).toBe(
      'github · failed',
    )
  })
})

describe('mcpRowLabel', () => {
  test('is the glyph and the body, on one line', () => {
    const label = mcpRowLabel(task())
    expect(label).toBe(`${figures.tick} github · connected · 12 tools`)
    expect(label).not.toContain('\n')
  })
})
