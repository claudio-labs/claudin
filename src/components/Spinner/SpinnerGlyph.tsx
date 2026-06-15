import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { Box, Text, useTheme } from '../../ink.js';
import { getTheme, type Theme } from '../../utils/theme.js';
import { getDefaultCharacters, interpolateColor, isBoldSpinnerFrame, isBrandCFrame, isGlyphShimmerHit, parseRGB, resolveStallColor, toRGBColor } from './utils.js';
const DEFAULT_CHARACTERS = getDefaultCharacters();
// No mirroring: the arc→C frames are a directional rotation (see getDefaultCharacters).
const SPINNER_FRAMES = [...DEFAULT_CHARACTERS];
const REDUCED_MOTION_DOT = '●';
const REDUCED_MOTION_CYCLE_MS = 2000; // 2-second cycle: 1s visible, 1s dim
type Props = {
  frame: number;
  messageColor: keyof Theme;
  stalledIntensity?: number;
  reducedMotion?: boolean;
  time?: number;
  /** Verb shimmer position (message coordinates). When provided along with
   * shimmerColor, the sweep continues across the glyph while the brand C
   * is showing. */
  glimmerIndex?: number;
  shimmerColor?: keyof Theme;
};
export function SpinnerGlyph(t0) {
  const $ = _c(11);
  const {
    frame,
    messageColor,
    stalledIntensity: t1,
    reducedMotion: t2,
    time: t3,
    glimmerIndex,
    shimmerColor
  } = t0;
  const stalledIntensity = t1 === undefined ? 0 : t1;
  const reducedMotion = t2 === undefined ? false : t2;
  const time = t3 === undefined ? 0 : t3;
  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  if (reducedMotion) {
    const isDim = Math.floor(time / (REDUCED_MOTION_CYCLE_MS / 2)) % 2 === 1;
    let t4;
    if ($[0] !== isDim || $[1] !== messageColor) {
      t4 = <Box flexWrap="wrap" height={1} width={2}><Text color={messageColor} dimColor={isDim}>{REDUCED_MOTION_DOT}</Text></Box>;
      $[0] = isDim;
      $[1] = messageColor;
      $[2] = t4;
    } else {
      t4 = $[2];
    }
    return t4;
  }
  const spinnerChar = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  // Brand C weight: bold during the first ~3s of the resolved C, normal after.
  const bold = isBoldSpinnerFrame(frame);
  // Let the verb's shimmer sweep continue across the glyph cell while the
  // brand C is showing (the glyph sits at message-coordinate -2).
  const glyphColor = shimmerColor !== undefined && glimmerIndex !== undefined && isBrandCFrame(frame) && isGlyphShimmerHit(glimmerIndex) ? shimmerColor : messageColor;
  if (stalledIntensity > 0) {
    const baseColorStr = theme[messageColor];
    const baseRGB = baseColorStr ? parseRGB(baseColorStr) : null;
    const stallRGB = resolveStallColor(theme);
    if (baseRGB) {
      const interpolated = interpolateColor(baseRGB, stallRGB, stalledIntensity);
      return <Box flexWrap="wrap" height={1} width={2}><Text bold={bold} color={toRGBColor(interpolated)}>{spinnerChar}</Text></Box>;
    }
    const color = stalledIntensity > 0.5 ? "spinnerStalled" : messageColor;
    let t4;
    if ($[3] !== color || $[4] !== spinnerChar || $[5] !== bold) {
      t4 = <Box flexWrap="wrap" height={1} width={2}><Text bold={bold} color={color}>{spinnerChar}</Text></Box>;
      $[3] = color;
      $[4] = spinnerChar;
      $[5] = bold;
      $[6] = t4;
    } else {
      t4 = $[6];
    }
    return t4;
  }
  let t4;
  if ($[7] !== glyphColor || $[8] !== spinnerChar || $[9] !== bold) {
    t4 = <Box flexWrap="wrap" height={1} width={2}><Text bold={bold} color={glyphColor}>{spinnerChar}</Text></Box>;
    $[7] = glyphColor;
    $[8] = spinnerChar;
    $[9] = bold;
    $[10] = t4;
  } else {
    t4 = $[10];
  }
  return t4;
}
