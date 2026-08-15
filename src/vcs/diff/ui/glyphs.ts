import figures from 'figures'
import {
  FOLDER_ICON,
  FOLDER_OPEN_ICON,
  getFileTypeIcon,
} from 'src/terminal/fileIcons.js'
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
    folderIcon: (open: boolean) =>
      enabled ? (open ? FOLDER_OPEN_ICON : FOLDER_ICON) : '',
    repoIcon: enabled ? REPO_SQUARE : '',
    branchIcon: enabled ? BRANCH_GLYPH : '',
    pointer: figures.pointer,
  }
}
