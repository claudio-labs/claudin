import type { Message } from '../types/message.js'

// Banner intentionally disabled — internal-only friction-signal feature stubbed
// out for the open build.
export function useIssueFlagBanner(
  _messages: Message[],
  _submitCount: number,
): boolean {
  return false
}
