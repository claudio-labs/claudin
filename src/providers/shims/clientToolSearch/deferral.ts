import { clientToolSearchDisabled } from 'src/providers/shims/clientToolSearch/gate.js'
import type { DeferredToolSchema } from 'src/providers/shims/clientToolSearch/renderToolReference.js'

type ShimTool = DeferredToolSchema & { type?: string; defer_loading?: boolean }

/**
 * Splits a request's tools into what goes in `tools[]` and what stays behind
 * the gateway. A tool arrives deferred because streaming.ts flagged it
 * `defer_loading` (tool search on for this request); the one a forced
 * `tool_choice` names is sent whole, since the server must see it to force it.
 */
export function planToolDeferral<T extends ShimTool>(
  tools: readonly T[],
  toolChoiceName?: string,
): { sent: T[]; deferred: Map<string, DeferredToolSchema> } {
  const deferred = new Map<string, DeferredToolSchema>()
  if (clientToolSearchDisabled()) return { sent: [...tools], deferred }
  const sent: T[] = []
  for (const tool of tools) {
    if (tool.defer_loading === true && tool.name !== toolChoiceName) {
      deferred.set(tool.name, tool)
    } else {
      sent.push(tool)
    }
  }
  return { sent, deferred }
}
