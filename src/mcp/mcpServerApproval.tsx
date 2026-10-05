import React from 'react'
import { pendingProjectServers } from 'src/mcp/approval/pending.js'
import { MCPServerApprovalDialog } from 'src/mcp/ui/MCPServerApprovalDialog.js'
import { MCPServerMultiselectDialog } from 'src/mcp/ui/MCPServerMultiselectDialog.js'
import type { Root } from 'src/terminal/ink.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'

/**
 * Asks about the project's `.mcp.json` servers that are still pending, and
 * settles once the user has answered. The root is left mounted for the caller.
 */
export async function handleMcpjsonServerApprovals(root: Root): Promise<void> {
  const pending = pendingProjectServers()
  if (pending.length === 0) return

  await new Promise<void>(resolve => {
    const dialog =
      pending.length === 1 ? (
        <MCPServerApprovalDialog serverName={pending[0]!} onDone={resolve} />
      ) : (
        <MCPServerMultiselectDialog serverNames={pending} onDone={resolve} />
      )
    root.render(
      <AppStateProvider>
        <KeybindingSetup>{dialog}</KeybindingSetup>
      </AppStateProvider>,
    )
  })
}
