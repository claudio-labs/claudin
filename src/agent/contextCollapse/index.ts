// Stub — contextCollapse not included in source snapshot (feature-gated)
//
// Every call site is behind `feature('CONTEXT_COLLAPSE')`, which is `false` in
// this build, so nothing below runs. The signatures are still spelled out
// because the callers type-check unconditionally: `query.ts` reads
// `applyCollapsesIfNeeded(...).messages` and `recoverFromOverflow(...).committed`,
// and `ContextVisualization`/`TokenWarning` read the whole `CollapseStats`
// shape. Declaring the contract here is what keeps those files honest — if the
// real subsystem ever lands, a mismatch is a compile error rather than a crash.
import type { QuerySource } from 'src/agent/prompts/querySource.js'
import type { AssistantMessage, Message } from 'src/shared/types/message.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

/** Counters behind the "Context strategy: collapse (…)" legend line. */
export type CollapseHealth = {
  totalSpawns: number
  totalErrors: number
  lastError: string | null
  totalEmptySpawns: number
  emptySpawnWarningEmitted: boolean
}

export type CollapseStats = {
  collapsedSpans: number
  collapsedMessages: number
  stagedSpans: number
  health: CollapseHealth
}

const EMPTY_STATS: CollapseStats = {
  collapsedSpans: 0,
  collapsedMessages: 0,
  stagedSpans: 0,
  health: {
    totalSpawns: 0,
    totalErrors: 0,
    lastError: null,
    totalEmptySpawns: 0,
    emptySpawnWarningEmitted: false,
  },
}

export function isContextCollapseEnabled(): boolean {
  return false
}

export function initContextCollapse(): void {}

export function resetContextCollapse(): void {}

export function getStats(): CollapseStats {
  return EMPTY_STATS
}

/** `useSyncExternalStore` subscribe: never notifies, returns the unsubscribe. */
export function subscribe(_onStoreChange: () => void): () => void {
  return () => {}
}

export async function applyCollapsesIfNeeded(
  messages: Message[],
  _toolUseContext: ToolUseContext,
  _querySource: QuerySource,
): Promise<{ messages: Message[] }> {
  return { messages }
}

export function isWithheldPromptTooLong(
  _message: AssistantMessage,
  _isPromptTooLongMessage: (msg: AssistantMessage) => boolean,
  _querySource: QuerySource,
): boolean {
  return false
}

export function recoverFromOverflow(
  messages: Message[],
  _querySource: QuerySource,
): { committed: number; messages: Message[] } {
  return { committed: 0, messages }
}
