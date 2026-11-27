/**
 * What a read of an MCP resource does besides reading: record which thread
 * read it and subscribe the connection to its changes, so the next request
 * of that thread can say it changed (resourceChanges.ts). Called by
 * ReadMcpResource and by an @-mentioned resource; never throws, and never
 * delays the read it follows.
 */
import { canSubscribeResources, subscribeResourceUpdates } from 'src/mcp/client/subscriptions.js'
import {
  getMcpResourceChanges,
  type McpResourceChanges,
  resourceNoticeThread,
} from 'src/mcp/resourceChanges.js'
import type { ConnectedMCPServer } from 'src/mcp/types.js'
import { errorMessage } from 'src/shared/errors.js'
import { logMCPError } from 'src/shared/log.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

export async function watchMcpResource(
  connection: Pick<ConnectedMCPServer, 'name' | 'client'>,
  uri: string,
  context: Pick<ToolUseContext, 'agentId' | 'omitClaudeMdAttachments'>,
  changes: McpResourceChanges = getMcpResourceChanges(),
): Promise<void> {
  const thread = resourceNoticeThread(context)
  if (thread === undefined) return
  const server = connection.name
  try {
    if (!canSubscribeResources(connection.client)) return
    // Before the subscribe goes out, so an update that beats its answer counts.
    changes.noteRead(thread, { server, uri })
    const evicted = await subscribeResourceUpdates(server, connection.client, uri, updated =>
      changes.record({ server, uri: updated }),
    )
    for (const old of evicted ?? []) changes.forget({ server, uri: old })
  } catch (error) {
    logMCPError(server, `Could not subscribe to ${uri}: ${errorMessage(error)}`)
  }
}
