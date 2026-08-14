/**
 * Pure TypeScript port of vendor/color-diff-src.
 *
 * The Rust version uses syntect+bat for syntax highlighting and the similar
 * crate for word diffing. This port uses highlight.js (already a dep via
 * cli-highlight) and the diff npm package's diffArrays.
 *
 * API matches vendor/color-diff-src/index.d.ts exactly so callers don't change.
 *
 * Key semantic differences from the native module:
 * - Syntax highlighting uses highlight.js. Scope colors were measured from
 *   syntect's output so most tokens match, but hljs's grammar has gaps:
 *   plain identifiers and operators like `=` `:` aren't scoped, so they
 *   render in default fg instead of white/pink. Output structure (line
 *   numbers, markers, backgrounds, word-diff) is identical.
 * - BAT_THEME env support is a stub: highlight.js has no bat theme set, so
 *   getSyntaxTheme always returns the default for the given Claude theme.
 */

import { diffArrays } from 'diff'
import type * as hljsNamespace from 'highlight.js'
import { basename, extname } from 'path'

// Lazy: defers loading highlight.js until first render. The full default
// bundle (`require('highlight.js')`) registers 190+ language grammars at
// require time (~50MB, 100-200ms on macOS, several× that on Windows). With
// a top-level import, any caller chunk that reaches this module — including
// test/preload.ts via StructuredDiff.tsx → colorDiff.ts — pays that cost at
// module-eval time and carries the heap for the rest of the process. On
// Windows CI this pushed later tests in the same shard into GC-pause
// territory and a beforeEach/afterEach hook timeout (officialRegistry.test.ts,
// PR #24150). Same lazy pattern the NAPI wrapper used for dlopen.
//
// We additionally use `highlight.js/lib/core` + selective registerLanguage
// (the 29 we actually highlight) instead of the default bundle. Brings the
// register-time hit down to ~10-15MB heap and ~30-50ms parse, vs the
// 50MB/100-200ms above. Anything else falls back to plain text in this
// renderer (matches how syntect treats unknown languages).
type HLJSApi = typeof hljsNamespace
let cachedHljs: HLJSApi | null = null
function hljs(): HLJSApi {
  if (cachedHljs) return cachedHljs
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const coreMod = require('highlight.js/lib/core')
  const core: HLJSApi =
    'default' in coreMod && coreMod.default ? coreMod.default : coreMod
  /* eslint-disable @typescript-eslint/no-require-imports */
  // Static requires (not `require(`.../${mod}`)`) so Bun's --compile bundler
  // can statically resolve each grammar and embed it in the binary's VFS.
  // A template-literal require is opaque to the bundler → the compiled binary
  // throws "Cannot find module 'highlight.js/lib/languages/typescript'".
  const langs: ReadonlyArray<readonly [string, unknown]> = [
    ['typescript', require('highlight.js/lib/languages/typescript')],
    ['javascript', require('highlight.js/lib/languages/javascript')],
    ['python', require('highlight.js/lib/languages/python')],
    ['go', require('highlight.js/lib/languages/go')],
    ['rust', require('highlight.js/lib/languages/rust')],
    ['java', require('highlight.js/lib/languages/java')],
    ['c', require('highlight.js/lib/languages/c')],
    ['cpp', require('highlight.js/lib/languages/cpp')],
    ['csharp', require('highlight.js/lib/languages/csharp')],
    ['ruby', require('highlight.js/lib/languages/ruby')],
    ['php', require('highlight.js/lib/languages/php')],
    ['swift', require('highlight.js/lib/languages/swift')],
    ['kotlin', require('highlight.js/lib/languages/kotlin')],
    ['bash', require('highlight.js/lib/languages/bash')],
    ['shell', require('highlight.js/lib/languages/shell')],
    ['json', require('highlight.js/lib/languages/json')],
    ['yaml', require('highlight.js/lib/languages/yaml')],
    ['xml', require('highlight.js/lib/languages/xml')],
    ['css', require('highlight.js/lib/languages/css')],
    ['scss', require('highlight.js/lib/languages/scss')],
    ['sql', require('highlight.js/lib/languages/sql')],
    ['markdown', require('highlight.js/lib/languages/markdown')],
    ['dockerfile', require('highlight.js/lib/languages/dockerfile')],
    ['diff', require('highlight.js/lib/languages/diff')],
    ['plaintext', require('highlight.js/lib/languages/plaintext')],
    ['ini', require('highlight.js/lib/languages/ini')],
    ['lua', require('highlight.js/lib/languages/lua')],
    ['perl', require('highlight.js/lib/languages/perl')],
    ['elixir', require('highlight.js/lib/languages/elixir')],
  ]
  for (const [name, m] of langs) {
    const lang =
      m && typeof m === 'object' && 'default' in m
        ? (m as { default: unknown }).default
        : m
    core.registerLanguage(name, lang as Parameters<typeof core.registerLanguage>[1])
  }
  /* eslint-enable @typescript-eslint/no-require-imports */
  cachedHljs = core
  return cachedHljs!
}

import { stringWidth } from 'src/ink/stringWidth.js'
import { logError } from 'src/utils/log.js'

// ---------------------------------------------------------------------------
// Public API types (match vendor/color-diff-src/index.d.ts)
// ---------------------------------------------------------------------------

export type Hunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export type SyntaxTheme = {
  theme: string
  source: string | null
}

export type NativeModule = {
  ColorDiff: typeof ColorDiff
  ColorFile: typeof ColorFile
  getSyntaxTheme: (themeName: string) => SyntaxTheme
}

// ---------------------------------------------------------------------------
// Color / ANSI escape helpers
// ---------------------------------------------------------------------------

type Color = { r: number; g: number; b: number; a: number }
type Style = { foreground: Color; background: Color }
type Block = [Style, string]
type ColorMode = 'truecolor' | 'color256' | 'ansi'

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const UNDIM = '\x1b[22m'

function rgb(r: number, g: number, b: number): Color {
  return { r, g, b, a: 255 }
}

function ansiIdx(index: number): Color {
  return { r: index, g: 0, b: 0, a: 0 }
}

// Sentinel: a=1 means "terminal default" (matches bat convention)
const DEFAULT_BG: Color = { r: 0, g: 0, b: 0, a: 1 }

function detectColorMode(theme: string): ColorMode {
  if (isAnsiThemeName(theme)) return 'ansi'
  const ct = process.env.COLORTERM ?? ''
  return ct === 'truecolor' || ct === '24bit' ? 'truecolor' : 'color256'
}

