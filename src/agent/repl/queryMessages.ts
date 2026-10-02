import type { CacheProfile } from 'src/agent/cache/cacheProfile.js'
import {
  applyStableStubs,
  pruneOldToolResults,
  stubToolResultForDisplay,
  type AnyMessage,
} from 'src/agent/compact/stableStubState.js'
import { isCompactBoundaryMessage } from 'src/agent/messages/messages.js'
import { isEphemeralToolProgress } from 'src/sessions/sessionStorage.js'
import type { Message } from 'src/shared/types/message.js'

/**
 * How the REPL's message array takes the messages a turn yields, and what it
 * does to them once the turn ends.
 *
 * That array is not only what the screen shows: it seeds the next turn's
 * request (`messagesIncludingNewMessages` in useOnQuery). So every transform
 * here is a transform of the prompt-cache prefix, and the cache invariant
 * (cache.md §1) holds only if the next turn renders what this turn sent.
 * Pure, so the loop-prefix invariant suite can drive it next to
 * QueryEngine's accumulator and the transcript.
 */

type DisplayProfile = Pick<CacheProfile, 'immediateStubTokens' | 'stubKeepHeadChars'>

/** One message a turn yielded, appended the way the REPL stores it. */
export function appendQueryMessage(
  messages: Message[],
  message: Message,
  profile: DisplayProfile,
): Message[] {
  if (isCompactBoundaryMessage(message)) {
    // Compaction is a CONTEXT operation, not a timeline operation: the
    // boundary is appended like any other message and nothing before it is
    // dropped. query.ts already replaced the model-facing array, which is the
    // only place the summary has to take effect.
    return [...messages, message]
  }
  if (message.type === 'progress' && isEphemeralToolProgress(message.data.type)) {
    // Replace the previous ephemeral tick for the same tool call instead of
    // appending: Sleep/Bash emit one per second and only the last renders
    // (13k+ entries and 120MB of sleep_progress transcript lines observed).
    // agent_progress / hook_progress / skill_progress are not ephemeral.
    const last = messages.at(-1)
    if (
      last?.type === 'progress' &&
      last.parentToolUseID === message.parentToolUseID &&
      last.data.type === message.data.type
    ) {
      const copy = messages.slice()
      copy[copy.length - 1] = message
      return copy
    }
    return [...messages, message]
  }
  // Large tool_results are stubbed for display (mid-turn memory). A no-op
  // under the retain profile, whose threshold is Infinity — there the array
  // seeds the next request and must keep the bytes the wire sent.
  const displayMessage = stubToolResultForDisplay(
    message as AnyMessage,
    messages as AnyMessage[],
    profile.immediateStubTokens,
    profile.stubKeepHeadChars,
  ) as Message
  return [...messages, displayMessage]
}

/**
 * After a turn: age-prune old tool_results (a no-op under retain, where
 * keepTurns is Infinity) and write the clipped set back with the bytes the wire
 * already sent, so the clipped strings become GC-eligible. Nothing here removes
 * a message — dropping from this array was a prefix rewrite. Returns the same
 * array when nothing changed.
 */
export function settleTurnMessages(
  messages: Message[],
  profile: Pick<CacheProfile, 'keepTurns' | 'stubKeepHeadChars'>,
): Message[] {
  const before = messages as AnyMessage[]
  const aged = pruneOldToolResults(before, profile.keepTurns, profile.stubKeepHeadChars)
  const after = applyStableStubs(aged)
  return after === before ? messages : (after as Message[])
}
