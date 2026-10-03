import type { MCPServerConnection } from 'src/mcp/types.js'
import type { DiffTool } from 'src/platform/config/config.js'
import { hasAccessToIDEExtensionDiffFeature } from 'src/platform/ide/ide.js'

export type IdeDiffGateInput = {
  mcpClients: MCPServerConnection[]
  diffTool: DiffTool | undefined
  filePath: string
}

/**
 * Whether a proposed edit goes to the IDE as a diff tab. An empty path is the
 * dialog's placeholder for a tool that has no IDE diff (spec, finding 2), and
 * notebooks have no text diff an editor could show.
 */
export function isIdeDiffAvailable({ mcpClients, diffTool, filePath }: IdeDiffGateInput): boolean {
  if (filePath === '' || filePath.endsWith('.ipynb')) return false
  if ((diffTool ?? 'auto') !== 'auto') return false
  return hasAccessToIDEExtensionDiffFeature(mcpClients)
}