// Port of ansi_colours::ansi256_from_rgb — approximates RGB to the xterm-256
// palette (6x6x6 cube + 24 greys). Picks the perceptually closest index by
// comparing cube vs grey-ramp candidates, like the Rust crate.
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255]
function ansi256FromRgb(r: number, g: number, b: number): number {
  const q = (c: number) =>
    c < 48 ? 0 : c < 115 ? 1 : c < 155 ? 2 : c < 195 ? 3 : c < 235 ? 4 : 5
  const qr = q(r)
  const qg = q(g)
  const qb = q(b)
  const cubeIdx = 16 + 36 * qr + 6 * qg + qb
  // Grey ramp candidate (232-255, levels 8..238 step 10). Beyond the ramp's
  // range the cube corner is the only option — ansi_colours snaps 248,248,242
  // to 231 (cube white), not 255 (ramp top).
  const grey = Math.round((r + g + b) / 3)
  if (grey < 5) return 16
  if (grey > 244 && qr === qg && qg === qb) return cubeIdx
  const greyLevel = Math.max(0, Math.min(23, Math.round((grey - 8) / 10)))
  const greyIdx = 232 + greyLevel
  const greyRgb = 8 + greyLevel * 10
  const cr = CUBE_LEVELS[qr]!
  const cg = CUBE_LEVELS[qg]!
  const cb = CUBE_LEVELS[qb]!
  const dCube = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
  const dGrey = (r - greyRgb) ** 2 + (g - greyRgb) ** 2 + (b - greyRgb) ** 2
  return dGrey < dCube ? greyIdx : cubeIdx
}

function colorToEscape(c: Color, fg: boolean, mode: ColorMode): string {
  // alpha=0: palette index encoded in .r (bat's ansi-theme convention)
  if (c.a === 0) {
    const idx = c.r
    if (idx < 8) return `\x1b[${(fg ? 30 : 40) + idx}m`
    if (idx < 16) return `\x1b[${(fg ? 90 : 100) + (idx - 8)}m`
    return `\x1b[${fg ? 38 : 48};5;${idx}m`
  }
  // alpha=1: terminal default
  if (c.a === 1) return fg ? '\x1b[39m' : '\x1b[49m'

  const codeType = fg ? 38 : 48
  if (mode === 'truecolor') {
    return `\x1b[${codeType};2;${c.r};${c.g};${c.b}m`
  }
  return `\x1b[${codeType};5;${ansi256FromRgb(c.r, c.g, c.b)}m`
}

