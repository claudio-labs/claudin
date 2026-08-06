/**
 * The one line worth showing while a long-running tool is still going.
 *
 * Shared by `Build`, `SourceCheck` and `Test`: all three poll a tail of the
 * command's output file once a second, and all three want the same thing out of
 * it — the newest line that says anything, trimmed to fit one row beside the
 * tool name and the clock. It runs on every tick, so it stays cheap and never
 * throws; a missed line costs a slightly worse label for one second, never a
 * wrong result. The real output is parsed once, whole, at the end.
 */

/** How much of a label fits on one row beside the tool name and the clock. */
export const MAX_LABEL_CHARS = 90

/** The last line that has anything on it. */
export function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line !== '') return line
  }
  return undefined
}

/** Collapse the runs of whitespace a toolchain uses to align its columns. */
export function tidyLabel(line: string, maxChars: number = MAX_LABEL_CHARS): string {
  const collapsed = line.replace(/\s+/g, ' ').trim()
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed
}

/**
 * The tidied last line of a tail, or null when the command has printed nothing
 * yet.
 *
 * The `\r` split matters for the runners that redraw one line in place (pytest's
 * progress, gradle's status bar): read as text that is a single line holding
 * every revision at once, and only the final segment is what a terminal would
 * have shown.
 */
export function tailLabel(text: string): string | null {
  const line = lastNonEmptyLine(text)
  if (!line) return null
  const shown = line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line
  return tidyLabel(shown) || null
}
