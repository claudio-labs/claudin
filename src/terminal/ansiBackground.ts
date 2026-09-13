/**
 * Re-assert a background colour across a row of pre-rendered ANSI.
 *
 * A parent `Box`'s `backgroundColor` does NOT reach a `RawAnsi` row. The
 * renderer takes `ink-raw-ansi` straight to `output.write()` with the box's
 * `inheritedBackgroundColor` skipped (`render-node-to-output.ts`), and every
 * block that has no background of its own emits an explicit `\x1b[49m` — the
 * terminal-default sentinel `native-ts/color-diff` writes — which clobbers the
 * fill the box painted underneath. So a row that has to sit on a tinted
 * surface must carry the tint itself.
 *
 * Blocks that DO carry a real background (a diff's added/removed lines, a word
 * highlight, the editor's inverted block cursor) are left untouched.
 */

const RESET = '\u001B[0m'
const DEFAULT_BG = '\u001B[49m'

/** @param bg An SGR background sequence, e.g. from `themeColorToAnsi(c, true)`. */
export function onBackground(row: string, bg: string): string {
  return (
    bg + row.split(RESET).join(RESET + bg).split(DEFAULT_BG).join(bg) + DEFAULT_BG
  )
}