function asTerminalEscaped(
  blocks: readonly Block[],
  mode: ColorMode,
  skipBackground: boolean,
  dim: boolean,
): string {
  let out = dim ? RESET + DIM : RESET
  for (const [style, text] of blocks) {
    out += colorToEscape(style.foreground, true, mode)
    if (!skipBackground) {
      out += colorToEscape(style.background, false, mode)
    }
    out += text
  }
  return out + RESET
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

type Marker = '+' | '-' | ' '

type Theme = {
  addLine: Color
  addWord: Color
  addDecoration: Color
  deleteLine: Color
  deleteWord: Color
  deleteDecoration: Color
  foreground: Color
  background: Color
  scopes: Record<string, Color>
}

// Dark theme names whose name doesn't literally contain "dark" (the diff/syntax
// classification below keys off the name, not the palette). Keep in sync with
// the dark entries in THEME_NAMES (src/utils/theme.ts).
const DARK_THEME_NAMES = new Set([
  'dracula',
  'catppuccin-mocha',
  'tokyo-night',
  'nord',
])

function isDarkThemeName(themeName: string): boolean {
  return themeName.includes('dark') || DARK_THEME_NAMES.has(themeName)
}

// The 'terminal' (inherit) theme uses the same terminal-default-bg + 16-color
// ANSI rendering as the explicit ansi themes, so route it through that branch.
function isAnsiThemeName(themeName: string): boolean {
  return themeName.includes('ansi') || themeName === 'terminal'
}

function defaultSyntaxThemeName(themeName: string): string {
  if (isAnsiThemeName(themeName)) return 'ansi'
  if (themeName === 'dracula') return 'Dracula'
  if (themeName === 'catppuccin-mocha') return 'Catppuccin Mocha'
  if (themeName === 'catppuccin-latte') return 'Catppuccin Latte'
  if (themeName === 'tokyo-night') return 'Tokyo Night'
  if (themeName === 'nord') return 'Nord'
  if (themeName === 'gruvbox-dark') return 'Gruvbox Dark'
  if (isDarkThemeName(themeName)) return 'Monokai Extended'
  return 'GitHub'
}

// highlight.js scope → syntect Monokai Extended foreground (measured from the
// Rust module's output so colors match the original exactly)
const MONOKAI_SCOPES: Record<string, Color> = {
  keyword: rgb(249, 38, 114),
  _storage: rgb(102, 217, 239),
  built_in: rgb(166, 226, 46),
  type: rgb(166, 226, 46),
  literal: rgb(190, 132, 255),
  number: rgb(190, 132, 255),
  string: rgb(230, 219, 116),
  title: rgb(166, 226, 46),
  'title.function': rgb(166, 226, 46),
  'title.class': rgb(166, 226, 46),
  'title.class.inherited': rgb(166, 226, 46),
  params: rgb(253, 151, 31),
  comment: rgb(117, 113, 94),
  meta: rgb(117, 113, 94),
  attr: rgb(166, 226, 46),
  attribute: rgb(166, 226, 46),
  variable: rgb(255, 255, 255),
  'variable.language': rgb(255, 255, 255),
  property: rgb(255, 255, 255),
  operator: rgb(249, 38, 114),
  punctuation: rgb(248, 248, 242),
  symbol: rgb(190, 132, 255),
  regexp: rgb(230, 219, 116),
  subst: rgb(248, 248, 242),
}

// highlight.js scope → syntect GitHub-light foreground (measured from Rust)
const GITHUB_SCOPES: Record<string, Color> = {
  keyword: rgb(167, 29, 93),
  _storage: rgb(167, 29, 93),
  built_in: rgb(0, 134, 179),
  type: rgb(0, 134, 179),
  literal: rgb(0, 134, 179),
  number: rgb(0, 134, 179),
  string: rgb(24, 54, 145),
  title: rgb(121, 93, 163),
  'title.function': rgb(121, 93, 163),
  'title.class': rgb(0, 0, 0),
  'title.class.inherited': rgb(0, 0, 0),
  params: rgb(0, 134, 179),
  comment: rgb(150, 152, 150),
  meta: rgb(150, 152, 150),
  attr: rgb(0, 134, 179),
  attribute: rgb(0, 134, 179),
  variable: rgb(0, 134, 179),
  'variable.language': rgb(0, 134, 179),
  property: rgb(0, 134, 179),
  operator: rgb(167, 29, 93),
  punctuation: rgb(51, 51, 51),
  symbol: rgb(0, 134, 179),
  regexp: rgb(24, 54, 145),
  subst: rgb(51, 51, 51),
}

// highlight.js scope → Dracula spec foreground (https://spec.draculatheme.com)
const DRACULA_SCOPES: Record<string, Color> = {
  keyword: rgb(255, 121, 198), // Pink
  _storage: rgb(255, 121, 198), // Pink
  built_in: rgb(139, 233, 253), // Cyan
  type: rgb(139, 233, 253), // Cyan
  literal: rgb(189, 147, 249), // Purple
  number: rgb(189, 147, 249), // Purple
  string: rgb(241, 250, 140), // Yellow
  title: rgb(80, 250, 123), // Green
  'title.function': rgb(80, 250, 123), // Green
  'title.class': rgb(139, 233, 253), // Cyan
  'title.class.inherited': rgb(139, 233, 253), // Cyan
  params: rgb(255, 184, 108), // Orange
  comment: rgb(98, 114, 164), // Comment blue
  meta: rgb(98, 114, 164), // Comment blue
  attr: rgb(80, 250, 123), // Green
  attribute: rgb(80, 250, 123), // Green
  variable: rgb(248, 248, 242), // Foreground
  'variable.language': rgb(189, 147, 249), // Purple (this/self)
  property: rgb(248, 248, 242), // Foreground
  operator: rgb(255, 121, 198), // Pink
  punctuation: rgb(248, 248, 242), // Foreground
  symbol: rgb(189, 147, 249), // Purple
  regexp: rgb(241, 250, 140), // Yellow
  subst: rgb(248, 248, 242), // Foreground
}

// highlight.js scope → Catppuccin Mocha foreground (https://catppuccin.com)
const CATPPUCCIN_MOCHA_SCOPES: Record<string, Color> = {
  keyword: rgb(203, 166, 247), // Mauve
  _storage: rgb(203, 166, 247), // Mauve
  built_in: rgb(249, 226, 175), // Yellow
  type: rgb(249, 226, 175), // Yellow
  literal: rgb(250, 179, 135), // Peach
  number: rgb(250, 179, 135), // Peach
  string: rgb(166, 227, 161), // Green
  title: rgb(137, 180, 250), // Blue
  'title.function': rgb(137, 180, 250), // Blue
  'title.class': rgb(249, 226, 175), // Yellow
  'title.class.inherited': rgb(249, 226, 175), // Yellow
  params: rgb(235, 160, 172), // Maroon
  comment: rgb(147, 153, 178), // Overlay2
  meta: rgb(147, 153, 178), // Overlay2
  attr: rgb(249, 226, 175), // Yellow
  attribute: rgb(249, 226, 175), // Yellow
  variable: rgb(205, 214, 244), // Text
  'variable.language': rgb(243, 139, 168), // Red (this/self)
  property: rgb(205, 214, 244), // Text
  operator: rgb(137, 220, 235), // Sky
  punctuation: rgb(147, 153, 178), // Overlay2
  symbol: rgb(250, 179, 135), // Peach
  regexp: rgb(245, 194, 231), // Pink
  subst: rgb(205, 214, 244), // Text
}

// highlight.js scope → Catppuccin Latte foreground (https://catppuccin.com)
const CATPPUCCIN_LATTE_SCOPES: Record<string, Color> = {
  keyword: rgb(136, 57, 239), // Mauve
  _storage: rgb(136, 57, 239), // Mauve
  built_in: rgb(223, 142, 29), // Yellow
  type: rgb(223, 142, 29), // Yellow
  literal: rgb(254, 100, 11), // Peach
  number: rgb(254, 100, 11), // Peach
  string: rgb(64, 160, 43), // Green
  title: rgb(30, 102, 245), // Blue
  'title.function': rgb(30, 102, 245), // Blue
  'title.class': rgb(223, 142, 29), // Yellow
  'title.class.inherited': rgb(223, 142, 29), // Yellow
  params: rgb(230, 69, 83), // Maroon
  comment: rgb(124, 127, 147), // Overlay2
  meta: rgb(124, 127, 147), // Overlay2
  attr: rgb(223, 142, 29), // Yellow
  attribute: rgb(223, 142, 29), // Yellow
  variable: rgb(76, 79, 105), // Text
  'variable.language': rgb(210, 15, 57), // Red (this/self)
  property: rgb(76, 79, 105), // Text
  operator: rgb(4, 165, 229), // Sky
  punctuation: rgb(124, 127, 147), // Overlay2
  symbol: rgb(254, 100, 11), // Peach
  regexp: rgb(234, 118, 203), // Pink
  subst: rgb(76, 79, 105), // Text
}

// Fully-resolved diff + syntax palettes for themes whose colors are
// theme-specific (not the generic Monokai/GitHub fallbacks). Background stays
// terminal-default; non-truecolor terminals quantize the rgb() values via
// colorToEscape → ansi256FromRgb, so no mode branching is needed here.
const DRACULA_THEME: Theme = {
  addLine: rgb(35, 70, 50),
  addWord: rgb(45, 95, 65),
  addDecoration: rgb(80, 250, 123), // Green
  deleteLine: rgb(75, 40, 50),
  deleteWord: rgb(100, 45, 60),
  deleteDecoration: rgb(255, 85, 85), // Red
  foreground: rgb(248, 248, 242),
  background: DEFAULT_BG,
  scopes: DRACULA_SCOPES,
}

const CATPPUCCIN_MOCHA_THEME: Theme = {
  addLine: rgb(40, 62, 48),
  addWord: rgb(52, 82, 60),
  addDecoration: rgb(166, 227, 161), // Green
  deleteLine: rgb(70, 42, 52),
  deleteWord: rgb(92, 50, 62),
  deleteDecoration: rgb(243, 139, 168), // Red
  foreground: rgb(205, 214, 244),
  background: DEFAULT_BG,
  scopes: CATPPUCCIN_MOCHA_SCOPES,
}

const CATPPUCCIN_LATTE_THEME: Theme = {
  addLine: rgb(190, 228, 180),
  addWord: rgb(166, 214, 150),
  addDecoration: rgb(64, 160, 43), // Green
  deleteLine: rgb(248, 200, 205),
  deleteWord: rgb(245, 180, 188),
  deleteDecoration: rgb(210, 15, 57), // Red
  foreground: rgb(76, 79, 105),
  background: DEFAULT_BG,
  scopes: CATPPUCCIN_LATTE_SCOPES,
}

// highlight.js scope → Tokyo Night foreground (folke/tokyonight, "night")
const TOKYO_NIGHT_SCOPES: Record<string, Color> = {
  keyword: rgb(187, 154, 247), // Magenta
  _storage: rgb(187, 154, 247), // Magenta
  built_in: rgb(42, 195, 222), // Cyan-blue
  type: rgb(42, 195, 222), // Cyan-blue
  literal: rgb(255, 158, 100), // Orange
  number: rgb(255, 158, 100), // Orange
  string: rgb(158, 206, 106), // Green
  title: rgb(122, 162, 247), // Blue
  'title.function': rgb(122, 162, 247), // Blue
  'title.class': rgb(42, 195, 222), // Cyan-blue
  'title.class.inherited': rgb(42, 195, 222), // Cyan-blue
  params: rgb(224, 175, 104), // Yellow
  comment: rgb(86, 95, 137), // Comment
  meta: rgb(86, 95, 137), // Comment
  attr: rgb(115, 218, 202), // Teal
  attribute: rgb(115, 218, 202), // Teal
  variable: rgb(192, 202, 245), // Foreground
  'variable.language': rgb(247, 118, 142), // Red (this/self)
  property: rgb(115, 218, 202), // Teal
  operator: rgb(137, 221, 255), // Light cyan
  punctuation: rgb(192, 202, 245), // Foreground
  symbol: rgb(255, 158, 100), // Orange
  regexp: rgb(180, 249, 248), // Light teal
  subst: rgb(192, 202, 245), // Foreground
}

// highlight.js scope → Nord foreground (https://www.nordtheme.com)
const NORD_SCOPES: Record<string, Color> = {
  keyword: rgb(129, 161, 193), // Frost blue (nord9)
  _storage: rgb(129, 161, 193), // Frost blue (nord9)
  built_in: rgb(143, 188, 187), // Frost teal (nord7)
  type: rgb(143, 188, 187), // Frost teal (nord7)
  literal: rgb(180, 142, 173), // Purple (nord15)
  number: rgb(180, 142, 173), // Purple (nord15)
  string: rgb(163, 190, 140), // Green (nord14)
  title: rgb(136, 192, 208), // Frost cyan (nord8)
  'title.function': rgb(136, 192, 208), // Frost cyan (nord8)
  'title.class': rgb(143, 188, 187), // Frost teal (nord7)
  'title.class.inherited': rgb(143, 188, 187), // Frost teal (nord7)
  params: rgb(216, 222, 233), // Foreground (nord4)
  comment: rgb(76, 86, 106), // nord3
  meta: rgb(76, 86, 106), // nord3
  attr: rgb(143, 188, 187), // Frost teal (nord7)
  attribute: rgb(143, 188, 187), // Frost teal (nord7)
  variable: rgb(216, 222, 233), // Foreground (nord4)
  'variable.language': rgb(129, 161, 193), // Frost blue (this/self)
  property: rgb(216, 222, 233), // Foreground (nord4)
  operator: rgb(129, 161, 193), // Frost blue (nord9)
  punctuation: rgb(236, 239, 244), // nord6
  symbol: rgb(180, 142, 173), // Purple (nord15)
  regexp: rgb(235, 203, 139), // Yellow (nord13)
  subst: rgb(216, 222, 233), // Foreground (nord4)
}

// highlight.js scope → Gruvbox Dark foreground (https://github.com/morhetz/gruvbox)
const GRUVBOX_DARK_SCOPES: Record<string, Color> = {
  keyword: rgb(251, 73, 52), // Bright red
  _storage: rgb(251, 73, 52), // Bright red
  built_in: rgb(250, 189, 47), // Bright yellow
  type: rgb(250, 189, 47), // Bright yellow
  literal: rgb(211, 134, 155), // Bright purple
  number: rgb(211, 134, 155), // Bright purple
  string: rgb(184, 187, 38), // Bright green
  title: rgb(184, 187, 38), // Bright green
  'title.function': rgb(184, 187, 38), // Bright green
  'title.class': rgb(250, 189, 47), // Bright yellow
  'title.class.inherited': rgb(250, 189, 47), // Bright yellow
  params: rgb(131, 165, 152), // Bright blue
  comment: rgb(146, 131, 116), // Gray
  meta: rgb(146, 131, 116), // Gray
  attr: rgb(142, 192, 124), // Bright aqua
  attribute: rgb(142, 192, 124), // Bright aqua
  variable: rgb(235, 219, 178), // Foreground
  'variable.language': rgb(254, 128, 25), // Bright orange (this/self)
  property: rgb(235, 219, 178), // Foreground
  operator: rgb(142, 192, 124), // Bright aqua
  punctuation: rgb(235, 219, 178), // Foreground
  symbol: rgb(211, 134, 155), // Bright purple
  regexp: rgb(142, 192, 124), // Bright aqua
  subst: rgb(235, 219, 178), // Foreground
}

const TOKYO_NIGHT_THEME: Theme = {
  addLine: rgb(32, 60, 46),
  addWord: rgb(40, 82, 58),
  addDecoration: rgb(158, 206, 106), // Green
  deleteLine: rgb(68, 40, 52),
  deleteWord: rgb(92, 48, 62),
  deleteDecoration: rgb(247, 118, 142), // Red
  foreground: rgb(192, 202, 245),
  background: DEFAULT_BG,
  scopes: TOKYO_NIGHT_SCOPES,
}

const NORD_THEME: Theme = {
  addLine: rgb(45, 60, 48),
  addWord: rgb(56, 76, 58),
  addDecoration: rgb(163, 190, 140), // Green
  deleteLine: rgb(68, 44, 48),
  deleteWord: rgb(90, 52, 56),
  deleteDecoration: rgb(191, 97, 106), // Red
  foreground: rgb(216, 222, 233),
  background: DEFAULT_BG,
  scopes: NORD_SCOPES,
}

const GRUVBOX_DARK_THEME: Theme = {
  addLine: rgb(50, 58, 30),
  addWord: rgb(66, 76, 34),
  addDecoration: rgb(184, 187, 38), // Green
  deleteLine: rgb(80, 45, 40),
  deleteWord: rgb(102, 50, 42),
  deleteDecoration: rgb(251, 73, 52), // Red
  foreground: rgb(235, 219, 178),
  background: DEFAULT_BG,
  scopes: GRUVBOX_DARK_SCOPES,
}

const NAMED_THEME_PALETTES: Record<string, Theme> = {
  dracula: DRACULA_THEME,
  'catppuccin-mocha': CATPPUCCIN_MOCHA_THEME,
  'catppuccin-latte': CATPPUCCIN_LATTE_THEME,
  'tokyo-night': TOKYO_NIGHT_THEME,
  nord: NORD_THEME,
  'gruvbox-dark': GRUVBOX_DARK_THEME,
}

// Keywords that syntect scopes as storage.type rather than keyword.control.
// highlight.js lumps these under "keyword"; we re-split so const/function/etc.
// get the cyan storage color instead of pink.
const STORAGE_KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'class',
  'type',
  'interface',
  'enum',
  'namespace',
  'module',
  'def',
  'fn',
  'func',
  'struct',
  'trait',
  'impl',
])

