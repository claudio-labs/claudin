// Presentation helpers shared by the footer row and the Container tool's
// result renderer.
//
// They live in the container slice rather than beside either consumer because
// both need them and neither owns them: a name-shortening rule that differed
// between the panel and the tool would make the same container read as two
// different things on one screen.

import type { ContainerInfo } from 'src/containers/types.js'

/**
 * Compose names a container `<project>-<service>-<n>`. Dropping the project
 * prefix keeps a row short while still telling two replicas apart, which the
 * bare service name would not.
 */
export function shortContainerName(c: ContainerInfo): string {
  if (c.project && c.name.startsWith(`${c.project}-`)) {
    return c.name.slice(c.project.length + 1)
  }
  return c.name
}

/** Published host ports as `:8000 :8989`. Empty when nothing is published. */
export function portSummary(c: ContainerInfo): string {
  const published = c.ports
    .map(p => p.hostPort)
    .filter((p): p is number => p !== null)
  if (published.length === 0) return ''
  return [...new Set(published)].sort((a, b) => a - b).map(p => `:${p}`).join(' ')
}

/**
 * The state word for a container, restart count folded in.
 *
 * `healthy` is worth saying because it means a healthcheck actually passed;
 * `none` is the common case and printing it on every row would be noise. The
 * distinction matters — claiming health that was never measured is the one
 * thing this must not do.
 */
export function formatContainerState(
  c: ContainerInfo,
  restartCount = 0,
): string {
  switch (c.state) {
    case 'running':
      if (c.health === 'healthy') return 'healthy'
      if (c.health === 'unhealthy') return 'unhealthy'
      if (c.health === 'starting') return 'starting'
      return 'up'
    case 'restarting':
      return restartCount > 1 ? `restarting x${restartCount}` : 'restarting'
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
