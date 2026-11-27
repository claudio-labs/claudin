/**
 * What Claudin rewrites in a server's raw JSON-RPC result before the SDK
 * decodes it, keyed by the method of the request it answers. wireFilter.ts
 * applies a rule in place, on the very object the SDK goes on to parse.
 *
 * The SDK checks a list page whole, so one malformed tool failed the page and
 * the server lost every tool it had; the list rules check each entry instead
 * (listValidation.ts) and hand the SDK only the sound ones. On the 2026-07-28
 * wire every result must also carry `resultType`, and a cacheable one (the
 * lists, `resources/read`, the MCP Skills `skills/list`) `ttlMs` and
 * `cacheScope` too, or the SDK rejects it whole; a server that leaves them
 * out gets the defaults the spec gives an absent hint (complete, immediately
 * stale, private). `tools/call`, `prompts/get` and `completion/complete` get
 * the `resultType` alone, as the SDK asks no cache fields of them.
 *
 * SEND_RULES rewrites a request Claudin sends, keyed by its method, before it
 * reaches the transport.
 *
 * A `tools/call` a 2026-07-28 server turned into a task (SEP-2663,
 * `resultType: 'task'`) has no decoder in the SDK, which rejects it; the rule
 * hands the SDK an empty complete result carrying the task under
 * MCP_TASK_META_KEY instead, and taskPoll.ts takes it from there. The
 * `tasks/*` answers get the same defaults as a list page, and so do the
 * `events/*` ones (SEP-3415, events.ts), which the SDK knows nothing of.
 *
 * To rewrite another method, add a row to WIRE_RULES or SEND_RULES.
 */
import type { Tool } from '@modelcontextprotocol/client'
import {
  keepValidPrompts,
  keepValidResources,
  keepValidResourceTemplates,
  keepValidTools,
  type SkippedEntry,
  type ValidatedList,
} from 'src/mcp/client/listValidation.js'

export type WireResult = Record<string, unknown>

export type WireRuleContext = {
  /** Entries a list rule dropped, with the kind they were listed as. */
  onSkipped: (kind: string, skipped: SkippedEntry[]) => void
}

export type WireRule = (result: WireResult, context: WireRuleContext) => void

export type WireRequest = { method: string; params?: Record<string, unknown> } & Record<string, unknown>

/** Returns the request to send in place of `request`, which it leaves untouched. */
export type SendRule = (request: WireRequest) => WireRequest

function isValidTtlMs(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Fills the result fields every 2026-07-28 list answer must carry. */
export function fillListResultFields(result: WireResult): void {
  fillResultType(result)
  if (!isValidTtlMs(result.ttlMs)) result.ttlMs = 0
  if (result.cacheScope !== 'public' && result.cacheScope !== 'private') result.cacheScope = 'private'
}

/** Fills the `resultType` every 2026-07-28 answer must carry. */
export function fillResultType(result: WireResult): void {
  if (result.resultType === undefined) result.resultType = 'complete'
}

/** Where a task-augmented `tools/call` result carries its task, in `_meta`. */
export const MCP_TASK_META_KEY = 'claudin/task'

/**
 * Rewrites a `resultType: 'task'` tool result, in place, into the complete
 * result the SDK decodes, with the task's own fields under MCP_TASK_META_KEY.
 * Any other result is left as it came.
 */
export function withTaskMarker(result: WireResult): void {
  if (result.resultType !== 'task') return
  const { resultType: _task, ...task } = result
  for (const key of Object.keys(result)) delete result[key]
  Object.assign(result, { resultType: 'complete', content: [], _meta: { [MCP_TASK_META_KEY]: task } })
}

/** A tool result as the SDK decodes it: a task turned into its marker, and any other result complete unless it says otherwise. */
export function fillToolCallResult(result: WireResult): void {
  withTaskMarker(result)
  fillResultType(result)
}

// Claudin never checked a tool's structuredContent against its outputSchema,
// and the SDK's callTool does once the schema is listed: a tool that declares
// one and answers without structuredContent (Portainer's, in the 10-15
// census) would start failing every call. Dropped, the call goes through as
// it always did.
export function withoutOutputSchema(tool: Tool): Tool {
  if (!('outputSchema' in tool)) return tool
  const { outputSchema: _dropped, ...rest } = tool
  return rest
}

function listRule<T>(
  field: string,
  kind: string,
  keepValid: (raw: readonly unknown[]) => ValidatedList<T>,
  adjust: (entry: T) => T = entry => entry,
): WireRule {
  return (result, context) => {
    fillListResultFields(result)
    const raw = result[field]
    // Not a list at all: left for the SDK to reject, as the same answer
    // comes back on every retry.
    if (!Array.isArray(raw)) return
    const { items, skipped } = keepValid(raw)
    result[field] = items.map(adjust)
    if (skipped.length > 0) context.onSkipped(kind, skipped)
  }
}

export const WIRE_RULES: Readonly<Record<string, WireRule>> = {
  'tools/list': listRule('tools', 'tool', keepValidTools, withoutOutputSchema),
  'prompts/list': listRule('prompts', 'prompt', keepValidPrompts),
  'resources/list': listRule('resources', 'resource', keepValidResources),
  'resources/templates/list': listRule('resourceTemplates', 'resource template', keepValidResourceTemplates),
  'resources/read': fillListResultFields,
  'skills/list': fillListResultFields,
  'tools/call': fillToolCallResult,
  'prompts/get': fillResultType,
  'completion/complete': fillResultType,
  'tasks/get': fillListResultFields,
  'tasks/update': fillListResultFields,
  'tasks/cancel': fillListResultFields,
  'events/list': fillListResultFields,
  'events/poll': fillListResultFields,
  'events/stream': fillListResultFields,
}

/**
 * What the 2025 `initialize` announces, as it always has. The client is built
 * with `elicitation: { form: {}, url: {} }`, which a 2026-07-28 server needs
 * to see before it asks for a URL; on the 2025 wire, Java MCP SDK servers
 * (Spring AI) fail on any field inside `elicitation`, whose empty object
 * reads as form support. `initialize` goes out only on the 2025 era, so URL
 * elicitation is offered on modern connections alone.
 */
export const LEGACY_INITIALIZE_CAPABILITIES = { roots: {}, elicitation: {} } as const

export function withLegacyInitializeCapabilities(request: WireRequest): WireRequest {
  return {
    ...request,
    params: { ...request.params, capabilities: structuredClone(LEGACY_INITIALIZE_CAPABILITIES) },
  }
}

export const SEND_RULES: Readonly<Record<string, SendRule>> = {
  initialize: withLegacyInitializeCapabilities,
}