const ANSI_SCOPES: Record<string, Color> = {
  keyword: ansiIdx(13),
  _storage: ansiIdx(14),
  built_in: ansiIdx(14),
  type: ansiIdx(14),
  literal: ansiIdx(12),
  number: ansiIdx(12),
  string: ansiIdx(10),
  title: ansiIdx(11),
  'title.function': ansiIdx(11),
  'title.class': ansiIdx(11),
  comment: ansiIdx(8),
  meta: ansiIdx(8),
}

function buildTheme(themeName: string, mode: ColorMode): Theme {
  const isDark = isDarkThemeName(themeName)
  const isAnsi = isAnsiThemeName(themeName)
  const isDaltonized = themeName.includes('daltonized')
  const tc = mode === 'truecolor'

  const named = NAMED_THEME_PALETTES[themeName]
  if (named) return named

  if (isAnsi) {
    return {
      addLine: DEFAULT_BG,
      addWord: DEFAULT_BG,
      addDecoration: ansiIdx(10),
      deleteLine: DEFAULT_BG,
      deleteWord: DEFAULT_BG,
      deleteDecoration: ansiIdx(9),
      foreground: ansiIdx(7),
      background: DEFAULT_BG,
      scopes: ANSI_SCOPES,
    }
  }

  if (isDark) {
    const fg = rgb(248, 248, 242)
    const deleteLine = rgb(61, 1, 0)
    const deleteWord = rgb(92, 2, 0)
    const deleteDecoration = rgb(220, 90, 90)
    if (isDaltonized) {
      return {
        addLine: tc ? rgb(0, 27, 41) : ansiIdx(17),
        addWord: tc ? rgb(0, 48, 71) : ansiIdx(24),
        addDecoration: rgb(81, 160, 200),
        deleteLine,
        deleteWord,
        deleteDecoration,
        foreground: fg,
        background: DEFAULT_BG,
        scopes: MONOKAI_SCOPES,
      }
    }
    return {
      addLine: tc ? rgb(2, 40, 0) : ansiIdx(22),
      addWord: tc ? rgb(4, 71, 0) : ansiIdx(28),
      addDecoration: rgb(80, 200, 80),
      deleteLine,
      deleteWord,
      deleteDecoration,
      foreground: fg,
      background: DEFAULT_BG,
      scopes: MONOKAI_SCOPES,
    }
  }

  // light
  const fg = rgb(51, 51, 51)
  const deleteLine = rgb(255, 220, 220)
  const deleteWord = rgb(255, 199, 199)
  const deleteDecoration = rgb(207, 34, 46)
  if (isDaltonized) {
    return {
      addLine: rgb(219, 237, 255),
      addWord: rgb(179, 217, 255),
      addDecoration: rgb(36, 87, 138),
      deleteLine,
      deleteWord,
      deleteDecoration,
      foreground: fg,
      background: DEFAULT_BG,
      scopes: GITHUB_SCOPES,
    }
  }
  return {
    addLine: rgb(220, 255, 220),
    addWord: rgb(178, 255, 178),
    addDecoration: rgb(36, 138, 61),
    deleteLine,
    deleteWord,
    deleteDecoration,
    foreground: fg,
    background: DEFAULT_BG,
    scopes: GITHUB_SCOPES,
  }
}

