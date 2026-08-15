/**
 * The three headers that tell an endpoint who is calling.
 *
 * Split out of client.ts as a pure function because the decision it encodes is
 * easy to get wrong and impossible to test in place: `getAnthropicClient()`
 * builds ONE header object and hands it to every lane — the native Anthropic
 * SDK, bedrock/vertex/foundry, Copilot, and the OpenAI-compatible shim, which
 * spreads it and overrides only the User-Agent. So a value that looks like it
 * belongs to the Anthropic lane reaches OpenAI, Gemini, Mistral and Ollama too.
 *
 * Upstream's identity is kept on the first-party lane, where the backend
 * inspects it (their log filtering keys on `claude-cli` — see the note in
 * src/shared/http.ts). Everywhere else these are Claudin's own.
 */

export type IdentityHeaderInput = {
  /** True only for transport 'anthropic' against api.anthropic.com. */
  firstParty: boolean
  sessionId: string
  /** `claude-cli/<version> (...)` — from getUserAgent(). */
  firstPartyUserAgent: string
  /** `claudin/<version> (...)` — from getClaudinUserAgent(). */
  claudinUserAgent: string
}

export function buildIdentityHeaders(
  input: IdentityHeaderInput,
): Record<string, string> {
  const { firstParty, sessionId } = input
  return {
    'x-app': firstParty ? 'cli' : 'claudin',
    'User-Agent': firstParty
      ? input.firstPartyUserAgent
      : input.claudinUserAgent,
    [firstParty ? 'X-Claude-Code-Session-Id' : 'X-Claudin-Session-Id']:
      sessionId,
  }
}
