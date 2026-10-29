import { getAPIProvider } from 'src/providers/model/providers.js'

/**
 * The Gemini state to carry over when a tool_use is rebuilt from its standard
 * fields, as normalizeMessagesForAPI rebuilds every tool_use: the thought
 * signature the stream gave the call — as `signature`, and as the
 * OpenAI-compatible `extra_content.google` it arrived in — under the Gemini
 * provider, nothing anywhere else.
 */
export function geminiStateToKeep(
  block: unknown,
): { extra_content?: unknown; signature?: string } {
  if (getAPIProvider() !== 'gemini') return {}
  const { extra_content, signature } = (block ?? {}) as {
    extra_content?: unknown
    signature?: unknown
  }
  return {
    ...(extra_content ? { extra_content } : {}),
    ...(typeof signature === 'string' && signature ? { signature } : {}),
  }
}