function defaultStyle(theme: Theme): Style {
  return { foreground: theme.foreground, background: theme.background }
}

function lineBackground(marker: Marker, theme: Theme): Color {
  switch (marker) {
    case '+':
      return theme.addLine
    case '-':
      return theme.deleteLine
    case ' ':
      return theme.background
  }
}

function wordBackground(marker: Marker, theme: Theme): Color {
  switch (marker) {
    case '+':
      return theme.addWord
    case '-':
      return theme.deleteWord
    case ' ':
      return theme.background
  }
}

function decorationColor(marker: Marker, theme: Theme): Color {
  switch (marker) {
    case '+':
      return theme.addDecoration
    case '-':
      return theme.deleteDecoration
    case ' ':
      return theme.foreground
  }
}

// ---------------------------------------------------------------------------
// Syntax highlighting via highlight.js
// ---------------------------------------------------------------------------

// hljs 10.x uses `kind`; 11.x uses `scope`. Handle both.
type HljsNode = {
  scope?: string
  kind?: string
  children: (HljsNode | string)[]
}

// Filename-based and extension-based language detection (approximates bat's
// SyntaxMapping + syntect's find_syntax_by_extension)
const FILENAME_LANGS: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  Rakefile: 'ruby',
  Gemfile: 'ruby',
  CMakeLists: 'cmake',
}

function detectLanguage(
  filePath: string,
  firstLine: string | null,
): string | null {
  const base = basename(filePath)
  const ext = extname(filePath).slice(1)

  // Filename-based lookup (handles Dockerfile, Makefile, CMakeLists.txt, etc.)
  const stem = base.split('.')[0] ?? ''
  // Object.hasOwn guards against inherited members: a file named e.g.
  // `constructor.css` (stem "constructor") would otherwise return an
  // Object.prototype function, and hljs().getLanguage(fn) throws on the
  // non-string, crashing the whole diff render.
  const byName =
    (Object.hasOwn(FILENAME_LANGS, base) ? FILENAME_LANGS[base] : undefined) ??
    (Object.hasOwn(FILENAME_LANGS, stem) ? FILENAME_LANGS[stem] : undefined)
  if (byName && hljs().getLanguage(byName)) return byName
  if (ext) {
    const lang = hljs().getLanguage(ext)
    if (lang) return ext
  }
  // Shebang / first-line detection (strip UTF-8 BOM)
  if (firstLine) {
    const line = firstLine.startsWith('\ufeff') ? firstLine.slice(1) : firstLine
    if (line.startsWith('#!')) {
      if (line.includes('bash') || line.includes('/sh')) return 'bash'
      if (line.includes('python')) return 'python'
      if (line.includes('node')) return 'javascript'
      if (line.includes('ruby')) return 'ruby'
      if (line.includes('perl')) return 'perl'
    }
    if (line.startsWith('<?php')) return 'php'
    if (line.startsWith('<?xml')) return 'xml'
  }
  return null
}

