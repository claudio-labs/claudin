import figures from 'figures'
import {
  FOLDER_ICON,
  FOLDER_OPEN_ICON,
  getFileTypeIcon,
  getFileTypeIconColor,
} from 'src/terminal/fileIcons.js'
import type { HexColor } from 'src/terminal/ink/styles.js'
import { hasNerdFontGlyphs } from 'src/terminal/terminalFont.js'

// nf-fa-square — solid square swatch tinted per-repo on group headers.
const REPO_SQUARE = '\uf0c8'
// nf-pl-branch — the powerline git-branch glyph on group-header branches.
const BRANCH_GLYPH = '\ue0a0'

export type DiffGlyphs = {
  /** True when the terminal renders Nerd Font glyphs (icon column shown). */
  enabled: boolean
  /** Per-file-type Nerd Font icon, or '' when disabled (no icon column). */
  fileIcon: (path: string) => string
  /**
   * Per-file-type tint for that icon, or undefined when the type has none
   * (folders, unmapped files). Skip it on a selected row — those render
   * `inverse`, which turns a foreground hex into the row's background.
   */
  fileIconColor: (path: string) => HexColor | undefined
  /** Open/closed folder icon, or '' when disabled (the caret carries state). */
  folderIcon: (open: boolean) => string
  /** Solid square for a repo-group header (colored per-repo), '' when disabled. */
  repoIcon: string
  /** Git-branch glyph for a repo-group header branch, '' when disabled. */
  branchIcon: string
  /** Selection pointer (figures-based, safe everywhere). */
  pointer: string
}

/**
 * Resolve the reviewer's glyph set once. Every Nerd-Font codepoint goes through
 * `fileIcon`, which returns '' on non-Nerd terminals so we never emit tofu.
 * Callers should memoize the result (it reads env each call).
 */
export function getDiffGlyphs(): DiffGlyphs {
  const enabled = hasNerdFontGlyphs()
  return {
    enabled,
    fileIcon: (p: string) => (enabled ? getFileTypeIcon(p) : ''),
    fileIconColor: (p: string) =>
      enabled ? getFileTypeIconColor(p) : undefined,
    folderIcon: (open: boolean) =>
      enabled ? (open ? FOLDER_OPEN_ICON : FOLDER_ICON) : '',
    repoIcon: enabled ? REPO_SQUARE : '',
    branchIcon: enabled ? BRANCH_GLYPH : '',
    pointer: figures.pointer,
  }
}
