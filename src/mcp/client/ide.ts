import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { createAbortController } from 'src/shared/abortController.js'
import type { ConnectedMCPServer } from 'src/mcp/types.js'
import { callMCPTool } from 'src/mcp/client/callTool.js'

/** One RPC to the IDE's MCP server, for the diff and diagnostics features. */
export async function callIdeRpc(
  toolName: string,
  args: Record<string, unknown>,
  client: ConnectedMCPServer,
): Promise<string | ContentBlockParam[] | undefined> {
  const { content } = await callMCPTool({
    client,
    tool: toolName,
    args,
    signal: createAbortController().signal,
  })
  return content
}
