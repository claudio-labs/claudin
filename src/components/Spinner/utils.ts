import type { RGBColor as RGBColorString } from '../../ink/styles.js'
import type { Theme } from '../../utils/theme.js'
import type { RGBColor as RGBColorType } from './types.js'

export function getDefaultCharacters(): string[] {
  // Claudin brand "braille orbit → C": the classic 10-frame braille dots
  // spinner orbits three full turns, then resolves on the brand C — bold for
  // ~3s, normal weight for ~2s (see isBoldSpinnerFrame). Each braille frame is
  // held BRAILLE_HOLD ticks so the orbit spins slower (~7.2s for three turns at
  // the 120ms tick with BRAILLE_HOLD=2). Braille glyphs (U+2800 block) are true
  // narrow width everywhere, unlike the ◜◝◞◟ arcs.
  // NOTE: rotation is directional, so consumers must NOT mirror these frames
  // (forward + reverse would make the orbit ping-pong instead of spin).
  return [
    ...SLOW_ORBIT,
    ...SLOW_ORBIT,
    ...SLOW_ORBIT,
    ...Array(BOLD_C_FRAMES + NORMAL_C_FRAMES).fill('C'),
  ]
}

const ORBIT = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
// Hold each braille frame for this many animation ticks; higher = slower spin
// (1 = original speed, 2 ≈ half speed at the 120ms tick).
const BRAILLE_HOLD = 2
const SLOW_ORBIT = ORBIT.flatMap((c) => Array(BRAILLE_HOLD).fill(c) as string[])
const ORBIT_FRAMES = SLOW_ORBIT.length * 3
const BOLD_C_FRAMES = 25 // ~3s at the 120ms tick
const NORMAL_C_FRAMES = 17 // ~2s
const TOTAL_FRAMES = ORBIT_FRAMES + BOLD_C_FRAMES + NORMAL_C_FRAMES

// Whether this frame index falls in the bold window of the resolved C
// (first ~3s after the orbit; the trailing ~2s render at normal weight).
// Accepts either a raw monotonically-increasing frame counter or an index
// already reduced modulo the frame count.
export function isBoldSpinnerFrame(frame: number): boolean {
  const i = frame % TOTAL_FRAMES
  return i >= ORBIT_FRAMES && i < ORBIT_FRAMES + BOLD_C_FRAMES
}

// Whether this frame index falls anywhere in the resolved-C window (bold or
// normal weight). Used to let the verb's shimmer sweep continue across the
// glyph cell while the brand C is showing.
export function isBrandCFrame(frame: number): boolean {
  return frame % TOTAL_FRAMES >= ORBIT_FRAMES
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