function scopeColor(
  scope: string | undefined,
  text: string,
  theme: Theme,
): Color {
  if (!scope) return theme.foreground
  if (scope === 'keyword' && STORAGE_KEYWORDS.has(text.trim())) {
    return theme.scopes['_storage'] ?? theme.foreground
  }
  return (
    theme.scopes[scope] ??
    theme.scopes[scope.split('.')[0]!] ??
    theme.foreground
  )
}

function flattenHljs(
  node: HljsNode | string,
  theme: Theme,
  parentScope: string | undefined,
  out: Block[],
): void {
  if (typeof node === 'string') {
    const fg = scopeColor(parentScope, node, theme)
    out.push([{ foreground: fg, background: theme.background }, node])
    return
  }
  const scope = node.scope ?? node.kind ?? parentScope
  for (const child of node.children) {
    flattenHljs(child, theme, scope, out)
  }
}

// result.emitter is in the public HighlightResult type, but rootNode is
// internal to TokenTreeEmitter. Type guard validates the shape once so we
// fail loudly (via logError) instead of a silent try/catch swallow — the
// prior `as unknown as` cast hid a version mismatch (_emitter vs emitter,
// scope vs kind) behind a silent gray fallback.
function hasRootNode(emitter: unknown): emitter is { rootNode: HljsNode } {
  return (
    typeof emitter === 'object' &&
    emitter !== null &&
    'rootNode' in emitter &&
    typeof emitter.rootNode === 'object' &&
    emitter.rootNode !== null &&
    'children' in emitter.rootNode
  )
}

let loggedEmitterShapeError = false

function highlightLine(
  state: { lang: string | null; stack: unknown },
  line: string,
  theme: Theme,
): Block[] {
  // syntect-parity: feed a trailing \n so line comments terminate, then strip
  const code = line + '\n'
  if (!state.lang) {
    return [[defaultStyle(theme), code]]
  }
  let result
  try {
    result = hljs().highlight(code, {
      language: state.lang,
      ignoreIllegals: true,
    })
  } catch {
    // hljs throws on unknown language despite ignoreIllegals
    return [[defaultStyle(theme), code]]
  }
  if (!hasRootNode(result.emitter)) {
    if (!loggedEmitterShapeError) {
      loggedEmitterShapeError = true
      logError(
        new Error(
          `color-diff: hljs emitter shape mismatch (keys: ${Object.keys(result.emitter).join(',')}). Syntax highlighting disabled.`,
        ),
      )
    }
    return [[defaultStyle(theme), code]]
  }
  const blocks: Block[] = []
  flattenHljs(result.emitter.rootNode, theme, undefined, blocks)
  return blocks
}

// ---------------------------------------------------------------------------
// Word diff
// ---------------------------------------------------------------------------

type Range = { start: number; end: number }

const CHANGE_THRESHOLD = 0.4

// Tokenize into word runs, whitespace runs, and single punctuation chars —
// matches the Rust tokenize() which mirrors diffWordsWithSpace's splitting.
function tokenize(text: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (/[\p{L}\p{N}_]/u.test(ch)) {
      let j = i + 1
      while (j < text.length && /[\p{L}\p{N}_]/u.test(text[j]!)) j++
      tokens.push(text.slice(i, j))
      i = j
    } else if (/\s/.test(ch)) {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j++
      tokens.push(text.slice(i, j))
      i = j
    } else {
      // advance one codepoint (handle surrogate pairs)
      const cp = text.codePointAt(i)!
      const len = cp > 0xffff ? 2 : 1
      tokens.push(text.slice(i, i + len))
      i += len
    }
  }
  return tokens
}

function findAdjacentPairs(markers: Marker[]): [number, number][] {
  const pairs: [number, number][] = []
  let i = 0
  while (i < markers.length) {
    if (markers[i] === '-') {
      const delStart = i
      let delEnd = i
      while (delEnd < markers.length && markers[delEnd] === '-') delEnd++
      let addEnd = delEnd
      while (addEnd < markers.length && markers[addEnd] === '+') addEnd++
      const delCount = delEnd - delStart
      const addCount = addEnd - delEnd
      if (delCount > 0 && addCount > 0) {
        const n = Math.min(delCount, addCount)
        for (let k = 0; k < n; k++) {
          pairs.push([delStart + k, delEnd + k])
        }
        i = addEnd
      } else {
        i = delEnd
      }
    } else {
      i++
    }
  }
  return pairs
}

function wordDiffStrings(oldStr: string, newStr: string): [Range[], Range[]] {
  const oldTokens = tokenize(oldStr)
  const newTokens = tokenize(newStr)
  const ops = diffArrays(oldTokens, newTokens)

  const totalLen = oldStr.length + newStr.length
  let changedLen = 0
  const oldRanges: Range[] = []
  const newRanges: Range[] = []
  let oldOff = 0
  let newOff = 0

  for (const op of ops) {
    const len = op.value.reduce((s, t) => s + t.length, 0)
    if (op.removed) {
      changedLen += len
      oldRanges.push({ start: oldOff, end: oldOff + len })
      oldOff += len
    } else if (op.added) {
      changedLen += len
      newRanges.push({ start: newOff, end: newOff + len })
      newOff += len
    } else {
      oldOff += len
      newOff += len
    }
  }

  if (totalLen > 0 && changedLen / totalLen > CHANGE_THRESHOLD) {
    return [[], []]
  }
  return [oldRanges, newRanges]
}

// ---------------------------------------------------------------------------
// Highlight (per-line transform pipeline)
// ---------------------------------------------------------------------------

type Highlight = {
  marker: Marker | null
  lineNumber: number
  lines: Block[][]
}

function removeNewlines(h: Highlight): void {
  h.lines = h.lines.map(line =>
    line.flatMap(([style, text]) =>
      text
        .split('\n')
        .filter(p => p.length > 0)
        .map((p): Block => [style, p]),
    ),
  )
}

function charWidth(ch: string): number {
  return stringWidth(ch)
}

