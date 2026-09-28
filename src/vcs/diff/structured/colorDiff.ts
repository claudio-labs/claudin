/**
 * The switch in front of the syntax renderer (src/native-ts/color-diff).
 *
 * CLAUDIN_SYNTAX_HIGHLIGHT turns highlighting off when it holds 0, false, no
 * or off, in any case and with blanks around it. Any other value, or none,
 * leaves it on. The variable is read on every call, so a change applies at
 * the next one. While highlighting is off every accessor answers null, and
 * the callers draw plain text instead.
 */
import {
  ColorDiff,
  ColorFile,
  EditorHighlighter,
  getSyntaxTheme as getRendererSyntaxTheme,
  type SyntaxTheme,
} from 'src/native-ts/color-diff/index.js'

export type ColorModuleUnavailableReason = 'env'

const SWITCHED_OFF: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off'])

export function getColorModuleUnavailableReason(): ColorModuleUnavailableReason | null {
  const setting = process.env.CLAUDIN_SYNTAX_HIGHLIGHT
  if (setting === undefined) return null
  return SWITCHED_OFF.has(setting.trim().toLowerCase()) ? 'env' : null
}

function isAvailable(): boolean {
  return getColorModuleUnavailableReason() === null
}

export function expectColorDiff(): typeof ColorDiff | null {
  return isAvailable() ? ColorDiff : null
}

export function expectColorFile(): typeof ColorFile | null {
  return isAvailable() ? ColorFile : null
}

export function expectEditorHighlighter(): typeof EditorHighlighter | null {
  return isAvailable() ? EditorHighlighter : null
}

export function getSyntaxTheme(themeName: string): SyntaxTheme | null {
  return isAvailable() ? getRendererSyntaxTheme(themeName) : null
}
