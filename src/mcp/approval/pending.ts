import { getMcpConfigsByScope } from 'src/mcp/config.js'
import type { ProjectServerStatus } from 'src/mcp/projectServerStatus.js'
import { getProjectMcpServerStatus } from 'src/mcp/utils.js'

export type PendingDeps = {
  /** The project scope's server names, farthest `.mcp.json` first. */
  projectServerNames(): string[]
  statusOf(name: string): ProjectServerStatus
}

const liveDeps: PendingDeps = {
  projectServerNames: () => Object.keys(getMcpConfigsByScope('project').servers),
  statusOf: getProjectMcpServerStatus,
}

/** The project servers nobody has approved or rejected yet, in project-scope order. */
export function pendingProjectServers(deps: PendingDeps = liveDeps): string[] {
  return deps.projectServerNames().filter(name => deps.statusOf(name) === 'pending')
}
