/**
 * The one function the model calls a deferred tool through.
 *
 * An OpenAI-compatible server only lets the model call functions listed in
 * `tools[]`, and adding the loaded tool there would change the start of the
 * prompt on every discovery. So the list carries this gateway instead: the
 * model passes the loaded tool's name and its arguments, and the shim turns
 * the call into a `tool_use` of the real tool on the way in — and a
 * `tool_use` of a deferred tool back into a gateway call on the way out, so
 * the history reads the way the model wrote it.
 */
import type { OpenAITool } from 'src/providers/shims/openaiShim/types.js'

export const CALL_TOOL_NAME = 'CallTool'

export const CALL_TOOL: OpenAITool = {
  type: 'function',
  function: {
    name: CALL_TOOL_NAME,
    description:
      'Call a tool whose schema ToolSearch has loaded into this conversation. ' +
      'Deferred tools are not in your tool list: load one with ToolSearch first, then call it here.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The exact name of the loaded tool.' },
        arguments: {
          type: 'object',
          description: 'The arguments for that tool, matching the schema ToolSearch returned.',
        },
      },
      required: ['name', 'arguments'],
    },
  },
}

/** The gateway arguments a deferred tool_use is sent back as. */
export function gatewayArguments(name: string, input: unknown): string {
  return JSON.stringify({ name, arguments: input ?? {} })
}

/**
 * The real call inside a gateway call's arguments, or null when they do not
 * name one. A string `arguments` is the model encoding the object twice.
 */
export function unwrapGatewayCall(rawArguments: string | undefined): { name: string; input: unknown } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments ?? '')
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const { name, arguments: args } = parsed as { name?: unknown; arguments?: unknown }
  if (typeof name !== 'string' || !name) return null
  if (typeof args === 'string') {
    try {
      return { name, input: JSON.parse(args) }
    } catch {
      return { name, input: {} }
    }
  }
  return { name, input: args && typeof args === 'object' ? args : {} }
}
