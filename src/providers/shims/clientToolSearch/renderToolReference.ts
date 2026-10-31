/**
 * A ToolSearch result as the model reads it on an OpenAI-compatible server.
 *
 * Anthropic's API expands each `tool_reference` block into the tool's
 * definition at that point of the conversation. The shim writes the same thing
 * as text: the schema in the `<functions>` form, and how to call it. The text
 * is built only from the tool's own name, description and input schema
 * (stableStringify), so it is byte-identical on every later request and the
 * prefix behind it stays cached.
 */
import { stableStringify } from 'src/shared/data/stableStringify.js'
import { CALL_TOOL_NAME } from 'src/providers/shims/clientToolSearch/callTool.js'

export type DeferredToolSchema = {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

export function renderLoadedTools(
  names: readonly string[],
  deferred: ReadonlyMap<string, DeferredToolSchema>,
): string {
  const functions: string[] = []
  const gone: string[] = []
  for (const name of names) {
    const tool = deferred.get(name)
    if (!tool) {
      gone.push(`Tool ${name} is no longer available.`)
      continue
    }
    functions.push(
      `<function>${stableStringify({
        description: tool.description ?? '',
        name: tool.name,
        parameters: tool.input_schema ?? { type: 'object', properties: {} },
      })}</function>`,
    )
  }
  const parts: string[] = []
  if (functions.length > 0) {
    parts.push(
      `Loaded. Call these through ${CALL_TOOL_NAME} with {"name": <tool>, "arguments": {...}}:\n` +
        `<functions>${functions.join('')}</functions>`,
    )
  }
  parts.push(...gone)
  return parts.join('\n')
}
