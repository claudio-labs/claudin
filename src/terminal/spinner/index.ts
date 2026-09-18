export type { SpinnerMode } from 'src/terminal/spinner/types.js'
export {
  getDefaultCharacters,
  isBoldSpinnerFrame,
  SPINNER_FRAME_MS,
} from 'src/terminal/spinner/utils.js'
// Teammate components are NOT exported here - use dynamic require() to enable dead code elimination
// See REPL.tsx and Spinner.tsx for the correct import pattern
