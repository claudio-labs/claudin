import { FRAME_INTERVAL_MS, setFrameIntervalMs } from 'src/ink/constants.js'
import { getXtversionName, hasCursorUpViewportYankBug } from 'src/ink/terminal.js'
import { getGlobalConfig } from './config.js'

/**
 * Render cadence resolution: how fast the TUI clock ticks and the renderer
 * paints. One knob drives both (src/ink/constants.ts), so inline and
 * fullscreen run at the same rate — there is deliberately no per-mode branch.
 *
 * Priority order:
 *   CLAUDIN_FPS=<n>              → that rate (10..360)
 *   cursor-up viewport yank bug  → 60fps (more repaints means more yanks)
 *   config renderFrameRate       → that rate
 *   GPU terminal, not under tmux → 120fps  (the `auto` default)
 *   otherwise                    → 60fps   (the `auto` fallback)
 *
 * Note the nominal rates are not the delivered ones: Node timers store the
 * delay as whole milliseconds, so 120/240/360 land on 8/4/3ms — i.e.
 * 125/250/333fps. The interval is rounded, not truncated: truncating 1000/360
 * gives 2ms, which would run 500fps for a 360fps request. The /config label
 * reports the nominal rate, since that is what the user picked.
 */

export const FRAME_RATE_OPTIONS = ['auto', '120', '240', '360'] as const
export type FrameRateSetting = (typeof FRAME_RATE_OPTIONS)[number]

// GPU-accelerated terminals: they rasterize through the GPU and pace their own
// frames, so a sub-16ms cadence buys real smoothness. Deliberately NOT
// isSynchronizedOutputSupported() — that list includes xterm.js (vscode) and
// CPU-rendered VTE, and it bails under tmux for an unrelated reason.
const GPU_TERM_PROGRAMS = new Set([
  'ghostty',
  'kitty',
  'WezTerm',
  'alacritty',
  'contour',
  'foot',
  'rio',
  'WarpTerminal',
])

// What these terminals put in TERM when TERM_PROGRAM is absent — the common
// case over SSH and under some launchers.
const GPU_TERM_VALUES = new Set([
  'xterm-kitty',
  'xterm-ghostty',
  'alacritty',
  'contour',
  'foot',
  'foot-extra',
  'rio',
])

// XTVERSION reply prefixes (lowercased). Survives SSH, where TERM_PROGRAM is
// not forwarded — same fallback getInlineImageProtocol() uses.
const GPU_XTVERSION_PREFIXES = [
  'ghostty',
  'kitty',
  'wezterm',
  'alacritty',
  'contour',
  'foot',
  'rio',
  'warp',
]

const MIN_FPS = 10
const MAX_FPS = 360
const AUTO_GPU_INTERVAL_MS = 8

// The supported rungs, pinned rather than computed: 60fps is traditionally 16ms
// (it is really 16.67) and 360fps has to round up to 3ms, since truncating
// 1000/360 to 2ms would run 500fps for a 360fps request. Both directions come
// from this one table so the /config label can never drift from the interval.
const RATE_LADDER: ReadonlyArray<readonly [fps: number, intervalMs: number]> = [
  [60, 16],
  [120, AUTO_GPU_INTERVAL_MS],
  [240, 4],
  [360, 3],
]
const INTERVAL_MS_BY_FPS = new Map(RATE_LADDER)
const FPS_BY_INTERVAL_MS = new Map(
  RATE_LADDER.map(([fps, intervalMs]) => [intervalMs, fps] as const),
)

export function isGpuTerminal(): boolean {
  const termProgram = process.env.TERM_PROGRAM
  if (termProgram && GPU_TERM_PROGRAMS.has(termProgram)) return true
  const term = process.env.TERM
  if (term && GPU_TERM_VALUES.has(term)) return true
  const xtversion = getXtversionName()?.toLowerCase()
  if (xtversion === undefined) return false
  return GPU_XTVERSION_PREFIXES.some(prefix => xtversion.startsWith(prefix))
}

/** Parse an fps value, or null when absent/unparseable/out of range. `'auto'`
 *  lands here too and returns null, which is what makes it fall through. */
function parseFps(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null
  const fps = Number(raw)
  if (!Number.isFinite(fps) || fps < MIN_FPS || fps > MAX_FPS) return null
  return fps
}

function intervalForFps(fps: number): number {
  return INTERVAL_MS_BY_FPS.get(fps) ?? Math.max(1, Math.round(1000 / fps))
}

/** True when CLAUDIN_FPS pins the rate, making the `/config` row inert. */
export function isFrameRateForcedByEnv(): boolean {
  return parseFps(process.env.CLAUDIN_FPS) !== null
}

export function resolveFrameIntervalMs(): number {
  const envFps = parseFps(process.env.CLAUDIN_FPS)
  if (envFps !== null) return intervalForFps(envFps)
  // conhost follows the cursor into scrollback (microsoft/terminal#14774), so
  // a faster repaint rate there means more viewport yanks, not more fluidity.
  if (hasCursorUpViewportYankBug()) return FRAME_INTERVAL_MS
  const configuredFps = parseFps(getGlobalConfig().renderFrameRate)
  if (configuredFps !== null) return intervalForFps(configuredFps)
  // `auto`: tmux parses and proxies every byte, so the extra frames cost more
  // there than they buy. An explicit choice above still wins.
  if (isGpuTerminal() && !process.env.TMUX) return AUTO_GPU_INTERVAL_MS
  return FRAME_INTERVAL_MS
}

/** The rate the resolved interval stands for, for the `/config` label. Reports
 *  the nominal rung when the interval is one of ours, else the real rate. */
export function getEffectiveFrameRate(): string {
  const intervalMs = resolveFrameIntervalMs()
  return String(FPS_BY_INTERVAL_MS.get(intervalMs) ?? Math.round(1000 / intervalMs))
}

/** Called once during boot, before Ink is constructed and the clock mounts. */
export function applyRenderCadence(): void {
  setFrameIntervalMs(resolveFrameIntervalMs())
}
