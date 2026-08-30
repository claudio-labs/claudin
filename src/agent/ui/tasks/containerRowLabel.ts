// The one-line label for a container row in the footer tree.
//
// Returns ONE string on purpose. The tree paints each row as a single `<Text>`,
// and splitting a status line into sibling `<Text>`s turns it into independently
// wrapping columns rather than one flowing line (see .claudin/rules/ink-tui.md
// §10). Anything that needs its own colour has to be a nested `<Text>` inside
// that one, not a sibling.

import type { ContainerInfo } from 'src/containers/types.js'
import type { ContainerTaskState } from 'src/agent/tasks/ContainerTask/types.js'

const SEP = ' · '

/**
 * Compose names a container `<project>-<service>-<n>`. Dropping the project
 * prefix keeps the row short while still telling two replicas apart, which
 * using the bare service name would not.
 */
export function shortContainerName(c: ContainerInfo): string {
  if (c.project && c.name.startsWith(`${c.project}-`)) {
    return c.name.slice(c.project.length + 1)
  }
  return c.name
}

/** Published host ports, as `:8000 :8989`. Empty when nothing is published. */
export function portSummary(c: ContainerInfo): string {
  const published = c.ports
    .map(p => p.hostPort)
    .filter((p): p is number => p !== null)
  if (published.length === 0) return ''
  return [...new Set(published)].sort((a, b) => a - b).map(p => `:${p}`).join(' ')
}

function stateSummary(task: ContainerTaskState): string {
  const c = task.container
  switch (c.state) {
    case 'running':
      // `healthy` is worth saying because it means a healthcheck passed;
      // `none` is the common case and saying it every row would be noise.
      if (c.health === 'healthy') return 'healthy'
      if (c.health === 'unhealthy') return 'unhealthy'
      if (c.health === 'starting') return 'starting'
      return 'up'
    case 'restarting':
      return task.restartCount > 1
        ? `restarting x${task.restartCount}`
        : 'restarting'
    case 'paused':
      // Reads as running in `docker ps` but serves nothing.
      return 'paused'
    case 'created':
      return 'created'
    case 'removing':
      return 'removing'
    case 'dead':
      return 'dead'
    case 'exited':
      return c.exitCode === null ? 'exited' : `exited (${c.exitCode})`
  }
}

export function containerRowLabel(task: ContainerTaskState): string {
  const parts = [shortContainerName(task.container), stateSummary(task)]
  // Ports only matter while something is listening on them.
  if (task.container.state === 'running') {
    const ports = portSummary(task.container)
    if (ports) parts.push(ports)
  }
  return parts.join(SEP)
}
