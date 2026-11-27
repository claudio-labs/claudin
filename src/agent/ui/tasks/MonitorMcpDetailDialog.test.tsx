import { describe, expect, test } from 'bun:test'
import * as React from 'react'

import type { MonitorMcpTaskState } from 'src/agent/tasks/MonitorMcpTask/MonitorMcpTask.js'
import {
  MonitorMcpDetail,
  MonitorMcpDetailDialog,
  monitorMcpDetailKeyAction,
  monitorMcpStatusLine,
} from 'src/agent/ui/tasks/MonitorMcpDetailDialog.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider, getDefaultAppState } from 'src/terminal/state/AppState.js'

type OutputTail = { content: string; bytesTotal: number }

/** A promise React's `use()` reads synchronously, so the static frame has the output. */
function settled(value: OutputTail): Promise<OutputTail> {
  return Object.assign(Promise.resolve(value), { status: 'fulfilled', value })
}

function task(over: Partial<MonitorMcpTaskState> = {}): MonitorMcpTaskState {
  return {
    id: 'mdlg00001',
    type: 'monitor_mcp',
    kind: 'call',
    serverName: 'indexer',
    status: 'running',
    description: 'Index the repo',
    startTime: 1_000,
    outputFile: '/nonexistent/mdlg00001.output',
    outputOffset: 0,
    notified: false,
    ...over,
  }
}

const flat = (s: string) => s.replace(/\s+/g, ' ')

async function renderDetail(t: MonitorMcpTaskState, output: OutputTail, onKill?: () => void): Promise<string> {
  return renderToString(
    <AppStateProvider>
      <MonitorMcpDetail task={t} onKill={onKill} onBack={() => {}} outputPromise={settled(output)} columns={80} />
    </AppStateProvider>,
    80,
  )
}

describe('monitorMcpStatusLine', () => {
  test('status and runtime, then the progress line', () => {
    expect(monitorMcpStatusLine(task({ statusMessage: 'indexing 40%' }), 4_000)).toBe('running · 3s · indexing 40%')
  })

  test('a finished task counts to its end, and has no progress line to show', () => {
    expect(monitorMcpStatusLine(task({ status: 'completed', endTime: 3_000 }), 99_000)).toBe('completed · 2s')
  })
})

describe('monitorMcpDetailKeyAction', () => {
  test('Space and left go back', () => {
    expect(monitorMcpDetailKeyAction(' ', false)).toBe('back')
    expect(monitorMcpDetailKeyAction('left', true)).toBe('back')
  })

  test('x stops only what can be stopped', () => {
    expect(monitorMcpDetailKeyAction('x', true)).toBe('stop')
    expect(monitorMcpDetailKeyAction('x', false)).toBeNull()
  })

  test('any other key is left alone', () => {
    expect(monitorMcpDetailKeyAction('k', true)).toBeNull()
  })
})

describe('MonitorMcpDetail', () => {
  test('a call: title, kind and server, status, and the output tail', async () => {
    const content = 'scanned src/\nscanned test/\n'
    const out = flat(await renderDetail(task({ statusMessage: 'indexing 40%' }), { content, bytesTotal: content.length }, () => {}))
    expect(out).toContain('Index the repo')
    expect(out).toContain('MCP task · indexer')
    expect(out).toMatch(/running · \d+[a-z0-9 ]* · indexing 40%/)
    expect(out).toContain('scanned test/')
    expect(out).toContain('Showing 2 lines')
    expect(out).toContain('go back')
    expect(out).toContain('x to stop')
  })

  test('an events monitor names its kind', async () => {
    const out = flat(await renderDetail(task({ kind: 'events', description: 'CI failures' }), { content: '', bytesTotal: 0 }))
    expect(out).toContain('events monitor · indexer')
    expect(out).toContain('No output available')
  })

  test('no stop hint once it ended', async () => {
    const ended = flat(await renderDetail(task({ status: 'completed', endTime: 2_000 }), { content: '', bytesTotal: 0 }, () => {}))
    expect(ended).toContain('completed')
    expect(ended).not.toContain('stop')
  })

  test('no stop hint with nothing to stop it', async () => {
    const noKill = flat(await renderDetail(task(), { content: '', bytesTotal: 0 }))
    expect(noKill).toContain('running')
    expect(noKill).not.toContain('stop')
  })
})

describe('MonitorMcpDetailDialog', () => {
  test('renders over the real output read, and pins the task while open', async () => {
    const t = task({ status: 'completed', endTime: 2_000, notified: true })
    const pinned: unknown[] = []
    const state = { ...getDefaultAppState(), tasks: { [t.id]: t } }
    const out = flat(
      await renderToString(
        <AppStateProvider
          initialState={state as never}
          onChangeAppState={({ newState }) => {
            pinned.push(newState.tasks[t.id]?.displayUntil)
          }}
        >
          <MonitorMcpDetailDialog task={t} onBack={() => {}} />
        </AppStateProvider>,
        80,
      ),
    )
    expect(out).toContain('Index the repo')
    expect(out).toContain('MCP task · indexer')
    expect(pinned).toContain(Number.POSITIVE_INFINITY)
  })
})
