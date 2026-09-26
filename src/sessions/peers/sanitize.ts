import stripAnsi from 'strip-ansi'
import { partiallySanitizeUnicode } from 'src/shared/data/sanitization.js'

// C0 and C1 controls, DEL included, but not tab and newline.
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

/**
 * Another session's text as this session shows it and its model reads it —
 * one and the same string. Terminal escapes go (a concealed or recoloured span
 * would read one way to the user approving a held message and another to the
 * model), so do bidi overrides and the other invisible code points
 * partiallySanitizeUnicode strips, and every control but tab and newline — a
 * bare CR could overwrite a line.
 */
export function sanitizePeerText(text: string): string {
  return partiallySanitizeUnicode(stripAnsi(text)).replace(CONTROL_RE, '')
}
