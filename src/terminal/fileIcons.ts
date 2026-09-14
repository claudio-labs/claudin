import path from 'node:path'
import type { HexColor } from 'src/terminal/ink/styles.js'

// Nerd Font file-type glyphs for the `@` mention autocomplete menu. Each entry
// is a single private-use-area codepoint; callers MUST gate on
// `hasNerdFontGlyphs()` (src/terminal/terminalFont.ts) so non-Nerd terminals fall
// back to ASCII and never render tofu.

export const FOLDER_ICON = '\uf07b' // nf-fa-folder (closed)
export const FOLDER_OPEN_ICON = '\uf07c' // nf-fa-folder_open
export const GENERIC_FILE_ICON = '\uf15b' // nf-fa-file
export const CONFIG_ICON = '\ue615' // nf-seti-config — used for .env* dotfiles

// Matched by exact basename (lowercased) BEFORE the extension lookup, so a
// well-known filename wins over its extension (e.g. package.json → node glyph,
// not the generic json glyph).
export const FILENAME_ICONS: Record<string, string> = {
  'package.json': '\ued0d', // nf-md-nodejs
  dockerfile: '\uf308', // nf-linux-docker
  '.dockerignore': '\uf308',
  '.gitignore': '\ue702', // nf-dev-git
  '.gitattributes': '\ue702',
  license: '\uf718', // nf-oct-law
  'bun.lock': '\uf023', // nf-fa-lock
  // README* is handled by a prefix check → markdown glyph.
}

export const EXTENSION_ICONS: Record<string, string> = {
  '.ts': '\ue628', // nf-seti-typescript
  '.tsx': '\ue7ba', // nf-dev-react
  '.js': '\ue781', // nf-seti-javascript
  '.jsx': '\ue7ba',
  '.mjs': '\ue781',
  '.cjs': '\ue781',
  '.json': '\ue60b', // nf-seti-json
  '.md': '\ue73e', // nf-dev-markdown
  '.markdown': '\ue73e',
  '.toml': '\ue615', // nf-seti-config
  '.yaml': '\ue615',
  '.yml': '\ue615',
  '.py': '\ue606', // nf-seti-python
  '.rs': '\ue7a8', // nf-dev-rust
  '.go': '\ue627', // nf-seti-go
  '.sh': '\uf489', // nf-oct-terminal
  '.bash': '\uf489',
  '.zsh': '\uf489',
  '.css': '\ue749', // nf-dev-css3
  '.scss': '\ue74b', // nf-dev-sass
  '.html': '\ue736', // nf-dev-html5
  '.htm': '\ue736',
  '.png': '\uf1c5', // nf-fa-file_image_o
  '.jpg': '\uf1c5',
  '.jpeg': '\uf1c5',
  '.gif': '\uf1c5',
  '.svg': '\uf1c5',
  '.webp': '\uf1c5',
  '.lock': '\uf023', // nf-fa-lock
}

// Per-glyph colors, in the nvim-web-devicons palette the Nerd Font glyphs were
// drawn for. Keyed by the GLYPH and not by the extension, so two extensions
// sharing an icon (.yaml/.toml, .png/.svg) can never drift apart in color.
//
// Two families are deliberately ABSENT so they inherit the theme's text color:
// the folder glyphs, and the generic file fallback — tinting those would fight
// the theme on exactly the rows that carry no type information.
export const ICON_COLORS: Record<string, HexColor> = {
  '\ue628': '#519aba', // typescript
  '\ue7ba': '#61dafb', // react (.tsx/.jsx)
  '\ue781': '#cbcb41', // javascript
  '\ue60b': '#cbcb41', // json
  '\ue73e': '#519aba', // markdown
  '\ue615': '#6d8086', // config (.toml/.yaml/.env)
  '\ue606': '#ffbc03', // python
  '\ue7a8': '#dea584', // rust
  '\ue627': '#519aba', // go
  '\uf489': '#89e051', // shell
  '\ue749': '#563d7c', // css
  '\ue74b': '#f55385', // sass
  '\ue736': '#e34c26', // html
  '\uf1c5': '#a074c4', // image
  '\uf023': '#bbbbbb', // lock
  '\ued0d': '#8bc34a', // node (package.json)
  '\uf308': '#458ee6', // docker
  '\ue702': '#f14c28', // git
  '\uf718': '#d0bf41', // license
}

/**
 * Returns the Nerd Font glyph for a suggestion's display path. Directories are
 * detected by a trailing separator (file suggestions always append `path.sep`
 * to directory entries — see src/terminal/prompt-suggestion/fileSuggestions.ts). Falls back to a
 * generic file glyph for anything unmapped.
 */
export function getFileTypeIcon(displayText: string): string {
  if (displayText.endsWith(path.sep) || displayText.endsWith('/')) {
    return FOLDER_ICON
  }
  const base = path.basename(displayText).toLowerCase()
  if (base.startsWith('readme')) return EXTENSION_ICONS['.md']!
  // Dotfiles like `.env`, `.env.local`, `.env.example`: path.extname returns
  // '' for a pure dotfile, so match by basename prefix BEFORE the extname
  // lookup would otherwise drop them onto the generic fallback.
  if (base.startsWith('.env')) return CONFIG_ICON
  const filenameIcon = FILENAME_ICONS[base]
  if (filenameIcon) return filenameIcon
  const ext = path.extname(base)
  return EXTENSION_ICONS[ext] ?? GENERIC_FILE_ICON
}

/**
 * Color for a path's file-type glyph, or `undefined` when its type has none —
 * folders and unmapped files keep whatever color the row already has.
 *
 * Callers MUST skip the color on a selected row: those rows render `inverse`
 * (or carry a highlight background), where a foreground hex comes back as the
 * row's background instead of as the glyph.
 */
export function getFileTypeIconColor(displayText: string): HexColor | undefined {
  return ICON_COLORS[getFileTypeIcon(displayText)]
}
