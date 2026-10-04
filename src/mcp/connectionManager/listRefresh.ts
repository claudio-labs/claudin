import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
} from 'src/mcp/client.js'
import type { ConnectedMCPServer } from 'src/mcp/types.js'
import { errorMessage } from 'src/shared/errors.js'
import { logMCPDebug, logMCPError } from 'src/shared/log.js'
import type { ServerUpdate } from 'src/mcp/connectionManager/types.js'

type Refresh = {
  /** Still the server's live connection? A refetch that outlived it is dropped. */
  isCurrent: () => boolean
  report: (update: ServerUpdate) => void
}

/**
 * Follows the `list_changed` notices the server declared it sends. Each
 * refetch skips the fetch cache, which still holds the list from before.
 */
export function followListChanges(server: ConnectedMCPServer, refresh: Refresh): void {
  const { client, capabilities, name } = server

  const refetch = (what: string, load: () => Promise<Pick<ServerUpdate, 'tools' | 'commands' | 'resources'>>) => async () => {
    logMCPDebug(name, `${what} list changed; refetching`)
    try {
      const lists = await load()
      if (refresh.isCurrent()) refresh.report({ ...server, ...lists })
    } catch (error) {
      logMCPError(name, `Failed to refresh ${what}: ${errorMessage(error)}`)
    }
  }

  if (capabilities?.tools?.listChanged) {
    client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      refetch('tool', async () => {
        fetchToolsForClient.cache.delete(name)
        return { tools: await fetchToolsForClient(server) }
      }),
    )
  }
  if (capabilities?.prompts?.listChanged) {
    client.setNotificationHandler(
      PromptListChangedNotificationSchema,
      refetch('prompt', async () => {
        fetchCommandsForClient.cache.delete(name)
        return { commands: await fetchCommandsForClient(server) }
      }),
    )
  }
  if (capabilities?.resources?.listChanged) {
    client.setNotificationHandler(
      ResourceListChangedNotificationSchema,
      refetch('resource', async () => {
        fetchResourcesForClient.cache.delete(name)
        return { resources: await fetchResourcesForClient(server) }
      }),
    )
  }
}
