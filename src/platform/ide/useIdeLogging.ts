import { useEffect } from 'react'
import { z } from 'zod/v4'
import type { MCPServerConnection } from 'src/mcp/types.js'
import { getConnectedIdeClient } from 'src/platform/ide/ide.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'

const LogEventParamsSchema = lazySchema(() =>
  z.object({
    eventName: z.string(),
    eventData: z.object({}).passthrough(),
  }),
)

export function useIdeLogging(mcpClients: MCPServerConnection[]): void {
  useEffect(() => {
    // Skip if there are no clients
    if (!mcpClients.length) {
      return
    }

    // Find the IDE client from the MCP clients list
    const ideClient = getConnectedIdeClient(mcpClients)
    if (ideClient) {
      // Register the log event handler
      ideClient.client.setNotificationHandler(
        'log_event',
        { params: LogEventParamsSchema() },
        params => {
          const { eventName, eventData } = params
        },
      )
    }
  }, [mcpClients])
}
