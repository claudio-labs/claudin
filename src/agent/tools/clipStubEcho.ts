import { inputClipStubField } from 'src/agent/compact/stableStubState/clipStubText.js'

/**
 * Refuses a call whose input field is the placeholder this conversation shows
 * in place of an EARLIER call's same field — `[clipped: ~931 tokens of
 * patchText from Patch]`. The relief policy stubs old tool_use inputs on the
 * wire (applyInputStubs.ts), and the model, re-sending a call it sees only in
 * that form, sometimes copies the stub instead of the content: four times in
 * the 2026-10-08..15 census. Three were Patch bodies refused as "missing
 * Begin/End markers", one resent unchanged 4s later; the fourth was an Edit
 * whose new_string wrote the stub into a test file.
 *
 * Only the fields the relief policy can stub are checked — the tool's
 * `clearableInputFields` — and only a stub naming the field it sits in counts.
 * So a Grep pattern, a Bash command or an MCP argument is never refused, and
 * repairing a file the stub landed in — an Edit whose old_string IS a stub, of
 * new_string — goes through.
 */
export function clipStubEchoRefusal(
  input: unknown,
  clearableFields: readonly string[] | undefined,
): string | null {
  if (!input || typeof input !== 'object' || !clearableFields) return null
  for (const field of clearableFields) {
    const value: unknown = (input as Record<string, unknown>)[field]
    if (typeof value !== 'string' || inputClipStubField(value) !== field) continue
    return `\`${field}\` is \`${value}\` — the placeholder this conversation shows in place of an earlier call's ${field} to save context, not its content. Nothing was run. Send the actual ${field}; to repeat an earlier call, write it out again.`
  }
  return null
}
