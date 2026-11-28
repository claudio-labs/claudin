/**
 * The request half of client-side tool search, on Anthropic-format params,
 * before any wire converts them: deferred tools leave `tools`, CallTool joins
 * it, a ToolSearch `tool_reference` becomes the loaded schema as text where it
 * was loaded, and a `tool_use` of a deferred tool goes back as the gateway call
 * the model wrote. Every converter then renders an ordinary request.
 *
 * The stable stubs run first. The render already applied them, and they are
 * idempotent, but a caller that skips the render (a side query) would
 * otherwise rewrite a call before its clipped input fields are stubbed, and
 * the input stubs are keyed by the call's id and field.
 */
import {
  applyStableInputStubs,
  applyStableStubs,
} from 'src/agent/compact/stableStubState.js'
import { CALL_TOOL, CALL_TOOL_NAME, gatewayInput } from 'src/providers/shims/clientToolSearch/callTool.js'
import { planToolDeferral } from 'src/providers/shims/clientToolSearch/deferral.js'
import {
  renderLoadedTools,
  type DeferredToolSchema,
} from 'src/providers/shims/clientToolSearch/renderToolReference.js'

// The sibling text normalize.ts appends after a tool_result that loaded tools
// (TOOL_REFERENCE_TURN_BOUNDARY there): a turn boundary Anthropic's API needs.
// The rendered result already says "Loaded.", and after a tool message the
// extra user text made the chat coalescer invent an interrupted turn.
const TOOL_LOADED_TEXT = 'Tool loaded.'

type Block = { type?: string; [key: string]: unknown }
type Message = {
  role?: string
  content?: unknown
  message?: { role?: string; content?: unknown }
  [key: string]: unknown
}
type Tool = DeferredToolSchema & { type?: string; defer_loading?: boolean }

export type ClientToolSearchParams = {
  messages?: unknown
  tools?: unknown
  tool_choice?: unknown
  [key: string]: unknown
}

function toolReferenceNames(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return (content as Block[])
    .filter(block => block?.type === 'tool_reference')
    .map(block => block.tool_name)
    .filter((name): name is string => typeof name === 'string')
}

function withoutDeferFlag(tool: Tool): Tool {
  if (!('defer_loading' in tool)) return tool
  const { defer_loading: _deferLoading, ...rest } = tool
  return rest
}

function rewriteUserContent(content: Block[], deferred: ReadonlyMap<string, DeferredToolSchema>): Block[] {
  let loadsTools = false
  const out = content.map(block => {
    if (block?.type !== 'tool_result' || !Array.isArray(block.content)) return block
    const names = toolReferenceNames(block.content)
    if (names.length === 0) return block
    loadsTools = true
    const rest = (block.content as Block[]).filter(part => part?.type !== 'tool_reference')
    return { ...block, content: [...rest, { type: 'text', text: renderLoadedTools(names, deferred) }] }
  })
  if (!loadsTools) return content
  return out.filter(block => !(block?.type === 'text' && block.text === TOOL_LOADED_TEXT))
}

function rewriteAssistantContent(content: Block[], deferred: ReadonlyMap<string, DeferredToolSchema>): Block[] {
  let changed = false
  const out = content.map(block => {
    if (block?.type !== 'tool_use' || typeof block.name !== 'string' || !deferred.has(block.name)) return block
    changed = true
    return { ...block, name: CALL_TOOL_NAME, input: gatewayInput(block.name, block.input) }
  })
  return changed ? out : content
}

function rewriteMessage(message: Message, deferred: ReadonlyMap<string, DeferredToolSchema>): Message {
  const inner = message.message ?? message
  const role = inner.role ?? message.role
  const content = inner.content
  if (!Array.isArray(content)) return message
  const next =
    role === 'assistant'
      ? rewriteAssistantContent(content as Block[], deferred)
      : role === 'user'
        ? rewriteUserContent(content as Block[], deferred)
        : content
  if (next === content) return message
  return message.message
    ? { ...message, message: { ...message.message, content: next } }
    : { ...message, content: next }
}

/**
 * The params as a wire without server-side tool search must see them, and
 * whether the gateway is in play (its calls then need unwrapping on the way
 * back). Params with no deferred tool come back as they are.
 */
export function applyClientToolSearch<P extends ClientToolSearchParams>(params: P): { params: P; active: boolean } {
  const tools = Array.isArray(params.tools) ? (params.tools as Tool[]) : []
  if (!tools.some(tool => tool?.defer_loading === true)) return { params, active: false }

  const choice = params.tool_choice as { type?: string; name?: string } | undefined
  const plan = planToolDeferral(tools, choice?.type === 'tool' ? choice.name : undefined)
  const sent = plan.sent.map(withoutDeferFlag)
  if (plan.deferred.size === 0) return { params: { ...params, tools: sent }, active: false }

  const messages = Array.isArray(params.messages)
    ? applyStableInputStubs(applyStableStubs(params.messages as Message[])).map(message =>
        rewriteMessage(message, plan.deferred),
      )
    : params.messages
  return {
    params: { ...params, tools: [...sent, CALL_TOOL], messages },
    active: true,
  }
}
