import { describe, expect, test } from 'bun:test'
import { killBackgroundTask } from 'src/agent/ui/tasks/taskActions.js'
import type { McpServerTaskState } from 'src/agent/tasks/McpServerTask/types.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'

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

/** Minimal AppState stand-in: only the field the MCP arm writes. */
function makeState(): {
  setAppState: (updater: (prev: AppState) => AppState) => void
  current: () => AppState
} {
  let state = { pendingMcpDisconnect: null } as unknown as AppState
  return {
    setAppState: updater => {
      state = updater(state)
    },
    current: () => state,
  }
}

describe('killBackgroundTask on an MCP row', () => {
  test('parks a confirmation instead of disconnecting', () => {
    // The guard this pins: every other arm calls a `kill` that acts
    // immediately. If this arm ever gains a direct disconnect call, `x` drops
    // the user's MCP server — and its tools, mid-conversation — with no prompt.
    const { setAppState, current } = makeState()
    killBackgroundTask(task(), setAppState)
    expect(current().pendingMcpDisconnect).toEqual({
      taskId: 'mcp_github',
      serverName: 'github',
      toolCount: 12,
    })
  })

  test('offers nothing on a server that is not connected', () => {
    // The task status is `running` in every connection state, so this cannot
    // ride on the status guard the other arms use.
    for (const connectionType of ['pending', 'failed', 'needs-auth', 'disabled'] as const) {
      const { setAppState, current } = makeState()
      killBackgroundTask(task({ connectionType }), setAppState)
      expect(current().pendingMcpDisconnect).toBeNull()
    }
  })

  test('carries the tool count so the dialog can say what goes away', () => {
    const { setAppState, current } = makeState()
    killBackgroundTask(task({ toolCount: 3 }), setAppState)
    expect(current().pendingMcpDisconnect?.toolCount).toBe(3)
  })
})
