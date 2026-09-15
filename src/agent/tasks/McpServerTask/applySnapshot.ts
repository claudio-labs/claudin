// The AppState side of the MCP panel.
//
// Unlike every other task type, nothing here spawns a process — and unlike the
// container panel, nothing here shells out either. `AppState.mcp` is already the
// connection state's home; this module only folds it into `AppState.tasks` so
// the footer tree, the cursor and the `x` key see MCP servers as rows like any
// other background work. The decision of what changed lives in the pure reducer
// next door (`reconcile.ts`).
//
// There is deliberately NO `Task` registry entry (`src/agent/tasks.ts`) to go
// with these rows. `getTaskByType` is what `stopTask` — the model-facing
// TaskStop tool and the SDK stop_task request — dispatches through, and an MCP
// server is the user's configuration, not this session's subprocess. Leaving it
// unregistered makes TaskStop answer `unsupported_type`, which is the right
// answer. Disconnecting is a keystroke behind a confirmation dialog, exactly as
// it is for a container.

import type { AppState } from 'src/terminal/state/AppState.js'
import type { SetAppState } from 'src/agent/Task.js'
import type { MCPServerConnection } from 'src/mcp/types.js'
import type { McpServerTaskState } from 'src/agent/tasks/McpServerTask/types.js'
import { isMcpServerTask } from 'src/agent/tasks/McpServerTask/types.js'
import {
  countToolsByServer,
  reconcileMcpServers,
} from 'src/agent/tasks/McpServerTask/reconcile.js'
import { registerTask, updateTaskState } from 'src/agent/tasks/framework.js'

/**
 * Apply a fresh view of `AppState.mcp` to the rows. Returns the number of rows
 * that changed, so the caller can skip a re-render when nothing did.
 */
export function applyMcpSnapshot(
  getAppState: () => AppState,
  setAppState: SetAppState,
  clients: readonly MCPServerConnection[],
  tools: readonly { name?: string }[],
  resources: Readonly<Record<string, readonly unknown[]>>,
  now: number = Date.now(),
): number {
  const serverNames = clients.map(c => c.name)
  const toolCounts = countToolsByServer(tools, serverNames)
  const resourceCounts = new Map<string, number>()
  for (const name of serverNames) {
    resourceCounts.set(name, resources[name]?.length ?? 0)
  }

  const patch = reconcileMcpServers(
    getAppState().tasks ?? {},
    clients,
    toolCounts,
    resourceCounts,
    now,
  )
  const changed =
    patch.register.length + patch.update.length + patch.remove.length
  if (changed === 0) return 0

  for (const task of patch.register) registerTask(task, setAppState)
  for (const task of patch.update) {
    updateTaskState<McpServerTaskState>(task.id, setAppState, () => task)
  }
  if (patch.remove.length > 0) {
    const removed = new Set(patch.remove)
    setAppState(prev => {
      const next: AppState['tasks'] = {}
      let dropped = false
      for (const [id, task] of Object.entries(prev.tasks ?? {})) {
        if (removed.has(id) && isMcpServerTask(task)) {
          dropped = true
          continue
        }
        next[id] = task
      }
      return dropped ? { ...prev, tasks: next } : prev
    })
  }
  return changed
}
