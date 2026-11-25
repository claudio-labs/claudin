import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { Box, Text } from 'src/terminal/ink.js';
import type { Theme } from 'src/terminal/theme/theme.js';
import { getDefaultCharacters, isBoldSpinnerFrame } from 'src/terminal/spinner/utils.js';
const DEFAULT_CHARACTERS = getDefaultCharacters();
// No mirroring: the orbit is a directional rotation (see getDefaultCharacters).
const SPINNER_FRAMES = [...DEFAULT_CHARACTERS];
type Props = {
  frame: number;
  messageColor: keyof Theme;
};
export function SpinnerGlyph(t0: Props) {
  const $ = _c(4);
  const {
    frame,
    messageColor
  } = t0;
  const spinnerChar = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  const bold = isBoldSpinnerFrame(frame);
  let t1;
  if ($[0] !== messageColor || $[1] !== spinnerChar || $[2] !== bold) {
    t1 = <Box flexWrap="wrap" height={1} width={2}><Text bold={bold} color={messageColor}>{spinnerChar}</Text></Box>;
    $[0] = messageColor;
    $[1] = spinnerChar;
    $[2] = bold;
    $[3] = t1;
  } else {
    t1 = $[3];
  }
  return t1;
}
