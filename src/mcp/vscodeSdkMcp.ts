import { errorMessage } from 'src/shared/errors.js'
import { logForDebugging } from 'src/shared/debug.js'
import type { MCPServerConnection } from 'src/mcp/types.js'
import { createVscodeChannel } from 'src/mcp/vscodeChannel.js'

// One channel per process: the edit tools that notify have no handle to pass.
// A server that closed stays chosen until an SDK update brings a connected one.
const channel = createVscodeChannel({
  onSendFailure: error => logForDebugging(`[vscode] file_updated notification failed: ${errorMessage(error)}`),
})

export function notifyVscodeFileUpdated(
  filePath: string,
  oldContent: string | null,
  newContent: string | null,
): void {
  channel.fileUpdated(filePath, oldContent, newContent)
}

export function setupVscodeSdkMcp(sdkClients: MCPServerConnection[]): void {
  channel.adopt(sdkClients)
}
