/**
 * The one rule that picks the message a loaded session is rebuilt from.
 *
 * The newest message by timestamp wins, and of several with the same
 * timestamp the one written last does: the transcript writer stamps a quick
 * exchange with one time, and keeping the first of them would rebuild the
 * chain from the prompt alone and drop the replies (finding 1).
 */
import type { TranscriptMessage } from 'src/shared/types/logs.js'

export type AnchorFilter = (message: TranscriptMessage) => boolean

/** Unparseable timestamps sort before every real one. */
function timeOf(message: TranscriptMessage): number {
  const time = Date.parse(message.timestamp)
  return Number.isNaN(time) ? -Infinity : time
}

/** `messages` in file order; the newest one `accepts` lets through, ties going to the later. */
export function newestMessage(
  messages: Iterable<TranscriptMessage>,
  accepts: AnchorFilter,
): TranscriptMessage | undefined {
  let newest: TranscriptMessage | undefined
  let newestTime = -Infinity
  for (const message of messages) {
    if (!accepts(message)) continue
    const time = timeOf(message)
    if (newest === undefined || time >= newestTime) {
      newest = message
      newestTime = time
    }
  }
  return newest
}

/** Branch ends: the user or assistant messages a branch of the file stops at. */
export function isBranchEndIn(branchEnds: ReadonlySet<string>): AnchorFilter {
  return message => branchEnds.has(message.uuid)
}

/** Any message of the main thread, whatever its type. */
export const isMainThreadMessage: AnchorFilter = message => !message.isSidechain
