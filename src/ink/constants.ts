// Base frame interval (~60fps). Two roles: the conservative default before the
// cadence is resolved, and the pinned value for consumers that must NOT follow
// a faster resolved cadence — streaming text arrives at network speed, not
// frame speed, so notifying React faster buys nothing (useStreamingTextStore,
// coalescedUpdater).
export const FRAME_INTERVAL_MS = 16

// Upper bound for the ScrollBox drain timer. Drain frames are cheap (DECSTBM +
// ~10 patches) so they run as fast as practical, but 4ms is the setTimeout
// floor worth scheduling against — deriving this from the resolved interval
// would ask for 2ms at 120fps and 1ms at 360fps.
export const SCROLL_DRAIN_INTERVAL_MS = 4

// Resolved once at boot by src/utils/renderCadence.ts. Injected through a
// setter rather than imported so this module — pulled in by cold startup
// paths — never drags utils/config.js into the import graph.
let resolvedFrameIntervalMs = FRAME_INTERVAL_MS

/** Set the render cadence. Clamped to >= 1ms: a 0 would busy-loop setInterval. */
export function setFrameIntervalMs(ms: number): void {
  resolvedFrameIntervalMs = Math.max(1, Math.trunc(ms))
}

export function getFrameIntervalMs(): number {
  return resolvedFrameIntervalMs
}

/** Drain cadence: never slower than a regular frame, never below the floor. */
export function scrollDrainIntervalMs(): number {
  return Math.min(SCROLL_DRAIN_INTERVAL_MS, resolvedFrameIntervalMs)
}
