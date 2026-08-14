import type { RGBColor as RGBColorString } from 'src/ink/styles.js'
import type { Theme } from 'src/utils/theme.js'

/**
 * The spinner's working colour representation: 8 bits per channel, kept
 * separate from ink's `RGBColor` string so the interpolation math below can
 * operate on numbers and only serialise once, in `toRGBColor`.
 */
export type RGBColorType = { r: number; g: number; b: number }

export function getDefaultCharacters(): string[] {
  // Claudin's spinner: a dense braille orbit that reads as a solid orb turning
  // (~0.64s per revolution at SPINNER_FRAME_MS). It never rests on a static
  // glyph — the earlier "orbit three turns then resolve on the brand C" cycle
  // spent 5 of its 12.2s parked on a motionless C, which read as a hang.
  // Braille glyphs (U+2800 block) are true narrow width everywhere, unlike the
  // ◜◝◞◟ arcs.
  // NOTE: rotation is directional, so consumers must NOT mirror these frames
  // (forward + reverse would make the orbit ping-pong instead of spin).
  return [...ORB]
}

const ORB = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']

/** How long one spinner frame is held. Every consumer derives its frame index
 *  as `Math.floor(time / SPINNER_FRAME_MS)`, so the cadence lives here. */
export const SPINNER_FRAME_MS = 80

// No frame of the orbit renders bold — the resolved brand C this used to mark
// is gone. Kept as the single decision point for the glyph's weight (and so a
// future resolved frame only has to change this).
export function isBoldSpinnerFrame(_frame: number): boolean {
  return false
}

// The verb's shimmer used to continue across the glyph cell while the brand C
// was showing; with the orbit always turning there is no such window, so the
// sweep stops at the message.
export function isBrandCFrame(_frame: number): boolean {
  return false
}

// The glyph cell sits two columns left of the message's first character
// (Box width={2}: glyph + gap), i.e. at message-coordinate -2. Mirror
// ShimmerChar's highlight rule (exact hit ± 1 neighbor) around it.
export function isGlyphShimmerHit(glimmerIndex: number): boolean {
  return glimmerIndex >= -3 && glimmerIndex <= -1
}

// Interpolate between two RGB colors
export function interpolateColor(
  color1: RGBColorType,
  color2: RGBColorType,
  t: number, // 0 to 1
): RGBColorType {
  return {
    r: Math.round(color1.r + (color2.r - color1.r) * t),
    g: Math.round(color1.g + (color2.g - color1.g) * t),
    b: Math.round(color1.b + (color2.b - color1.b) * t),
  }
}

// Convert RGB object to rgb() color string for Text component
export function toRGBColor(color: RGBColorType): RGBColorString {
  return `rgb(${color.r},${color.g},${color.b})`
}

// HSL hue (0-360) to RGB, using voice-mode waveform parameters (s=0.7, l=0.6).
export function hueToRgb(hue: number): RGBColorType {
  const h = ((hue % 360) + 360) % 360
  const s = 0.7
  const l = 0.6
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) {
    r = c
    g = x
  } else if (h < 120) {
    r = x
    g = c
  } else if (h < 180) {
    g = c
    b = x
  } else if (h < 240) {
    g = x
    b = c
  } else if (h < 300) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  }
}

const RGB_CACHE = new Map<string, RGBColorType | null>()

export function parseRGB(colorStr: string): RGBColorType | null {
  const cached = RGB_CACHE.get(colorStr)
  if (cached !== undefined) return cached

  const match = colorStr.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/)
  const result = match
    ? {
        r: parseInt(match[1]!, 10),
        g: parseInt(match[2]!, 10),
        b: parseInt(match[3]!, 10),
      }
    : null
  RGB_CACHE.set(colorStr, result)
  return result
}

// Defensive fallback for the stalled-spinner color when a theme's
// spinnerStalled isn't an rgb() value (e.g. ANSI themes, whose RGB
// interpolation path is never taken). Mirrors DEFAULT_STALL_RED in theme.ts.
const STALL_RED: RGBColorType = { r: 171, g: 43, b: 63 }

// Resolve the RGB color the spinner shifts toward when stalled. Themes set
// spinnerStalled as an rgb() string; parse it, falling back to STALL_RED for
// any non-rgb value.
export function resolveStallColor(theme: Theme): RGBColorType {
  return parseRGB(theme.spinnerStalled) ?? STALL_RED
}