function wrapText(h: Highlight, width: number, theme: Theme): void {
  const newLines: Block[][] = []
  for (const line of h.lines) {
    const queue: Block[] = line.slice()
    let cur: Block[] = []
    let curW = 0
    while (queue.length > 0) {
      const [style, text] = queue.shift()!
      const tw = stringWidth(text)
      if (curW + tw <= width) {
        cur.push([style, text])
        curW += tw
      } else {
        const remaining = width - curW
        let bytePos = 0
        let accW = 0
        // iterate by codepoint
        for (const ch of text) {
          const cw = charWidth(ch)
          if (accW + cw > remaining) break
          accW += cw
          bytePos += ch.length
        }
        if (bytePos === 0) {
          if (curW === 0) {
            // Fresh line and first char still doesn't fit — force one codepoint
            // to guarantee forward progress (overflows, but prevents infinite loop)
            const firstCp = text.codePointAt(0)!
            bytePos = firstCp > 0xffff ? 2 : 1
          } else {
            // Line has content and next char doesn't fit — finish this line,
            // re-queue the whole block for a fresh line
            newLines.push(cur)
            queue.unshift([style, text])
            cur = []
            curW = 0
            continue
          }
        }
        cur.push([style, text.slice(0, bytePos)])
        newLines.push(cur)
        queue.unshift([style, text.slice(bytePos)])
        cur = []
        curW = 0
      }
    }
    newLines.push(cur)
  }
  h.lines = newLines

  // Pad changed lines so background extends to edge
  if (h.marker && h.marker !== ' ') {
    const bg = lineBackground(h.marker, theme)
    const padStyle: Style = { foreground: theme.foreground, background: bg }
    for (const line of h.lines) {
      const curW = line.reduce((s, [, t]) => s + stringWidth(t), 0)
      if (curW < width) {
        line.push([padStyle, ' '.repeat(width - curW)])
      }
    }
  }
}

function addLineNumber(
  h: Highlight,
  theme: Theme,
  maxDigits: number,
  fullDim: boolean,
): void {
  const style: Style = {
    foreground: h.marker ? decorationColor(h.marker, theme) : theme.foreground,
    background: h.marker ? lineBackground(h.marker, theme) : theme.background,
  }
  const shouldDim = h.marker === null || h.marker === ' '
  for (let i = 0; i < h.lines.length; i++) {
    const prefix =
      i === 0
        ? ` ${String(h.lineNumber).padStart(maxDigits)} `
        : ' '.repeat(maxDigits + 2)
    const wrapped = shouldDim && !fullDim ? `${DIM}${prefix}${UNDIM}` : prefix
    h.lines[i]!.unshift([style, wrapped])
  }
}

function addMarker(h: Highlight, theme: Theme): void {
  if (!h.marker) return
  const style: Style = {
    foreground: decorationColor(h.marker, theme),
    background: lineBackground(h.marker, theme),
  }
  for (const line of h.lines) {
    line.unshift([style, h.marker])
  }
}

function dimContent(h: Highlight): void {
  for (const line of h.lines) {
    if (line.length > 0) {
      line[0]![1] = DIM + line[0]![1]
      const last = line.length - 1
      line[last]![1] = line[last]![1] + UNDIM
    }
  }
}

function applyBackground(h: Highlight, theme: Theme, ranges: Range[]): void {
  if (!h.marker) return
  const lineBg = lineBackground(h.marker, theme)
  const wordBg = wordBackground(h.marker, theme)

  let rangeIdx = 0
  let byteOff = 0
  for (let li = 0; li < h.lines.length; li++) {
    const newLine: Block[] = []
    for (const [style, text] of h.lines[li]!) {
      const textStart = byteOff
      const textEnd = byteOff + text.length

      while (rangeIdx < ranges.length && ranges[rangeIdx]!.end <= textStart) {
        rangeIdx++
      }
      if (rangeIdx >= ranges.length) {
        newLine.push([{ ...style, background: lineBg }, text])
        byteOff = textEnd
        continue
      }

      let remaining = text
      let pos = textStart
      while (remaining.length > 0 && rangeIdx < ranges.length) {
        const r = ranges[rangeIdx]!
        const inRange = pos >= r.start && pos < r.end
        let next: number
        if (inRange) {
          next = Math.min(r.end, textEnd)
        } else if (r.start > pos && r.start < textEnd) {
          next = r.start
        } else {
          next = textEnd
        }
        const segLen = next - pos
        const seg = remaining.slice(0, segLen)
        newLine.push([{ ...style, background: inRange ? wordBg : lineBg }, seg])
        remaining = remaining.slice(segLen)
        pos = next
        if (pos >= r.end) rangeIdx++
      }
      if (remaining.length > 0) {
        newLine.push([{ ...style, background: lineBg }, remaining])
      }
      byteOff = textEnd
    }
    h.lines[li] = newLine
  }
}

function intoLines(
  h: Highlight,
  dim: boolean,
  skipBg: boolean,
  mode: ColorMode,
): string[] {
  return h.lines.map(line => asTerminalEscaped(line, mode, skipBg, dim))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function maxLineNumber(hunk: Hunk): number {
  const oldEnd = Math.max(0, hunk.oldStart + hunk.oldLines - 1)
  const newEnd = Math.max(0, hunk.newStart + hunk.newLines - 1)
  return Math.max(oldEnd, newEnd)
}

function parseMarker(s: string): Marker {
  return s === '+' || s === '-' ? s : ' '
}

export class ColorDiff {
  private hunk: Hunk
  private filePath: string
  private firstLine: string | null
  private prefixContent: string | null

  constructor(
    hunk: Hunk,
    firstLine: string | null,
    filePath: string,
    prefixContent?: string | null,
  ) {
    this.hunk = hunk
    this.filePath = filePath
    this.firstLine = firstLine
    this.prefixContent = prefixContent ?? null
  }

  render(themeName: string, width: number, dim: boolean): string[] | null {
    const mode = detectColorMode(themeName)
    const theme = buildTheme(themeName, mode)
    const lang = detectLanguage(this.filePath, this.firstLine)
    const hlState = { lang, stack: null }

    // Warm highlighter with prefix lines (highlight.js is stateless per call,
    // so this is a no-op for now — preserved for API parity)
    void this.prefixContent

    const maxDigits = String(maxLineNumber(this.hunk)).length
    let oldLine = this.hunk.oldStart
    let newLine = this.hunk.newStart
    const effectiveWidth = Math.max(1, width - maxDigits - 2 - 1)

    // First pass: assign markers + line numbers
    type Entry = { lineNumber: number; marker: Marker; code: string }
    const entries: Entry[] = this.hunk.lines.map(rawLine => {
      const marker = parseMarker(rawLine.slice(0, 1))
      const code = rawLine.slice(1)
      let lineNumber: number
      switch (marker) {
        case '+':
          lineNumber = newLine++
          break
        case '-':
          lineNumber = oldLine++
          break
        case ' ':
          lineNumber = newLine
          oldLine++
          newLine++
          break
      }
      return { lineNumber, marker, code }
    })

    // Word-diff ranges (skip when dim — too loud)
    const ranges: Range[][] = entries.map(() => [])
    if (!dim) {
      const markers = entries.map(e => e.marker)
      for (const [delIdx, addIdx] of findAdjacentPairs(markers)) {
        const [delR, addR] = wordDiffStrings(
          entries[delIdx]!.code,
          entries[addIdx]!.code,
        )
        ranges[delIdx] = delR
        ranges[addIdx] = addR
      }
    }

    // Second pass: highlight + transform pipeline
    const out: string[] = []
    for (let i = 0; i < entries.length; i++) {
      const { lineNumber, marker, code } = entries[i]!
      const tokens: Block[] =
        marker === '-'
          ? [[defaultStyle(theme), code]]
          : highlightLine(hlState, code, theme)

      const h: Highlight = { marker, lineNumber, lines: [tokens] }
      removeNewlines(h)
      applyBackground(h, theme, ranges[i]!)
      wrapText(h, effectiveWidth, theme)
      if (mode === 'ansi' && marker === '-') {
        dimContent(h)
      }
      addMarker(h, theme)
      addLineNumber(h, theme, maxDigits, dim)
      out.push(...intoLines(h, dim, false, mode))
    }
    return out
  }
}

export class ColorFile {
  private code: string
  private filePath: string

  constructor(code: string, filePath: string) {
    this.code = code
    this.filePath = filePath
  }

  render(themeName: string, width: number, dim: boolean): string[] | null {
    const mode = detectColorMode(themeName)
    const theme = buildTheme(themeName, mode)
    const lines = this.code.split('\n')
    // Rust .lines() drops trailing empty line from trailing \n
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const firstLine = lines[0] ?? null
    const lang = detectLanguage(this.filePath, firstLine)
    const hlState = { lang, stack: null }

    const maxDigits = String(lines.length).length
    const effectiveWidth = Math.max(1, width - maxDigits - 2)

    const out: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const tokens = highlightLine(hlState, lines[i]!, theme)
      const h: Highlight = { marker: null, lineNumber: i + 1, lines: [tokens] }
      removeNewlines(h)
      wrapText(h, effectiveWidth, theme)
      addLineNumber(h, theme, maxDigits, dim)
      out.push(...intoLines(h, dim, true, mode))
    }
    return out
  }
}

