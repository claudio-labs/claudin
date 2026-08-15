export { FlashingChar } from 'src/terminal/spinner/FlashingChar.js'
export { GlimmerMessage } from 'src/terminal/spinner/GlimmerMessage.js'
export { ShimmerChar } from 'src/terminal/spinner/ShimmerChar.js'
export { SpinnerGlyph } from 'src/terminal/spinner/SpinnerGlyph.js'
export type { SpinnerMode } from 'src/terminal/spinner/types.js'
export { useShimmerAnimation } from 'src/terminal/spinner/useShimmerAnimation.js'
export { useStalledAnimation } from 'src/terminal/spinner/useStalledAnimation.js'
export {
  getDefaultCharacters,
  interpolateColor,
  isBoldSpinnerFrame,
  SPINNER_FRAME_MS,
} from 'src/terminal/spinner/utils.js'
// Teammate components are NOT exported here - use dynamic require() to enable dead code elimination
// See REPL.tsx and Spinner.tsx for the correct import pattern
