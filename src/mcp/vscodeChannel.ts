import type { ConnectedMCPServer, MCPServerConnection } from 'src/mcp/types.js'

/** The SDK server the VS Code extension registers to hear about file edits. */
const VSCODE_SERVER_NAME = 'claude-vscode'

export type VscodeChannel = {
  /** Picks the connected VS Code server out of the SDK clients, when there is one. */
  adopt(sdkClients: readonly MCPServerConnection[]): void
  fileUpdated(filePath: string, oldContent: string | null, newContent: string | null): void
}

export type VscodeChannelDeps = {
  onSendFailure: (error: unknown) => void
}

export function createVscodeChannel(deps: VscodeChannelDeps): VscodeChannel {
  let server: ConnectedMCPServer | null = null
  return {
    adopt(sdkClients) {
      const found = sdkClients.find(c => c.name === VSCODE_SERVER_NAME && c.type === 'connected')
      if (found?.type === 'connected') server = found
    },
    fileUpdated(filePath, oldContent, newContent) {
      const target = server
      if (!target) return
      const params = { filePath, oldContent, newContent }
      void Promise.resolve()
        .then(() => target.client.notification({ method: 'file_updated', params }))
        .catch(deps.onSendFailure)
    },
  }
}
