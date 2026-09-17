// What the `x` key does on one footer task row: the verb the byline prints, and
// the guard the key itself dispatches through.
//
// Split out of `taskActions.ts` rather than living there, because that module
// cannot be imported by a unit test — its dispatch arms reach the task backends
// and kill subprocesses. This one imports two type guards and nothing else, so
// the byline can ask the question without paying for the machinery that
// answers it.

import { isContainerStoppable } from 'src/agent/tasks/ContainerTask/types.js'
import { isMcpServerDisconnectable } from 'src/agent/tasks/McpServerTask/types.js'
import type { BackgroundTaskState } from 'src/agent/tasks/types.js'
import type { DeepImmutable } from 'src/shared/types/utils.js'

/** The verb for the byline, or null when `x` would do nothing on this row. */
export type FooterRowAction = 'stop' | 'disconnect' | null

/**
 * Whether `x` has a target on this row, and what to call it.
 *
 * `status === 'running'` is the baseline, and two task types need more than it.
 * A container keeps a running task status through the grace period after it
 * dies; an MCP row keeps one in EVERY connection state, so a server that failed
 * to start and one still dialling both answered "running" and had `x` advertised
 * over them, where the key is a deliberate no-op.
 *
 * The wording is the other half: `x` does not stop an MCP server. The server is
 * the user's configuration, and what ends is this session's connection to it.
 */
export function footerRowAction(
  task: DeepImmutable<BackgroundTaskState>,
): FooterRowAction {
  if (task.status !== 'running') return null
  switch (task.type) {
    case 'container':
      return isContainerStoppable(task) ? 'stop' : null
    case 'mcp_server':
      return isMcpServerDisconnectable(task) ? 'disconnect' : null
    default:
      return 'stop'
  }
}
