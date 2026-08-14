// Stub — snipCompact not included in source snapshot (feature-gated)
//
// Every call site is behind `feature('HISTORY_SNIP')`, which is `false` in this
// build, so nothing below runs. The signatures are still spelled out because
// the callers type-check unconditionally: `query.ts` reads `.messages`,
// `.tokensFreed` and `.boundaryMessage` off `snipCompactIfNeeded`, and
// `normalize.ts` / `injections.ts` / `Message.tsx` destructure the four
// predicates and the nudge string.
// Message is defined in types/message.js; query.ts only imports it (does not
// re-export it), so import from the real source.
import type { Message } from 'src/types/message.js'

export function snipCompact() {
  return null
}

export function isSnipRuntimeEnabled(): boolean {
  return false
}

/** True once enough un-nudged snips have accumulated to be worth a reminder. */
export function shouldNudgeForSnips(_messages: Message[]): boolean {
  return false
}

export function isSnipMarkerMessage(_message: Message): boolean {
  return false
}

export const SNIP_NUDGE_TEXT = ''

export function snipCompactIfNeeded(
  messages: Message[],
  _options?: { force?: boolean },
): { messages: Message[]; tokensFreed: number; boundaryMessage?: Message } {
  return { messages, tokensFreed: 0 }
}
