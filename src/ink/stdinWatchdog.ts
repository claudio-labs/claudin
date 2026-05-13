// Stdin readable-stream watchdog.
//
// Background: under rare conditions (observed: long-running session in Omarchy
// /Hyprland on Linux + Node 25), the stdin readable stream enters a wedged
// state where `readable=true`, `rawMode` is on, our `readable` listener is
// registered, but the event simply never re-emits. The kernel reports the fd
// as not-ready (no `EPOLLIN`) even after fresh keystrokes hit the pty.
// `_readableState.needReadable` / `emittedReadable` end up inconsistent and
// the pollable never re-arms. Typical trigger paths under suspicion:
// subprocess that inherits/returns stdin (Bash tool), an extra
// `setRawMode(true)` while already-true, or a `pause()`/`resume()` race
// during heavy synchronous render.
//
// We verified the cure live by attaching the inspector to a wedged process:
// `removeListener('readable', fn); addListener('readable', fn)` on the same
// stdin instantly destrava the stream — Node re-arms the pollable and the
// next keystroke produces a `readable` event normally.
//
// This watchdog runs that exact cure on a long timer, gated by
// `now - lastStdinTime > stale threshold`. The fix is identity-preserving
// (same listener function before/after) and cheap, so a false trigger during
// normal idle is harmless. The default behavior is on; set
// `CLAUDIO_STDIN_WATCHDOG=0` to disable.

export interface StdinWatchdogOptions {
  readonly stdin: NodeJS.ReadStream
  /** The 'readable' listener to remove+re-add when we detect a wedge. */
  readonly listener: () => void
  /** Last time stdin produced a chunk (epoch ms). Updated by handleReadable. */
  readonly getLastStdinTime: () => number
  /** Returns true when the watchdog should run (raw mode is enabled). */
  readonly isActive: () => boolean
  /** Override for tests. */
  readonly now?: () => number
  /**
   * After this many ms of stdin silence we suspect a wedge and re-attach.
   * Must be long enough that normal idle pauses don't fire it; short enough
   * that a user noticing the freeze gets unstuck within ~one minute.
   */
  readonly staleThresholdMs?: number
  /** How often we check (ms). */
  readonly checkIntervalMs?: number
  /** Hook for logging / metrics. Called whenever we re-attach. */
  readonly onRecover?: (gapMs: number) => void
}

const DEFAULT_STALE_THRESHOLD_MS = 30_000
const DEFAULT_CHECK_INTERVAL_MS = 10_000

// Env override so users with hard freezes can dial up frequency without code
// changes, or disable the watchdog entirely while bisecting unrelated bugs.
function parsePositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name]
  if (raw == null || raw === '') return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

export function isStdinWatchdogEnabled(): boolean {
  // Disabled only when explicitly set to "0" / "false" / "off". Default on.
  const raw = process.env.CLAUDIO_STDIN_WATCHDOG
  if (raw == null || raw === '') return true
  return !['0', 'false', 'off', 'no'].includes(raw.toLowerCase())
}

export class StdinWatchdog {
  private timer: NodeJS.Timeout | null = null
  private readonly opts: StdinWatchdogOptions
  private readonly now: () => number
  private readonly staleThresholdMs: number
  private readonly checkIntervalMs: number

  constructor(opts: StdinWatchdogOptions) {
    this.opts = opts
    this.now = opts.now ?? Date.now
    this.staleThresholdMs =
      opts.staleThresholdMs ??
      parsePositiveIntEnv('CLAUDIO_STDIN_WATCHDOG_STALE_MS') ??
      DEFAULT_STALE_THRESHOLD_MS
    this.checkIntervalMs =
      opts.checkIntervalMs ??
      parsePositiveIntEnv('CLAUDIO_STDIN_WATCHDOG_INTERVAL_MS') ??
      DEFAULT_CHECK_INTERVAL_MS
  }

  start(): void {
    if (this.timer != null) return
    this.timer = setInterval(() => {
      this.checkOnce()
    }, this.checkIntervalMs)
    // Don't keep the event loop alive just for the watchdog — Ink already
    // holds a stdin ref while raw mode is on, so we'll get scheduled
    // alongside the real listeners. Without unref(), an idle CLI that
    // forgot to stop the watchdog would block clean exit.
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer == null) return
    clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Runs one watchdog check synchronously. Returns true iff we performed the
   * remove+add cure. Exposed for tests; production code uses `start()`.
   */
  checkOnce(): boolean {
    const { stdin, listener, getLastStdinTime, isActive } = this.opts

    if (!isActive()) return false
    if (stdin.destroyed) return false

    const gap = this.now() - getLastStdinTime()
    if (gap < this.staleThresholdMs) return false

    // Only act when our listener is currently registered. If something else
    // already removed it, re-adding without removing would change semantics
    // (we'd silently fix a different bug). Stay narrow: cure only the exact
    // wedge we have evidence for.
    const listeners = stdin.listeners('readable')
    if (!listeners.includes(listener)) return false

    // Don't fire if stdin already has buffered data ready — that means the
    // stream is not wedged, just waiting for the reader. Re-attaching would
    // be harmless but the diagnostic signal would be misleading.
    if (stdin.readableLength > 0) return false

    // Don't fire if stdin is paused — pause/resume is a separate concern and
    // re-attaching while paused has no effect anyway.
    if (typeof stdin.isPaused === 'function' && stdin.isPaused()) return false

    stdin.removeListener('readable', listener)
    stdin.addListener('readable', listener)
    this.opts.onRecover?.(gap)
    return true
  }
}

export function createStdinWatchdog(opts: StdinWatchdogOptions): StdinWatchdog | null {
  if (!isStdinWatchdogEnabled()) return null
  return new StdinWatchdog(opts)
}
