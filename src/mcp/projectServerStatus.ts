import { normalizeNameForMCP } from 'src/mcp/normalization.js'

export type ProjectServerStatus = 'approved' | 'rejected' | 'pending'

/**
 * Everything the approval of a project `.mcp.json` server depends on, read
 * up front so the precedence below is a pure function of it.
 */
export type ProjectServerApprovalInputs = {
  /** `enabledMcpjsonServers` from the merged settings, every layer included. */
  enabledNames: readonly string[]
  /** `disabledMcpjsonServers` from the merged settings. */
  disabledNames: readonly string[]
  /** `enableAllProjectMcpServers` from the merged settings. */
  enableAll: boolean
  /**
   * Bypass mode accepted in a layer the repository cannot write: user, local,
   * `--settings` or managed. Never the project's own settings file.
   */
  bypassAcceptedOutsideProject: boolean
  interactive: boolean
  projectSettingsEnabled: boolean
}

/**
 * Names are compared folded, so `my.server` and `my_server` share one
 * decision. The merged lists include the project's own settings file, so a
 * repository can approve its own servers; the folder trust dialog is the gate
 * in front of that.
 */
export function decideProjectServerStatus(
  serverName: string,
  inputs: ProjectServerApprovalInputs,
): ProjectServerStatus {
  const folded = normalizeNameForMCP(serverName)
  const listed = (names: readonly string[]): boolean =>
    names.some(name => normalizeNameForMCP(name) === folded)

  if (listed(inputs.disabledNames)) return 'rejected'
  if (inputs.enableAll || listed(inputs.enabledNames)) return 'approved'
  if (!inputs.projectSettingsEnabled) return 'pending'
  if (inputs.bypassAcceptedOutsideProject || !inputs.interactive) {
    return 'approved'
  }
  return 'pending'
}
