import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import {
  GetPromptResultSchema,
  type ListPromptsResult,
  type ListResourcesResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { Command } from 'src/commands/commands.js'
import { normalizeNameForMCP } from 'src/mcp/normalization.js'
import type { ConnectedMCPServer, ServerResource } from 'src/mcp/types.js'
import { transformResultContent } from 'src/mcp/client/toolResult.js'

export type ListedPrompt = ListPromptsResult['prompts'][number]
export type ListedResource = ListResourcesResult['resources'][number]

/**
 * Pairs the words of what the user typed with the prompt's arguments, in
 * order. Words are split on single spaces, so a value cannot hold one; extra
 * words are dropped and missing ones stay unset (kept for parity, tracked).
 */
export function promptArguments(argNames: readonly string[], typed: string): Record<string, string | undefined> {
  const words = typed.split(' ')
  return Object.fromEntries(argNames.map((name, index) => [name, words[index]]))
}

export function resourceFromListing(server: string, resource: ListedResource): ServerResource {
  return { ...resource, server }
}

/** A `/mcp__server__prompt` command; the prompt part is used as the server sent it. */
export function commandFromPrompt(server: ConnectedMCPServer, prompt: ListedPrompt): Command {
  const argNames = (prompt.arguments ?? []).map(argument => argument.name)
  return {
    type: 'prompt',
    name: `mcp__${normalizeNameForMCP(server.name)}__${prompt.name}`,
    description: prompt.description ?? '',
    hasUserSpecifiedDescription: prompt.description !== undefined && prompt.description !== '',
    contentLength: 0,
    isEnabled: () => true,
    isHidden: false,
    isMcp: true,
    progressMessage: 'running',
    source: 'mcp',
    argNames,
    userFacingName: () => `${server.name}:${prompt.name} (MCP)`,
    async getPromptForCommand(typed: string): Promise<ContentBlockParam[]> {
      const reply = await server.client.request(
        { method: 'prompts/get', params: { name: prompt.name, arguments: promptArguments(argNames, typed) } },
        GetPromptResultSchema,
      )
      const blocks = await Promise.all(
        reply.messages.map(message => transformResultContent(message.content, server.name)),
      )
      return blocks.flat()
    },
  }
}
