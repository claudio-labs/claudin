/**
 * Detection of server-side context editing (clear_tool_uses) — the guard
 * that keeps Read's dedup stub honest.
 *
 * The dedup short-circuit returns FILE_UNCHANGED_STUB, which tells the model
 * to "refer to the earlier Read tool_result". That is only safe while the
 * earlier tool_result is actually visible. Under the retain cache profile,
 * the Anthropic-side clear_tool_uses_* context edit replaces old tool_results
 * (Read included — see services/cache/anthropic/apiMicrocompact.ts
 * TOOLS_CLEARABLE_RESULTS) with a cleared placeholder once the input-token
 * trigger fires — and the API response reports only HOW MANY tool uses were
 * cleared (cleared_tool_uses), never which ones. So once any clearing has
 * been applied in the session, a dedup stub may point at content the model
 * can no longer see — and an unchanged-file re-Read is exactly the move a
 * model makes after losing the content. The dedup must stand down:
 * re-sending the content is what the model needs, and the fresh Read
 * becomes a recent (kept) tool_result again.
 *
 * Clearing latches in practice: message history only grows, so a session
 * whose input crossed the trigger once keeps clearing on every subsequent
 * request. That makes a session-wide "has it ever cleared" check the right
 * granularity — no per-tool_use bookkeeping is possible with counts only.
 *
 * The evidence lands on assistant messages: context_management arrives on
 * the message_delta stream event and is written back to the last message of
 * the turn (streaming.ts applyMessageDeltaToLastMessage); normalization
 * preserves it (utils/messages/normalize.ts).
 */

interface AssistantMessageLike {
  type?: string
  message?: {
    context_management?: {
      applied_edits?: ReadonlyArray<{
        type?: string
        cleared_tool_uses?: number
      }>
    } | null
  }
}

/**
 * Positive results latched by messages-array identity: the per-query
 * Message[] is appended in place, so once evidence is found, later Reads in
 * the same query skip the scan entirely. Negative results are never cached —
 * new clearing evidence can land mid-query. Same WeakSet-on-the-array
 * pattern as serialReadNudge.ts markFiredAndCheck; GCs with the query.
 */
const KNOWN_CLEARED: WeakSet<object> = new WeakSet()

/**
 * True when any assistant message in the transcript carries an applied
 * clear_tool_uses edit that actually cleared something. clear_thinking
 * edits don't touch tool_results and are ignored.
 *
 * O(messages) with a couple of property reads per message on a cache miss;
 * O(1) once evidence has been seen for this messages array. Walks
 * backwards: once clearing is active it applies to every subsequent
 * request, so evidence (when present) is densest at the tail.
 */
export function hasServerClearedToolUses(
  messages: ReadonlyArray<unknown>,
): boolean {
  const key = messages as unknown as object
  if (KNOWN_CLEARED.has(key)) return true
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as AssistantMessageLike
    if (!m || m.type !== 'assistant') continue
    const edits = m.message?.context_management?.applied_edits
    if (!Array.isArray(edits)) continue
    for (const edit of edits) {
      if (
        typeof edit?.type === 'string' &&
        edit.type.startsWith('clear_tool_uses') &&
        // The response can include the edit with nothing actually cleared
        // (trigger fired, keep window covered everything). Only a non-zero
        // count means a tool_result was wiped. A missing count field is
        // treated as cleared — fail toward correctness, not savings.
        (edit.cleared_tool_uses === undefined || edit.cleared_tool_uses > 0)
      ) {
        KNOWN_CLEARED.add(key)
        return true
      }
    }
  }
  return false
}
