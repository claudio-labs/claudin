/**
 * Detection of client-side tool_result clipping — the sibling of
 * serverClearingDetection.ts for the clip paths that run in-process.
 *
 * Four client-side rewriters replace old tool_results with stable clip stubs
 * without ever touching readFileState (see services/compact/stableStubState.ts):
 *   - the age prune (pruneOldToolResults, keepTurns=1 under the aggressive
 *     cache profile — any Read older than one user-role message is stubbed)
 *   - the RSS byte-guard (pruneToolResultsByBytes)
 *   - the time-based idle-gap clear
 *   - microCompact's size-based stable stubs (applyStableStubs)
 *
 * After any of them touches the prior Read's tool_result, the dedup's
 * FILE_UNCHANGED_STUB ("refer to the earlier Read tool_result") points at a
 * `[clipped: ~N tokens from Read]` marker — exactly the blind-pointer bug the
 * server-clearing stand-down fixed, but deterministic under the aggressive
 * profile instead of needing a >140k-token session.
 *
 * Unlike the server case (which reports only counts), the client knows which
 * tool_use carried the content: Read records its own toolUseId in the
 * readFileState entry. So the stand-down here is per-file, not session-wide —
 * dedup stays armed for files whose prior tool_result is still intact.
 *
 * A missing tool_result (id not found in the transcript) also stands down:
 * fail toward correctness, not savings — same policy as the server scanner.
 * The only false positive is a duplicate same-range Read inside a single
 * assistant message, whose first result hasn't been appended to the
 * transcript yet when the second executes; the cost there is one re-send.
 *
 * No latch: unlike the server scan (full O(n) walk on every dedup-eligible
 * Read), this walk early-exits at the matching tool_result, and the verdict
 * for a given toolUseId is consulted at most once — a stand-down immediately
 * overwrites the readFileState entry with the fresh Read's id.
 */

import {
  getClippedIds,
  isClipStubContent,
} from '../../services/compact/stableStubState.js'

interface MessageLike {
  role?: string
  message?: { role?: string; content?: unknown }
  content?: unknown
}

interface ToolResultBlockLike {
  type?: string
  tool_use_id?: string
  content?: unknown
}

/**
 * True when the tool_result for `toolUseId` is no longer real content the
 * model can see: either rewritten into a clip stub (pure or head-preserving
 * form) or absent from the transcript entirely. Walks backwards — re-Reads
 * cluster near their original Read, so the match is usually close to the
 * tail. Handles both CliMessage ({message: {content}}) and bare API
 * ({role, content}) shapes, like stableStubState's getInner.
 */
export function isPriorReadClippedOrMissing(
  messages: ReadonlyArray<unknown>,
  toolUseId: string,
): boolean {
  // Ask the clip registry BEFORE reading bytes. The array a tool sees during a
  // turn (`toolUseContext.messages`, refreshed from `messagesForQuery`) holds
  // the UNCLIPPED originals — applyStableStubs rewrites a separate copy on its
  // way to the wire, and the clipped form is only written back post-turn. So a
  // result clipped by microCompact in the middle of a single long prompt still
  // looks like intact content here, the stand-down never fires, and the model
  // gets a dedup stub pointing at bytes it can no longer see. That is exactly
  // the loop this whole mechanism exists to close, surviving inside the one
  // case where the clipping is most aggressive.
  if (getClippedIds().has(toolUseId)) return true
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as MessageLike
    if (!m || typeof m !== 'object') continue
    const inner = m.message ?? m
    if ((inner.role ?? m.role) !== 'user') continue
    const content = inner.content
    if (!Array.isArray(content)) continue
    for (const block of content as ToolResultBlockLike[]) {
      if (block?.type !== 'tool_result' || block.tool_use_id !== toolUseId) {
        continue
      }
      // Found it. String content in a stable stub form means the bytes were
      // rewritten by a clip path (and are final forever — the stable-stub
      // contract). Anything else (real string, block array) is still visible.
      return typeof block.content === 'string' && isClipStubContent(block.content)
    }
  }
  // Not in the transcript at all (e.g. a readFileState entry that outlived
  // its message). The stub would point at nothing — stand down.
  return true
}
