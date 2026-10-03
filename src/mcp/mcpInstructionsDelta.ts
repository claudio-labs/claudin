import type {
  ConnectedMCPServer,
  MCPServerConnection,
} from 'src/mcp/types.js'
import type { Message } from 'src/shared/types/message.js'

export type McpInstructionsDelta = {
  addedNames: string[]
  addedBlocks: string[]
  removedNames: string[]
}

export type ClientSideInstruction = {
  serverName: string
  block: string
}

type ServerBlock = { name: string; block: string }

/**
 * Compares the servers announced so far in the conversation with the ones
 * connected now. Announcements are keyed by name only, so changed text for an
 * announced server is not re-sent.
 */
export function getMcpInstructionsDelta(
  mcpClients: MCPServerConnection[],
  messages: Message[],
  clientSideInstructions: ClientSideInstruction[],
): McpInstructionsDelta | null {
  const connected = mcpClients.filter(
    (client): client is ConnectedMCPServer => client.type === 'connected',
  )
  return diffAnnouncements(
    announcedServerNames(messages),
    new Set(connected.map(server => server.name)),
    collectBlocks(connected, clientSideInstructions),
  )
}

/** Replays every earlier delta attachment, in history order. */
function announcedServerNames(messages: Message[]): Set<string> {
  const announced = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'attachment') continue
    const attachment = message.attachment
    if (attachment.type !== 'mcp_instructions_delta') continue
    for (const name of attachment.addedNames) announced.add(name)
    for (const name of attachment.removedNames) announced.delete(name)
  }
  return announced
}

function collectBlocks(
  connected: ConnectedMCPServer[],
  clientSideInstructions: ClientSideInstruction[],
): ServerBlock[] {
  const blocks: ServerBlock[] = []
  for (const server of connected) {
    const extras = clientSideInstructions
      .filter(instruction => instruction.serverName === server.name)
      .map(instruction => instruction.block)
    const block = renderBlock(server.name, server.instructions, extras)
    if (block !== null) blocks.push({ name: server.name, block })
  }
  return blocks
}

/** The heading uses the configured name, not the folded one. */
function renderBlock(
  serverName: string,
  ownInstructions: string | undefined,
  extras: string[],
): string | null {
  const sections = ownInstructions ? [ownInstructions, ...extras] : extras
  if (sections.length === 0) return null
  return `## ${serverName}\n${sections.join('\n\n')}`
}

// Added names sort by locale, removed names by code unit. Both are pinned:
// changing either reorders the bytes of new attachments.
function diffAnnouncements(
  announced: Set<string>,
  connectedNames: Set<string>,
  blocks: ServerBlock[],
): McpInstructionsDelta | null {
  const added = blocks
    .filter(entry => !announced.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  const removedNames = [...announced]
    .filter(name => !connectedNames.has(name))
    .sort()
  if (added.length === 0 && removedNames.length === 0) return null
  return {
    addedNames: added.map(entry => entry.name),
    addedBlocks: added.map(entry => entry.block),
    removedNames,
  }
}
