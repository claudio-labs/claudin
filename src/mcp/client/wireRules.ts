/**
 * What Claudin rewrites in a server's raw JSON-RPC result before the SDK
 * decodes it, keyed by the method of the request it answers. wireFilter.ts
 * applies a rule in place, on the very object the SDK goes on to parse.
 *
 * The SDK checks a list page whole, so one malformed tool failed the page and
 * the server lost every tool it had; the list rules check each entry instead
 * (listValidation.ts) and hand the SDK only the sound ones. On the 2026-07-28
 * wire a list result must also carry `resultType`, `ttlMs` and `cacheScope`,
 * or it is rejected whole too; a server that leaves them out gets the
 * defaults the spec gives an absent hint (complete, immediately stale,
 * private).
 *
 * To rewrite another method, add a row to WIRE_RULES.
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

function isValidTtlMs(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Fills the result fields every 2026-07-28 list answer must carry. */
export function fillListResultFields(result: WireResult): void {
  if (result.resultType === undefined) result.resultType = 'complete'
  if (!isValidTtlMs(result.ttlMs)) result.ttlMs = 0
  if (result.cacheScope !== 'public' && result.cacheScope !== 'private') result.cacheScope = 'private'
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
}
