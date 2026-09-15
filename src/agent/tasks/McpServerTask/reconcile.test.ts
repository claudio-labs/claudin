import { describe, expect, test } from 'bun:test'
import {
  countToolsByServer,
  EMPTY_PATCH,
  mcpServerTaskId,
  reconcileMcpServers,
} from 'src/agent/tasks/McpServerTask/reconcile.js'
import type { McpServerTaskState } from 'src/agent/tasks/McpServerTask/types.js'
import type { TaskState } from 'src/agent/tasks/types.js'
import type { MCPServerConnection } from 'src/mcp/types.js'

const NOW = 1_000

// Only the fields the reducer reads. Cast through unknown because a connected
// server also carries a live SDK Client, which nothing here touches.
function client(
  name: string,
  type: MCPServerConnection['type'],
  over: Record<string, unknown> = {},
): MCPServerConnection {
  return {
    name,
    type,
    config: { type: 'stdio', command: 'run-it', args: [], scope: 'project' },
    ...over,
  } as unknown as MCPServerConnection
}

function asRecord(...tasks: McpServerTaskState[]): Record<string, TaskState> {
  return Object.fromEntries(tasks.map(t => [t.id, t]))
}

const NO_COUNTS = new Map<string, number>()

function reconcile(
  tasks: Record<string, TaskState>,
  clients: MCPServerConnection[],
  tools: ReadonlyMap<string, number> = NO_COUNTS,
  resources: ReadonlyMap<string, number> = NO_COUNTS,
  now = NOW,
) {
  return reconcileMcpServers(tasks, clients, tools, resources, now)
}

describe('countToolsByServer', () => {
  test('counts by the mcp__server__ prefix the tool pool is keyed on', () => {
    const tools = [
      { name: 'mcp__github__create_issue' },
      { name: 'mcp__github__list_repos' },
      { name: 'mcp__sentry__list_issues' },
      { name: 'Bash' },
    ]
    const counts = countToolsByServer(tools, ['github', 'sentry', 'linear'])
    expect(counts.get('github')).toBe(2)
    expect(counts.get('sentry')).toBe(1)
  })

  test('a server with no tools is zero, not absent', () => {
    // The row prints the number, so "no entry" and "zero" must not be the same
    // lookup failure.
    const counts = countToolsByServer([], ['linear'])
    expect(counts.get('linear')).toBe(0)
  })

  test('a nameless tool is skipped rather than counted against the first server', () => {
    const counts = countToolsByServer([{}, { name: 'mcp__a__x' }], ['a'])
    expect(counts.get('a')).toBe(1)
  })
})

describe('reconcileMcpServers', () => {
  test('registers a row per live server', () => {
    const patch = reconcile({}, [
      client('github', 'connected'),
      client('sentry', 'failed', { error: 'connection refused' }),
    ])
    expect(patch.register.map(t => t.serverName)).toEqual(['github', 'sentry'])
    expect(patch.register[0]!.id).toBe(mcpServerTaskId('github'))
    expect(patch.update).toEqual([])
    expect(patch.remove).toEqual([])
  })

  test('a server already disabled when we first look never gets a row', () => {
    const patch = reconcile({}, [client('slack', 'disabled')])
    expect(patch).toBe(EMPTY_PATCH)
  })

  test('but one disabled AFTER it had a row keeps it — that is a disconnect', () => {
    const first = reconcile({}, [client('slack', 'connected')])
    const row = first.register[0]!
    const second = reconcile(asRecord(row), [client('slack', 'disabled')])
    expect(second.remove).toEqual([])
    expect(second.update).toHaveLength(1)
    expect(second.update[0]!.connectionType).toBe('disabled')
  })

  test('every row is a running task — a failed server must still be listed', () => {
    // isBackgroundTask drops anything that is not running or pending, so
    // spelling the failure in the task status would delete the row reporting it.
    const patch = reconcile({}, [client('sentry', 'failed')])
    expect(patch.register[0]!.status).toBe('running')
  })

  test('an unchanged snapshot produces no patch at all', () => {
    const first = reconcile({}, [client('github', 'connected')])
    const second = reconcile(asRecord(first.register[0]!), [
      client('github', 'connected'),
    ])
    expect(second).toBe(EMPTY_PATCH)
  })

  test('a state transition is an update, not a new row', () => {
    const first = reconcile({}, [client('github', 'pending')])
    const row = first.register[0]!
    const second = reconcile(asRecord(row), [client('github', 'connected')])
    expect(second.register).toEqual([])
    expect(second.update).toHaveLength(1)
    expect(second.update[0]!.id).toBe(row.id)
    expect(second.update[0]!.connectionType).toBe('connected')
  })

  test('a reconnect keeps the row where it was in the tree', () => {
    // startTime is the tree's sort key; re-dating it on every retry would make
    // a flapping server jump under the user's cursor.
    const first = reconcile({}, [client('github', 'connected')], NO_COUNTS, NO_COUNTS, 100)
    const row = first.register[0]!
    const second = reconcile(
      asRecord(row),
      [client('github', 'pending', { reconnectAttempt: 2, maxReconnectAttempts: 5 })],
      NO_COUNTS,
      NO_COUNTS,
      9_999,
    )
    expect(second.update[0]!.startTime).toBe(100)
    expect(second.update[0]!.reconnectAttempt).toBe(2)
  })

  test('a changed tool count alone is enough to update the row', () => {
    const first = reconcile({}, [client('github', 'connected')], new Map([['github', 3]]))
    const second = reconcile(
      asRecord(first.register[0]!),
      [client('github', 'connected')],
      new Map([['github', 12]]),
    )
    expect(second.update[0]!.toolCount).toBe(12)
  })

  test('a server that left the config is removed', () => {
    const first = reconcile({}, [client('github', 'connected')])
    const second = reconcile(asRecord(first.register[0]!), [])
    expect(second.remove).toEqual([mcpServerTaskId('github')])
  })

  test('non-MCP tasks in the map are left entirely alone', () => {
    const shell = { id: 'b1', type: 'local_bash', status: 'running' } as unknown as TaskState
    const patch = reconcile({ b1: shell }, [])
    expect(patch).toBe(EMPTY_PATCH)
  })

  test('carries the transport, the scope and the handshake through', () => {
    const patch = reconcile({}, [
      client('github', 'connected', {
        config: { type: 'http', url: 'https://x', scope: 'user' },
        serverInfo: { name: 'github-mcp', version: '1.4.0' },
      }),
    ])
    const row = patch.register[0]!
    expect(row.transport).toBe('http')
    expect(row.scope).toBe('user')
    expect(row.serverInfo).toEqual({ name: 'github-mcp', version: '1.4.0' })
  })

  test('a stdio entry with no explicit type still reads as stdio', () => {
    // McpStdioServerConfigSchema makes `type` optional for backwards
    // compatibility, so an entry with just a command has none.
    const patch = reconcile({}, [
      client('local', 'connected', { config: { command: 'run-it', args: [], scope: 'local' } }),
    ])
    expect(patch.register[0]!.transport).toBe('stdio')
  })

  test('an error is kept only while the server is failed', () => {
    const failed = reconcile({}, [client('sentry', 'failed', { error: 'boom' })])
    expect(failed.register[0]!.error).toBe('boom')
    const recovered = reconcile(asRecord(failed.register[0]!), [
      client('sentry', 'connected'),
    ])
    expect(recovered.update[0]!.error).toBeNull()
  })
})
