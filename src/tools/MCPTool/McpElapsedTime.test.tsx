import { describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { Text } from 'src/terminal/ink.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import type { MCPProgress } from 'src/shared/types/tools.js'
import { McpGroupElapsedTime, mcpBatchSpan } from 'src/tools/MCPTool/McpElapsedTime.js'

function tick(fields: Partial<MCPProgress>): MCPProgress {
  return {
    type: 'mcp_progress',
    status: 'started',
    serverName: 'context7',
    toolName: 'query-docs',
    ...fields,
  }
}

function render(node: React.ReactNode): Promise<string> {
  // Lives inside the header's <Text>, which is what lets it emit a bare " · ".
  return renderToString(<Text>{node}</Text>).then(stripAnsi)
}

describe('mcpBatchSpan', () => {
  test('stays open from the earliest start while any call runs', () => {
    const span = mcpBatchSpan([
      { tick: tick({ status: 'completed', startedAt: 1_000, elapsedTimeMs: 500 }), running: false },
      { tick: tick({ status: 'progress', startedAt: 1_600 }), running: true },
    ])
    expect(span).toEqual({ startedAt: 1_000 })
  })

  test('closes at the last end once every call finished', () => {
    const span = mcpBatchSpan([
      { tick: tick({ status: 'completed', startedAt: 1_000, elapsedTimeMs: 9_000 }), running: false },
      { tick: tick({ status: 'failed', startedAt: 2_000, elapsedTimeMs: 3_000 }), running: false },
    ])
    expect(span).toEqual({ startedAt: 1_000, endedAt: 10_000 })
  })

  test('a call that stopped without finishing leaves no span', () => {
    const span = mcpBatchSpan([
      { tick: tick({ status: 'completed', startedAt: 1_000, elapsedTimeMs: 500 }), running: false },
      { tick: tick({ status: 'started', startedAt: 1_600 }), running: false },
    ])
    expect(span).toBeUndefined()
  })

  test('no start time, no span', () => {
    expect(mcpBatchSpan([{ tick: tick({}), running: true }])).toBeUndefined()
    expect(mcpBatchSpan([])).toBeUndefined()
  })
})

describe('McpGroupElapsedTime', () => {
  test('ticks from the real start on the first frame', async () => {
    const out = await render(<McpGroupElapsedTime startedAt={Date.now() - 69_000} />)
    expect(out).toContain('· 1m 9s')
  })

  test('freezes at the span once the batch ended', async () => {
    // Started long ago: a live clock would read hours, the span reads 14s.
    const out = await render(<McpGroupElapsedTime startedAt={0} endedAt={14_400} />)
    expect(out).toContain('· 14s')
  })

  test('renders nothing until the batch is worth waiting on', async () => {
    const live = await render(<McpGroupElapsedTime startedAt={Date.now() - 1_000} />)
    expect(live.trim()).toBe('')
    const frozen = await render(<McpGroupElapsedTime startedAt={0} endedAt={1_900} />)
    expect(frozen.trim()).toBe('')
  })
})
