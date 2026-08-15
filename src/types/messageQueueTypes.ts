// Reconstructed from its use sites: the original module was not carried into
// this fork. `QueueOperationMessage` is one arm of the `Entry` union in
// `src/types/logs.ts`, appended to the session transcript by
// `insertQueueOperation`; the literal that produces it lives in `logOperation`
// (`src/agent/messageQueueManager.ts:30`).

import type { SessionId } from 'src/types/ids.js'

/**
 * What happened to the prompt queue. Only these four are ever logged —
 * `enqueue` from both `enqueue()` and `enqueuePendingNotification()`,
 * `dequeue` from the three drain paths, `remove` from the two removal paths,
 * and `popAll` once per command when the queue is emptied into the editor.
 */
export type QueueOperation = 'enqueue' | 'dequeue' | 'remove' | 'popAll'

/**
 * A queue-operation transcript entry.
 *
 * `sessionId` is the branded `SessionId` rather than the `UUID` its sibling
 * entries use, because the one construction site passes `getSessionId()`
 * straight through without a cast.
 */
export type QueueOperationMessage = {
  type: 'queue-operation'
  operation: QueueOperation
  /** ISO-8601, from `new Date().toISOString()`. */
  timestamp: string
  sessionId: SessionId
  /** The command text, present only when the queued value was a string. */
  content?: string
}
