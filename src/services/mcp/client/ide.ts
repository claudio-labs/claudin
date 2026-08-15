import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { createAbortController } from 'src/utils/abortController.js'
import type { ConnectedMCPServer } from 'src/services/mcp/types.js'
import { callMCPTool } from 'src/services/mcp/client/callTool.js'

/**
 * Call an IDE tool directly as an RPC
 * @param toolName The name of the tool to call
 * @param args The arguments to pass to the tool
 * @param client The IDE client to use for the RPC call
 * @returns The result of the tool call
 */
export async function callIdeRpc(
  toolName: string,
  args: Record<string, unknown>,
  client: ConnectedMCPServer,
): Promise<string | ContentBlockParam[] | undefined> {
  const result = await callMCPTool({
    client,
    tool: toolName,
    args,
    signal: createAbortController().signal,
  })
  return result.content
}
