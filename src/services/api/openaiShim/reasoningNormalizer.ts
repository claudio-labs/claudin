/**
 * OpenAI-compatible providers expose chain-of-thought under several different
 * field names. The official-ish key is `reasoning_content` (DeepSeek, GLM,
 * Moonshot), but OpenRouter forwards it as bare `reasoning`, and a few
 * providers use `reasoning_text` or `thinking`.
 *
 * If we only read one key, the others leak into visible `text` blocks and
 * surface to the user as inter-tool-call narration. This module centralizes
 * the alias walk so both streaming and non-streaming paths agree on
 * precedence.
 */

const REASONING_FIELD_ALIASES = [
  'reasoning_content',
  'reasoning',
  'reasoning_text',
  'thinking',
] as const

/**
 * Walk known reasoning aliases on a streaming `delta` object. Returns the
 * first non-empty string found, or null. Empty strings are treated as
 * "no reasoning this chunk" — some providers emit `""` to signal stream
 * start, and we don't want to open a thinking block for that.
 */
export function extractReasoningDelta(
  delta: Record<string, unknown>,
): string | null {
  for (const key of REASONING_FIELD_ALIASES) {
    const v = delta[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return null
}

/**
 * Same alias walk for non-streaming `choice.message` payloads.
 */
export function extractReasoningMessage(
  msg: Record<string, unknown>,
): string | null {
  for (const key of REASONING_FIELD_ALIASES) {
    const v = msg[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return null
}
