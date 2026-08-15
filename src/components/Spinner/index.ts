export { FlashingChar } from 'src/components/Spinner/FlashingChar.js'
export { GlimmerMessage } from 'src/components/Spinner/GlimmerMessage.js'
export { ShimmerChar } from 'src/components/Spinner/ShimmerChar.js'
export { SpinnerGlyph } from 'src/components/Spinner/SpinnerGlyph.js'
export type { SpinnerMode } from 'src/components/Spinner/types.js'
export { useShimmerAnimation } from 'src/components/Spinner/useShimmerAnimation.js'
export { useStalledAnimation } from 'src/components/Spinner/useStalledAnimation.js'
export {
  getDefaultCharacters,
  interpolateColor,
  isBoldSpinnerFrame,
  SPINNER_FRAME_MS,
} from 'src/components/Spinner/utils.js'
// Teammate components are NOT exported here - use dynamic require() to enable dead code elimination
// See REPL.tsx and Spinner.tsx for the correct import pattern
