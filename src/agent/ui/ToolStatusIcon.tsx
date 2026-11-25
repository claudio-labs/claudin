import React from 'react';
import { Box, type DOMElement, Text, useAnimationFrame, useTerminalFocus, useTheme } from 'src/terminal/ink.js';
import type { Color } from 'src/terminal/ink/styles.js';
import { interpolateColor, parseRGB, toRGBColor } from 'src/terminal/spinner/utils.js';
import { type AppState, useAppStateMaybeOutsideOfProvider } from 'src/terminal/state/AppState.js';
import { getTheme, type Theme } from 'src/terminal/theme/theme.js';

// A tool row can render outside an AppStateProvider (AssistantToolUseMessage
// reads its own state the same way); with no setting to read, motion stays on.
const selectReducedMotion = (s: AppState) => s.settings.prefersReducedMotion;

// A tool's Nerd Font icon standing in for ToolUseLoader's ● — the status the
// dot carried in its color and blink, the icon carries in its color and fade.
// Without a Nerd Font there is no icon, and callers keep ToolUseLoader.

export type ToolIconStatus = 'running' | 'pending' | 'error' | 'done';

/** ToolUseLoader's states as an icon shows them: a queued call is pending,
 *  an async agent counts as running for as long as it lives, an error wins
 *  over the rest, and an unresolved call runs only while it animates. */
export function toolIconStatus({
  isQueued = false,
  isAsync = false,
  isError,
  isUnresolved,
  shouldAnimate
}: {
  isQueued?: boolean;
  isAsync?: boolean;
  isError: boolean;
  isUnresolved: boolean;
  shouldAnimate: boolean;
}): ToolIconStatus {
  if (isQueued) return 'pending';
  if (isAsync) return 'running';
  if (isError) return 'error';
  if (isUnresolved) return shouldAnimate ? 'running' : 'pending';
  return 'done';
}

/** A running icon fades between the green the dot had and the text color: a
 *  2 s sine off the shared animation clock, so every running icon pulses in
 *  step. A theme without rgb() values for them (the ANSI ones) switches
 *  between the two at the half-way point instead. */
export function fadeColor(theme: Theme, time: number): keyof Theme | Color {
  const flash = (Math.sin(time / 1000 * Math.PI) + 1) / 2;
  const green = parseRGB(theme.success);
  const text = parseRGB(theme.text);
  if (green && text) return toRGBColor(interpolateColor(green, text, flash));
  return flash > 0.5 ? 'text' : 'success';
}

function useToolIconColor(status: ToolIconStatus): [ref: (element: DOMElement | null) => void, color: keyof Theme | Color | undefined, dim: boolean] {
  const reducedMotion = useAppStateMaybeOutsideOfProvider(selectReducedMotion) ?? false;
  const focused = useTerminalFocus();
  const fading = status === 'running' && focused && !reducedMotion;
  // 0 = every clock tick, like the spinner; null unsubscribes once it stops.
  const [ref, time] = useAnimationFrame(fading ? 0 : null);
  const [themeName] = useTheme();
  if (status === 'error') return [ref, 'error', false];
  if (status === 'pending') return [ref, undefined, true];
  if (status === 'done') return [ref, undefined, false];
  return [ref, fading ? fadeColor(getTheme(themeName), time) : 'success', false];
}

/** The icon in the row's leading two columns, where ToolUseLoader's dot sat.
 *  A finished call takes the default text color. */
export function ToolStatusIcon({
  icon,
  status
}: {
  icon: string;
  status: ToolIconStatus;
}): React.ReactNode {
  const [ref, color, dim] = useToolIconColor(status);
  return <Box ref={ref} minWidth={2}><Text color={color} dimColor={dim}>{icon}</Text></Box>;
}

/** The same icon inline, inside a parent Text (a collapsed group's line). A
 *  finished one has no color of its own, so it takes the line's. */
export function ToolStatusGlyph({
  icon,
  status
}: {
  icon: string;
  status: ToolIconStatus;
}): React.ReactNode {
  const [, color, dim] = useToolIconColor(status);
  return <Text color={color} dimColor={dim}>{icon}</Text>;
}
