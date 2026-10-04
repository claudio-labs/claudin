import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  type ClientCapabilities,
  ElicitRequestSchema,
  ListRootsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { mcpClientIdentity } from 'src/mcp/client/clientIdentity.js'

/** Kept in characters, so a cut can split a surrogate pair. */
export const INSTRUCTIONS_CAP = 2048
const TRUNCATION_MARKER = '… [truncated]'

/** `elicitation` stays an empty object: some server SDKs reject unknown fields in it. */
const CLIENT_CAPABILITIES: ClientCapabilities = { roots: {}, elicitation: {} }

/**
 * A client that answers roots/list with the session's original directory and
 * cancels every elicitation until the connection manager installs its own
 * handler.
 */
export function createMcpClient(): Client {
  const client = new Client(mcpClientIdentity(), { capabilities: CLIENT_CAPABILITIES })
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: `file://${getOriginalCwd()}` }],
  }))
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'cancel' as const }))
  return client
}

export function capInstructions(instructions: string | undefined): string | undefined {
  if (instructions === undefined || instructions.length <= INSTRUCTIONS_CAP) return instructions
  return `${instructions.slice(0, INSTRUCTIONS_CAP)}${TRUNCATION_MARKER}`
}
