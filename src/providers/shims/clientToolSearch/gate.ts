/**
 * Client-side tool search for the openai shim's Chat Completions path.
 *
 * Anthropic's API keeps a tool sent with `defer_loading: true` out of the
 * prompt and expands it where a ToolSearch `tool_reference` loaded it. An
 * OpenAI-compatible server has neither, so tool search stayed off for every
 * one of them and each request carried every tool schema in full — 305 tools,
 * ~94k of a 112k-token prompt, in a project with a Portainer MCP server
 * (2026-10-31, Ollama on a 3060: a 10-minute prefill for "ola").
 *
 * This module does the server's half in the shim: deferred tools leave
 * `tools[]`, a `tool_reference` becomes the tool's schema as text where it was
 * loaded, and one fixed function, CallTool, invokes a loaded tool. `tools[]`
 * never changes mid-session, so a discovery only appends to the history and
 * the prefix cache — a local server's KV cache included — stays valid.
 *
 * Gemini (native or not) and the Responses path (Codex, Copilot's GPT-5) have
 * converters of their own and keep every tool inline for now.
 *
 * Killswitch: CLAUDIN_SHIM_TOOL_SEARCH=0 sends every tool whole, as before.
 */
import { isGithubNativeAnthropicMode } from 'src/providers/model/providers.js'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import { resolveProviderRequest } from 'src/providers/presets/providerConfig.js'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'

const SHIM_CHAT_TRANSPORTS: ReadonlySet<string> = new Set([
  'openai_compat',
  'mistral',
  'github_copilot',
])

export function clientToolSearchDisabled(): boolean {
  return isEnvDefinedFalsy(process.env.CLAUDIN_SHIM_TOOL_SEARCH)
}

/** The active profile's requests go out through the shim's Chat Completions converter. */
export function usesShimChatCompletions(model?: string): boolean {
  const transport = tryGetActiveProvider()?.transport
  if (!transport || !SHIM_CHAT_TRANSPORTS.has(transport)) return false
  if (transport === 'github_copilot' && isGithubNativeAnthropicMode(model)) return false
  return resolveProviderRequest({ model }).transport === 'chat_completions'
}
