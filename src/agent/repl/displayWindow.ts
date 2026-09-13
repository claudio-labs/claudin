// The REPL's count-based render window — OFF by default.
//
// It was never sized for the renderer it ended up in front of. The oldest
// commit that names the constant is `6521a84c fix(cache): amortize REPL
// display eviction`, when `evictToMaxSize` cut the **state** array from 300 to
// 200 — an eviction that rewrote the prompt-cache prefix and dropped content
// the model had read. `17161fff` (#156) deleted the eviction and left the
// count behind as a render slice.
//
// Neither render path needs it:
//
//   * fullscreen renders through `VirtualMessageList`, which mounts viewport +
//     overscan only, capped at `MAX_MOUNTED_ITEMS`
//     (`src/terminal/hooks/useVirtualScroll.ts`). The rest of the height is
//     spacer, at O(1) fiber cost.
//   * inline is capped one layer down by `computeSliceStart`
//     (`src/agent/ui/sliceAnchor.ts`): a UUID-anchored 200 + 50 window that
//     does not shift on append. This slice kept that unreachable — it never
//     let `Messages` see more than 200 entries, so the anchored window could
//     not fire and the count-based one it was written to replace (CC-941) was
//     what actually ran.
//
// What it cost was the timeline. The alt screen has no terminal scrollback, so
// everything past the window was reachable only through ctrl+o (which reads
// the uncapped array). Nothing here ever touched the wire: this slice feeds
// `<Messages>` only, while the request is built from `messagesRef.current`.
//
// `CLAUDIN_DISABLE_MESSAGE_TIMELINE=1` restores the window on both paths.
export const MAX_DISPLAY_MESSAGES = 200

/**
 * Applies the legacy window when `enabled`, otherwise hands the history back
 * untouched.
 *
 * Returns the SAME array reference whenever it does not cut — `Messages` is
 * `React.memo`'d on prop identity, so a fresh slice per render would re-render
 * the whole list.
 */
export function applyDisplayWindow<T>(messages: T[], enabled: boolean): T[] {
  if (!enabled || messages.length <= MAX_DISPLAY_MESSAGES) return messages
  return messages.slice(-MAX_DISPLAY_MESSAGES)
}
