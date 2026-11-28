/**
 * Client-side tool search, for every wire without Anthropic's server-side one.
 *
 * Anthropic's API keeps a tool sent with `defer_loading: true` out of the
 * prompt and expands it where a ToolSearch `tool_reference` loaded it. The
 * other wires have neither, so tool search stayed off for them and each
 * request carried every tool schema in full — 305 tools, ~94k of a 112k-token
 * prompt, in a project with a Portainer MCP server (2026-10-31, Ollama on a
 * 3060: a 10-minute prefill for "ola").
 *
 * This module does the server's half before the wire: deferred tools leave
 * `tools`, a `tool_reference` becomes the tool's schema as text where it was
 * loaded, and one fixed tool, CallTool, invokes a loaded tool. `tools` never
 * changes mid-session, so a discovery only appends to the history and the
 * prefix cache — a local server's KV cache included — stays valid. Which
 * profiles get it is capability.ts; the client factory wraps their client
 * (wrapClient.ts).
 *
 * Killswitch: CLAUDIN_SHIM_TOOL_SEARCH=0 sends every tool whole, as before.
 */
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'

export function clientToolSearchDisabled(): boolean {
  return isEnvDefinedFalsy(process.env.CLAUDIN_SHIM_TOOL_SEARCH)
}
