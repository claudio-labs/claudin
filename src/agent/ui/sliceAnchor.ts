// The anchored render window for the NON-virtualized message list, split out
// of `Messages.tsx` so it can be unit-tested: anything importing that file
// reaches `src/terminal/ink.js`, which does not load under `bun test`.
//
// Safety cap for the non-virtualized render path (fullscreen off or
// explicitly disabled). Ink mounts a full fiber tree per message (~250 KB
// RSS each); yoga layout height grows unbounded; the screen buffer is sized
// to fit every line. At ~2000 messages this is ~3000-line screens, ~500 MB
// of fibers, and per-frame write costs that push the process into a GC
// death spiral (observed: 59 GB RSS, 14k mmap/munmap/sec). Content dropped
// from this slice has already been printed to terminal scrollback — users
// can still scroll up natively. VirtualMessageList (the fullscreen path)
// bypasses this cap entirely: it mounts only viewport + overscan, capped at
// MAX_MOUNTED_ITEMS. Headless one-shot renders (e.g. /export) pass
// disableRenderCap to opt out — they have no scrollback and the memory
// concern doesn't apply to renderToString.
//
// The slice boundary is tracked as a UUID anchor, not a count-derived
// index. Count-based slicing (slice(-200)) drops one message from the
// front on every append, shifting scrollback content and forcing a full
// terminal reset per turn (CC-941). Quantizing to 50-message steps
// (CC-1154) helped but still shifted on compaction and collapse regrouping
// since those change collapsed.length without adding messages. The UUID
// anchor only advances when rendered count genuinely exceeds CAP+STEP —
// immune to length churn from grouping/compaction (CC-1174).
//
// The anchor stores BOTH uuid and index. Some uuids are unstable between
// renders: collapseHookSummaries derives the merged uuid from the first
// summary in a group, but reorderMessagesInUI reshuffles hook adjacency
// as tool results stream in, changing which summary is first. When the
// uuid vanishes, falling back to the stored index (clamped) keeps the
// slice roughly where it was instead of resetting to 0 — which would
// jump from ~200 rendered messages to the full history, orphaning
// in-progress badge snapshots in scrollback.
export const MAX_MESSAGES_WITHOUT_VIRTUALIZATION = 200
export const MESSAGE_CAP_STEP = 50

export type SliceAnchor = {
  uuid: string
  idx: number
} | null

/** Mutates anchorRef when the window needs to advance. */
export function computeSliceStart(
  collapsed: ReadonlyArray<{ uuid: string }>,
  anchorRef: { current: SliceAnchor },
  cap = MAX_MESSAGES_WITHOUT_VIRTUALIZATION,
  step = MESSAGE_CAP_STEP,
): number {
  const anchor = anchorRef.current
  const anchorIdx = anchor
    ? collapsed.findIndex(m => m.uuid === anchor.uuid)
    : -1
  // Anchor found → use it. Anchor lost → fall back to stored index
  // (clamped) so collapse-regrouping uuid churn doesn't reset to 0.
  let start =
    anchorIdx >= 0
      ? anchorIdx
      : anchor
        ? Math.min(anchor.idx, Math.max(0, collapsed.length - cap))
        : 0
  if (collapsed.length - start > cap + step) {
    start = collapsed.length - cap
  }
  // Refresh anchor from whatever lives at the current start — heals a
  // stale uuid after fallback and captures a new one after advancement.
  const msgAtStart = collapsed[start]
  if (msgAtStart && (anchor?.uuid !== msgAtStart.uuid || anchor.idx !== start)) {
    anchorRef.current = {
      uuid: msgAtStart.uuid,
      idx: start,
    }
  } else if (!msgAtStart && anchor) {
    anchorRef.current = null
  }
  return start
}