// Display width of a tab in the editor pane. The byte saved stays a literal
// tab — this is purely how many columns it occupies on screen.
const EDITOR_TAB_WIDTH = 4

type DisplayCol =
  | { ch: string; style: Style }
  // Right half of a wide (CJK/emoji) grapheme — nothing rendered here unless
  // the window cut the grapheme's left half off, in which case it becomes a space.
  | { cont: true }

/**
 * Per-file syntax highlighter for an editable, NO-WRAP pane (the /explorer
 * editor). Unlike ColorFile (which wraps and bakes in line numbers), this
 * highlights ONE source line at a time and serializes a horizontal window of
 * it to an ANSI string, so the caller can scroll long lines sideways and draw
 * its own gutter. Theme + language are resolved once per file.
 */
export class EditorHighlighter {
  private mode: ColorMode
  private theme: Theme
  private lang: string | null

  constructor(filePath: string, firstLine: string | null, themeName: string) {
    this.mode = detectColorMode(themeName)
    this.theme = buildTheme(themeName, this.mode)
    this.lang = detectLanguage(filePath, firstLine)
  }

  /** Expand a highlighted line into one entry per terminal column. */
  private toColumns(line: string): DisplayCol[] {
    const blocks = highlightLine({ lang: this.lang, stack: null }, line, this.theme)
    const cols: DisplayCol[] = []
    let absCol = 0
    for (const [style, rawText] of blocks) {
      // highlightLine feeds a trailing \n to terminate comments — strip it.
      const text = rawText.replace(/\n/g, '')
      for (const ch of text) {
        if (ch === '\t') {
          const n = EDITOR_TAB_WIDTH - (absCol % EDITOR_TAB_WIDTH)
          for (let i = 0; i < n; i++) {
            cols.push({ ch: ' ', style })
            absCol++
          }
          continue
        }
        const w = Math.max(1, stringWidth(ch))
        cols.push({ ch, style })
        absCol++
        for (let i = 1; i < w; i++) {
          cols.push({ cont: true })
          absCol++
        }
      }
    }
    return cols
  }

  /**
   * Render `line` clipped to the horizontal window [fromCol, fromCol+width) as
   * an ANSI string. When `cursorCol` lands in-window, that cell is inverted
   * (block cursor — used in NORMAL mode). Columns past end-of-line render blank.
   */
  renderLineWindow(
    line: string,
    fromCol: number,
    width: number,
    cursorCol?: number,
  ): string {
    const cols = this.toColumns(line)
    const def = defaultStyle(this.theme)
    const blocks: Block[] = []
    const end = fromCol + width
    for (let c = fromCol; c < end; c++) {
      const col = cols[c]
      let ch: string
      let style: Style
      if (!col) {
        ch = ' '
        style = def
      } else if ('cont' in col) {
        // A wide grapheme whose left half is in-window already drew it; only
        // emit a space when the window starts on the cut-off right half.
        ch = c === fromCol ? ' ' : ''
        style = def
      } else {
        ch = col.ch
        style = col.style
      }
      if (cursorCol !== undefined && c === cursorCol) {
        style = { foreground: style.background, background: style.foreground }
        if (ch === '') ch = ' '
      }
      if (ch === '') continue
      blocks.push([style, ch])
    }
    return asTerminalEscaped(blocks, this.mode, false, false)
  }

  /**
   * Map a logical (UTF-16) column on `line` to its display column, expanding
   * tabs and wide graphemes. Used to place the block cursor / horizontal scroll
   * from the editor's string-index cursor.
   */
  displayColOf(line: string, logicalCol: number): number {
    let col = 0
    const end = Math.min(logicalCol, line.length)
    for (let i = 0; i < end; i++) {
      const ch = line[i]!
      if (ch === '\t') col += EDITOR_TAB_WIDTH - (col % EDITOR_TAB_WIDTH)
      else col += Math.max(1, stringWidth(ch))
    }
    return col
  }
}

export function getSyntaxTheme(themeName: string): SyntaxTheme {
  // highlight.js has no bat theme set, so env vars can't select alternate
  // syntect themes. We still report the env var if set, for diagnostics.
  const envTheme =
    process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT ?? process.env.BAT_THEME
  void envTheme
  return { theme: defaultSyntaxThemeName(themeName), source: null }
}

// Lazy loader to match vendor/color-diff-src/index.ts API
let cachedModule: NativeModule | null = null

export function getNativeModule(): NativeModule | null {
  if (cachedModule) return cachedModule
  cachedModule = { ColorDiff, ColorFile, getSyntaxTheme }
  return cachedModule
}

export type { ColorDiff as ColorDiffClass, ColorFile as ColorFileClass }

// Exported for testing
export const __test = {
  tokenize,
  findAdjacentPairs,
  wordDiffStrings,
  ansi256FromRgb,
  colorToEscape,
  detectColorMode,
  detectLanguage,
}
