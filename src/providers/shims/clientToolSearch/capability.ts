/**
 * Which profiles get client-side tool search: every transport whose wire has
 * no server-side tool search. Anthropic's API keeps a tool sent with
 * `defer_loading: true` out of the prompt and expands it where a ToolSearch
 * `tool_reference` loaded it; the other wires have neither, so the gateway
 * (paramsTransform.ts, eventTransform.ts) does the server's half before the
 * request is converted.
 *
 * Copilot running Claude goes through the native Anthropic client and is
 * left to it. The first-party, Bedrock-Claude, Vertex and Foundry clients are
 * never wrapped.
 */
import { isGithubNativeAnthropicMode } from 'src/providers/model/providers.js'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'

const CLIENT_SEARCH_TRANSPORTS: ReadonlySet<string> = new Set([
  'openai_compat',
  'mistral',
  'gemini',
  'github_copilot',
  'codex_responses',
])

export function clientDefersTools(model?: string): boolean {
  const transport = tryGetActiveProvider()?.transport
  if (!transport || !CLIENT_SEARCH_TRANSPORTS.has(transport)) return false
  return !(transport === 'github_copilot' && isGithubNativeAnthropicMode(model))
}
