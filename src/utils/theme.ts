import chalk, { Chalk } from 'chalk'
import { env } from 'src/shared/env.js'

export type Theme = {
  autoAccept: string
  bashBorder: string
  claude: string
  claudeShimmer: string // Lighter version of claude color for shimmer effect
  claudeBlue_FOR_SYSTEM_SPINNER: string
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: string
  permission: string
  permissionShimmer: string // Lighter version of permission color for shimmer effect
  planMode: string
  ide: string
  promptBorder: string
  promptBorderShimmer: string // Lighter version of promptBorder color for shimmer effect
  text: string
  inverseText: string
  inactive: string
  inactiveShimmer: string // Lighter version of inactive color for shimmer effect
  subtle: string
  suggestion: string
  remember: string
  background: string
  // Semantic colors
  success: string
  error: string
  warning: string
  merged: string
  warningShimmer: string // Lighter version of warning color for shimmer effect
  spinnerStalled: string // Color the loading spinner shifts toward when stalled (no new tokens ~3s)
  // Diff colors
  diffAdded: string
  diffRemoved: string
  diffAddedDimmed: string
  diffRemovedDimmed: string
  // Word-level diff highlighting
  diffAddedWord: string
  diffRemovedWord: string
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: string
  blue_FOR_SUBAGENTS_ONLY: string
  green_FOR_SUBAGENTS_ONLY: string
  yellow_FOR_SUBAGENTS_ONLY: string
  purple_FOR_SUBAGENTS_ONLY: string
  orange_FOR_SUBAGENTS_ONLY: string
  pink_FOR_SUBAGENTS_ONLY: string
  cyan_FOR_SUBAGENTS_ONLY: string
  // Grove colors
  professionalBlue: string
  // Chrome colors
  chromeYellow: string
  // TUI V2 colors
  clawd_body: string
  clawd_background: string
  userMessageBackground: string
  userMessageBackgroundHover: string
  /** Message-actions selection. Cool shift toward `suggestion` blue; distinct from default AND userMessageBackground. */
  messageActionsBackground: string
  /** Text-selection highlight background (alt-screen mouse selection). Solid
   *  bg that REPLACES the cell's bg while preserving its fg — matches native
   *  terminal selection. Previously SGR-7 inverse (swapped fg/bg per cell),
   *  which fragmented badly over syntax highlighting. */
  selectionBg: string
  bashMessageBackgroundColor: string

  memoryBackgroundColor: string
  rate_limit_fill: string
  rate_limit_empty: string
  fastMode: string
  fastModeShimmer: string
  // Brief/assistant mode label colors
  briefLabelYou: string
  briefLabelClaude: string
  // Rainbow colors for ultrathink keyword highlighting
  rainbow_red: string
  rainbow_orange: string
  rainbow_yellow: string
  rainbow_green: string
  rainbow_blue: string
  rainbow_indigo: string
  rainbow_violet: string
  rainbow_red_shimmer: string
  rainbow_orange_shimmer: string
  rainbow_yellow_shimmer: string
  rainbow_green_shimmer: string
  rainbow_blue_shimmer: string
  rainbow_indigo_shimmer: string
  rainbow_violet_shimmer: string
}

export const THEME_NAMES = [
  'dark',
  'light',
  'light-daltonized',
  'dark-daltonized',
  'light-ansi',
  'dark-ansi',
  'terminal',
  'dracula',
  'catppuccin-mocha',
  'catppuccin-latte',
  'tokyo-night',
  'nord',
  'gruvbox-dark',
] as const

/** A renderable theme. Always resolvable to a concrete color palette. */
export type ThemeName = (typeof THEME_NAMES)[number]

export const THEME_SETTINGS = ['auto', ...THEME_NAMES] as const

/**
 * A theme preference as stored in user config. `'auto'` follows the system
 * dark/light mode and is resolved to a ThemeName at runtime.
 */
export type ThemeSetting = (typeof THEME_SETTINGS)[number]

/**
 * Default stalled-spinner red, shared by the RGB themes (the loading spinner
 * shifts toward this when no new tokens arrive ~3s). ANSI themes mirror their
 * own `error` color instead. The parsed RGB fallback lives in
 * Spinner/utils.ts (STALL_RED) — keep in sync.
 */
const DEFAULT_STALL_RED = 'rgb(171,43,63)'

/**
 * Light theme using explicit RGB values to avoid inconsistencies
 * from users' custom terminal ANSI color definitions
 */
const lightTheme: Theme = {
  autoAccept: 'rgb(135,0,255)', // Electric violet
  bashBorder: 'rgb(255,0,135)', // Vibrant pink
  claude: 'rgb(215,119,87)', // Claude orange
  claudeShimmer: 'rgb(245,149,117)', // Lighter claude orange for shimmer effect
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(87,105,247)', // Medium blue for system spinner
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(117,135,255)', // Lighter blue for system spinner shimmer
  permission: 'rgb(87,105,247)', // Medium blue
  permissionShimmer: 'rgb(137,155,255)', // Lighter blue for shimmer effect
  planMode: 'rgb(0,102,102)', // Muted teal
  ide: 'rgb(71,130,200)', // Muted blue
  promptBorder: 'rgb(153,153,153)', // Medium gray
  promptBorderShimmer: 'rgb(183,183,183)', // Lighter gray for shimmer effect
  text: 'rgb(0,0,0)', // Black
  inverseText: 'rgb(255,255,255)', // White
  inactive: 'rgb(102,102,102)', // Dark gray
  inactiveShimmer: 'rgb(142,142,142)', // Lighter gray for shimmer effect
  subtle: 'rgb(175,175,175)', // Light gray
  suggestion: 'rgb(87,105,247)', // Medium blue
  remember: 'rgb(0,0,255)', // Blue
  background: 'rgb(0,153,153)', // Cyan
  success: 'rgb(44,122,57)', // Green
  error: 'rgb(171,43,63)', // Red
  spinnerStalled: DEFAULT_STALL_RED, // Stalled-spinner red
  warning: 'rgb(150,108,30)', // Amber
  merged: 'rgb(135,0,255)', // Electric violet (matches autoAccept)
  warningShimmer: 'rgb(200,158,80)', // Lighter amber for shimmer effect
  diffAdded: 'rgb(105,219,124)', // Light green
  diffRemoved: 'rgb(255,168,180)', // Light red
  diffAddedDimmed: 'rgb(199,225,203)', // Very light green
  diffRemovedDimmed: 'rgb(253,210,216)', // Very light red
  diffAddedWord: 'rgb(47,157,68)', // Medium green
  diffRemovedWord: 'rgb(209,69,75)', // Medium red
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'rgb(220,38,38)', // Red 600
  blue_FOR_SUBAGENTS_ONLY: 'rgb(37,99,235)', // Blue 600
  green_FOR_SUBAGENTS_ONLY: 'rgb(22,163,74)', // Green 600
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(202,138,4)', // Yellow 600
  purple_FOR_SUBAGENTS_ONLY: 'rgb(147,51,234)', // Purple 600
  orange_FOR_SUBAGENTS_ONLY: 'rgb(234,88,12)', // Orange 600
  pink_FOR_SUBAGENTS_ONLY: 'rgb(219,39,119)', // Pink 600
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(8,145,178)', // Cyan 600
  // Grove colors
  professionalBlue: 'rgb(106,155,204)',
  // Chrome colors
  chromeYellow: 'rgb(251,188,4)', // Chrome yellow
  // TUI V2 colors
  clawd_body: 'rgb(215,119,87)',
  clawd_background: 'rgb(0,0,0)',
  userMessageBackground: 'rgb(240, 240, 240)', // Slightly darker grey for optimal contrast
  userMessageBackgroundHover: 'rgb(252, 252, 252)', // ≥250 to quantize distinct from base at 256-color level
  messageActionsBackground: 'rgb(232, 236, 244)', // cool gray — darker than userMsg 240 (visible on white), slight blue toward `suggestion`
  selectionBg: 'rgb(180, 213, 255)', // classic light-mode selection blue (macOS/VS Code-ish); dark fgs stay readable
  bashMessageBackgroundColor: 'rgb(250, 245, 250)',

  memoryBackgroundColor: 'rgb(230, 245, 250)',
  rate_limit_fill: 'rgb(87,105,247)', // Medium blue
  rate_limit_empty: 'rgb(39,47,111)', // Dark blue
  fastMode: 'rgb(255,106,0)', // Electric orange
  fastModeShimmer: 'rgb(255,150,50)', // Lighter orange for shimmer
  // Brief/assistant mode
  briefLabelYou: 'rgb(37,99,235)', // Blue
  briefLabelClaude: 'rgb(215,119,87)', // Brand orange
  rainbow_red: 'rgb(235,95,87)',
  rainbow_orange: 'rgb(245,139,87)',
  rainbow_yellow: 'rgb(250,195,95)',
  rainbow_green: 'rgb(145,200,130)',
  rainbow_blue: 'rgb(130,170,220)',
  rainbow_indigo: 'rgb(155,130,200)',
  rainbow_violet: 'rgb(200,130,180)',
  rainbow_red_shimmer: 'rgb(250,155,147)',
  rainbow_orange_shimmer: 'rgb(255,185,137)',
  rainbow_yellow_shimmer: 'rgb(255,225,155)',
  rainbow_green_shimmer: 'rgb(185,230,180)',
  rainbow_blue_shimmer: 'rgb(180,205,240)',
  rainbow_indigo_shimmer: 'rgb(195,180,230)',
  rainbow_violet_shimmer: 'rgb(230,180,210)',
}

/**
 * Light ANSI theme using only the 16 standard ANSI colors
 * for terminals without true color support
 */
const lightAnsiTheme: Theme = {
  autoAccept: 'ansi:magenta',
  bashBorder: 'ansi:magenta',
  claude: 'ansi:redBright',
  claudeShimmer: 'ansi:yellowBright',
  claudeBlue_FOR_SYSTEM_SPINNER: 'ansi:blue',
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'ansi:blueBright',
  permission: 'ansi:blue',
  permissionShimmer: 'ansi:blueBright',
  planMode: 'ansi:cyan',
  ide: 'ansi:blueBright',
  promptBorder: 'ansi:white',
  promptBorderShimmer: 'ansi:whiteBright',
  text: 'ansi:black',
  inverseText: 'ansi:white',
  inactive: 'ansi:blackBright',
  inactiveShimmer: 'ansi:white',
  subtle: 'ansi:blackBright',
  suggestion: 'ansi:blue',
  remember: 'ansi:blue',
  background: 'ansi:cyan',
  success: 'ansi:green',
  error: 'ansi:red',
  spinnerStalled: 'ansi:red', // Stalled-spinner (mirrors error for ANSI)
  warning: 'ansi:yellow',
  merged: 'ansi:magenta',
  warningShimmer: 'ansi:yellowBright',
  diffAdded: 'ansi:green',
  diffRemoved: 'ansi:red',
  diffAddedDimmed: 'ansi:green',
  diffRemovedDimmed: 'ansi:red',
  diffAddedWord: 'ansi:greenBright',
  diffRemovedWord: 'ansi:redBright',
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'ansi:red',
  blue_FOR_SUBAGENTS_ONLY: 'ansi:blue',
  green_FOR_SUBAGENTS_ONLY: 'ansi:green',
  yellow_FOR_SUBAGENTS_ONLY: 'ansi:yellow',
  purple_FOR_SUBAGENTS_ONLY: 'ansi:magenta',
  orange_FOR_SUBAGENTS_ONLY: 'ansi:redBright',
  pink_FOR_SUBAGENTS_ONLY: 'ansi:magentaBright',
  cyan_FOR_SUBAGENTS_ONLY: 'ansi:cyan',
  // Grove colors
  professionalBlue: 'ansi:blueBright',
  // Chrome colors
  chromeYellow: 'ansi:yellow', // Chrome yellow
  // TUI V2 colors
  clawd_body: 'ansi:redBright',
  clawd_background: 'ansi:black',
  userMessageBackground: 'ansi:white',
  userMessageBackgroundHover: 'ansi:whiteBright',
  messageActionsBackground: 'ansi:white',
  selectionBg: 'ansi:cyan', // lighter named bg for light-ansi; dark fgs stay readable
  bashMessageBackgroundColor: 'ansi:whiteBright',

  memoryBackgroundColor: 'ansi:white',
  rate_limit_fill: 'ansi:yellow',
  rate_limit_empty: 'ansi:black',
  fastMode: 'ansi:red',
  fastModeShimmer: 'ansi:redBright',
  briefLabelYou: 'ansi:blue',
  briefLabelClaude: 'ansi:redBright',
  rainbow_red: 'ansi:red',
  rainbow_orange: 'ansi:redBright',
  rainbow_yellow: 'ansi:yellow',
  rainbow_green: 'ansi:green',
  rainbow_blue: 'ansi:cyan',
  rainbow_indigo: 'ansi:blue',
  rainbow_violet: 'ansi:magenta',
  rainbow_red_shimmer: 'ansi:redBright',
  rainbow_orange_shimmer: 'ansi:yellow',
  rainbow_yellow_shimmer: 'ansi:yellowBright',
  rainbow_green_shimmer: 'ansi:greenBright',
  rainbow_blue_shimmer: 'ansi:cyanBright',
  rainbow_indigo_shimmer: 'ansi:blueBright',
  rainbow_violet_shimmer: 'ansi:magentaBright',
}

/**
 * Dark ANSI theme using only the 16 standard ANSI colors
 * for terminals without true color support
 */
const darkAnsiTheme: Theme = {
  autoAccept: 'ansi:magentaBright',
  bashBorder: 'ansi:magentaBright',
  claude: 'ansi:redBright',
  claudeShimmer: 'ansi:yellowBright',
  claudeBlue_FOR_SYSTEM_SPINNER: 'ansi:blueBright',
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'ansi:blueBright',
  permission: 'ansi:blueBright',
  permissionShimmer: 'ansi:blueBright',
  planMode: 'ansi:cyanBright',
  ide: 'ansi:blue',
  promptBorder: 'ansi:white',
  promptBorderShimmer: 'ansi:whiteBright',
  text: 'ansi:whiteBright',
  inverseText: 'ansi:black',
  spinnerStalled: 'ansi:redBright', // Stalled-spinner (mirrors error for ANSI)
  inactive: 'ansi:white',
  inactiveShimmer: 'ansi:whiteBright',
  subtle: 'ansi:white',
  suggestion: 'ansi:blueBright',
  remember: 'ansi:blueBright',
  background: 'ansi:cyanBright',
  success: 'ansi:greenBright',
  error: 'ansi:redBright',
  warning: 'ansi:yellowBright',
  merged: 'ansi:magentaBright',
  warningShimmer: 'ansi:yellowBright',
  diffAdded: 'ansi:green',
  diffRemoved: 'ansi:red',
  diffAddedDimmed: 'ansi:green',
  diffRemovedDimmed: 'ansi:red',
  diffAddedWord: 'ansi:greenBright',
  diffRemovedWord: 'ansi:redBright',
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'ansi:redBright',
  blue_FOR_SUBAGENTS_ONLY: 'ansi:blueBright',
  green_FOR_SUBAGENTS_ONLY: 'ansi:greenBright',
  yellow_FOR_SUBAGENTS_ONLY: 'ansi:yellowBright',
  purple_FOR_SUBAGENTS_ONLY: 'ansi:magentaBright',
  orange_FOR_SUBAGENTS_ONLY: 'ansi:redBright',
  pink_FOR_SUBAGENTS_ONLY: 'ansi:magentaBright',
  cyan_FOR_SUBAGENTS_ONLY: 'ansi:cyanBright',
  // Grove colors
  professionalBlue: 'rgb(106,155,204)',
  // Chrome colors
  chromeYellow: 'ansi:yellowBright', // Chrome yellow
  // TUI V2 colors
  clawd_body: 'ansi:redBright',
  clawd_background: 'ansi:black',
  userMessageBackground: 'ansi:blackBright',
  userMessageBackgroundHover: 'ansi:white',
  messageActionsBackground: 'ansi:blackBright',
  selectionBg: 'ansi:blue', // darker named bg for dark-ansi; bright fgs stay readable
  bashMessageBackgroundColor: 'ansi:black',

  memoryBackgroundColor: 'ansi:blackBright',
  rate_limit_fill: 'ansi:yellow',
  rate_limit_empty: 'ansi:white',
  fastMode: 'ansi:redBright',
  fastModeShimmer: 'ansi:redBright',
  briefLabelYou: 'ansi:blueBright',
  briefLabelClaude: 'ansi:redBright',
  rainbow_red: 'ansi:red',
  rainbow_orange: 'ansi:redBright',
  rainbow_yellow: 'ansi:yellow',
  rainbow_green: 'ansi:green',
  rainbow_blue: 'ansi:cyan',
  rainbow_indigo: 'ansi:blue',
  rainbow_violet: 'ansi:magenta',
  rainbow_red_shimmer: 'ansi:redBright',
  rainbow_orange_shimmer: 'ansi:yellow',
  rainbow_yellow_shimmer: 'ansi:yellowBright',
  rainbow_green_shimmer: 'ansi:greenBright',
  rainbow_blue_shimmer: 'ansi:cyanBright',
  rainbow_indigo_shimmer: 'ansi:blueBright',
  rainbow_violet_shimmer: 'ansi:magentaBright',
}

/**
 * Light daltonized theme (color-blind friendly) using explicit RGB values
 * to avoid inconsistencies from users' custom terminal ANSI color definitions
 */
const lightDaltonizedTheme: Theme = {
  autoAccept: 'rgb(135,0,255)', // Electric violet
  bashBorder: 'rgb(0,102,204)', // Blue instead of pink
  claude: 'rgb(255,153,51)', // Orange adjusted for deuteranopia
  claudeShimmer: 'rgb(255,183,101)', // Lighter orange for shimmer effect
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(51,102,255)', // Bright blue for system spinner
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(101,152,255)', // Lighter bright blue for system spinner shimmer
  permission: 'rgb(51,102,255)', // Bright blue
  permissionShimmer: 'rgb(101,152,255)', // Lighter bright blue for shimmer
  planMode: 'rgb(51,102,102)', // Muted blue-gray (works for color-blind)
  ide: 'rgb(71,130,200)', // Muted blue
  promptBorder: 'rgb(153,153,153)', // Medium gray
  promptBorderShimmer: 'rgb(183,183,183)', // Lighter gray for shimmer
  text: 'rgb(0,0,0)', // Black
  inverseText: 'rgb(255,255,255)', // White
  inactive: 'rgb(102,102,102)', // Dark gray
  inactiveShimmer: 'rgb(142,142,142)', // Lighter gray for shimmer effect
  subtle: 'rgb(175,175,175)', // Light gray
  suggestion: 'rgb(51,102,255)', // Bright blue
  remember: 'rgb(51,102,255)', // Bright blue
  background: 'rgb(0,153,153)', // Cyan (color-blind friendly)
  success: 'rgb(0,102,153)', // Blue instead of green for deuteranopia
  error: 'rgb(204,0,0)', // Pure red for better distinction
  spinnerStalled: DEFAULT_STALL_RED, // Stalled-spinner red
  warning: 'rgb(255,153,0)', // Orange adjusted for deuteranopia
  merged: 'rgb(135,0,255)', // Electric violet (matches autoAccept)
  warningShimmer: 'rgb(255,183,50)', // Lighter orange for shimmer
  diffAdded: 'rgb(153,204,255)', // Light blue instead of green
  diffRemoved: 'rgb(255,204,204)', // Light red
  diffAddedDimmed: 'rgb(209,231,253)', // Very light blue
  diffRemovedDimmed: 'rgb(255,233,233)', // Very light red
  diffAddedWord: 'rgb(51,102,204)', // Medium blue (less intense than deep blue)
  diffRemovedWord: 'rgb(153,51,51)', // Softer red (less intense than deep red)
  // Agent colors (daltonism-friendly)
  red_FOR_SUBAGENTS_ONLY: 'rgb(204,0,0)', // Pure red
  blue_FOR_SUBAGENTS_ONLY: 'rgb(0,102,204)', // Pure blue
  green_FOR_SUBAGENTS_ONLY: 'rgb(0,204,0)', // Pure green
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(255,204,0)', // Golden yellow
  purple_FOR_SUBAGENTS_ONLY: 'rgb(128,0,128)', // True purple
  orange_FOR_SUBAGENTS_ONLY: 'rgb(255,128,0)', // True orange
  pink_FOR_SUBAGENTS_ONLY: 'rgb(255,102,178)', // Adjusted pink
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(0,178,178)', // Adjusted cyan
  // Grove colors
  professionalBlue: 'rgb(106,155,204)',
  // Chrome colors
  chromeYellow: 'rgb(251,188,4)', // Chrome yellow
  // TUI V2 colors
  clawd_body: 'rgb(215,119,87)',
  clawd_background: 'rgb(0,0,0)',
  userMessageBackground: 'rgb(220, 220, 220)', // Slightly darker grey for optimal contrast
  userMessageBackgroundHover: 'rgb(232, 232, 232)', // ≥230 to quantize distinct from base at 256-color level
  messageActionsBackground: 'rgb(210, 216, 226)', // cool gray — darker than userMsg 220, slight blue
  selectionBg: 'rgb(180, 213, 255)', // light selection blue; daltonized fgs are yellows/blues, both readable on light blue
  bashMessageBackgroundColor: 'rgb(250, 245, 250)',

  memoryBackgroundColor: 'rgb(230, 245, 250)',
  rate_limit_fill: 'rgb(51,102,255)', // Bright blue
  rate_limit_empty: 'rgb(23,46,114)', // Dark blue
  fastMode: 'rgb(255,106,0)', // Electric orange (color-blind safe)
  fastModeShimmer: 'rgb(255,150,50)', // Lighter orange for shimmer
  briefLabelYou: 'rgb(37,99,235)', // Blue
  briefLabelClaude: 'rgb(255,153,51)', // Orange adjusted for deuteranopia (matches claude)
  rainbow_red: 'rgb(235,95,87)',
  rainbow_orange: 'rgb(245,139,87)',
  rainbow_yellow: 'rgb(250,195,95)',
  rainbow_green: 'rgb(145,200,130)',
  rainbow_blue: 'rgb(130,170,220)',
  rainbow_indigo: 'rgb(155,130,200)',
  rainbow_violet: 'rgb(200,130,180)',
  rainbow_red_shimmer: 'rgb(250,155,147)',
  rainbow_orange_shimmer: 'rgb(255,185,137)',
  rainbow_yellow_shimmer: 'rgb(255,225,155)',
  rainbow_green_shimmer: 'rgb(185,230,180)',
  rainbow_blue_shimmer: 'rgb(180,205,240)',
  rainbow_indigo_shimmer: 'rgb(195,180,230)',
  rainbow_violet_shimmer: 'rgb(230,180,210)',
}

/**
 * Dark theme using explicit RGB values to avoid inconsistencies
 * from users' custom terminal ANSI color definitions
 */
const darkTheme: Theme = {
  autoAccept: 'rgb(175,135,255)', // Electric violet
  bashBorder: 'rgb(253,93,177)', // Bright pink
  claude: 'rgb(215,119,87)', // Claude orange
  claudeShimmer: 'rgb(235,159,127)', // Lighter claude orange for shimmer effect
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(147,165,255)', // Blue for system spinner
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(177,195,255)', // Lighter blue for system spinner shimmer
  permission: 'rgb(177,185,249)', // Light blue-purple
  permissionShimmer: 'rgb(207,215,255)', // Lighter blue-purple for shimmer
  planMode: 'rgb(72,150,140)', // Muted sage green
  ide: 'rgb(71,130,200)', // Muted blue
  promptBorder: 'rgb(136,136,136)', // Medium gray
  promptBorderShimmer: 'rgb(166,166,166)', // Lighter gray for shimmer
  text: 'rgb(255,255,255)', // White
  inverseText: 'rgb(0,0,0)', // Black
  inactive: 'rgb(153,153,153)', // Light gray
  inactiveShimmer: 'rgb(193,193,193)', // Lighter gray for shimmer effect
  subtle: 'rgb(80,80,80)', // Dark gray
  suggestion: 'rgb(177,185,249)', // Light blue-purple
  remember: 'rgb(177,185,249)', // Light blue-purple
  background: 'rgb(0,204,204)', // Bright cyan
  success: 'rgb(78,186,101)', // Bright green
  error: 'rgb(255,107,128)', // Bright red
  spinnerStalled: DEFAULT_STALL_RED, // Stalled-spinner red
  warning: 'rgb(255,193,7)', // Bright amber
  merged: 'rgb(175,135,255)', // Electric violet (matches autoAccept)
  warningShimmer: 'rgb(255,223,57)', // Lighter amber for shimmer
  diffAdded: 'rgb(34,92,43)', // Dark green
  diffRemoved: 'rgb(122,41,54)', // Dark red
  diffAddedDimmed: 'rgb(71,88,74)', // Very dark green
  diffRemovedDimmed: 'rgb(105,72,77)', // Very dark red
  diffAddedWord: 'rgb(56,166,96)', // Medium green
  diffRemovedWord: 'rgb(179,89,107)', // Softer red (less intense than bright red)
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'rgb(220,38,38)', // Red 600
  blue_FOR_SUBAGENTS_ONLY: 'rgb(37,99,235)', // Blue 600
  green_FOR_SUBAGENTS_ONLY: 'rgb(22,163,74)', // Green 600
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(202,138,4)', // Yellow 600
  purple_FOR_SUBAGENTS_ONLY: 'rgb(147,51,234)', // Purple 600
  orange_FOR_SUBAGENTS_ONLY: 'rgb(234,88,12)', // Orange 600
  pink_FOR_SUBAGENTS_ONLY: 'rgb(219,39,119)', // Pink 600
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(8,145,178)', // Cyan 600
  // Grove colors
  professionalBlue: 'rgb(106,155,204)',
  // Chrome colors
  chromeYellow: 'rgb(251,188,4)', // Chrome yellow
  // TUI V2 colors
  clawd_body: 'rgb(215,119,87)',
  clawd_background: 'rgb(0,0,0)',
  userMessageBackground: 'rgb(55, 55, 55)', // Lighter grey for better visual contrast
  userMessageBackgroundHover: 'rgb(70, 70, 70)',
  messageActionsBackground: 'rgb(44, 50, 62)', // cool gray, slight blue
  selectionBg: 'rgb(38, 79, 120)', // classic dark-mode selection blue (VS Code dark default); light fgs stay readable
  bashMessageBackgroundColor: 'rgb(65, 60, 65)',

  memoryBackgroundColor: 'rgb(55, 65, 70)',
  rate_limit_fill: 'rgb(215,153,33)', // Amber (matches Claude Code usage bars)
  rate_limit_empty: 'rgb(80,83,112)', // Medium blue-purple
  fastMode: 'rgb(255,120,20)', // Electric orange for dark bg
  fastModeShimmer: 'rgb(255,165,70)', // Lighter orange for shimmer
  briefLabelYou: 'rgb(122,180,232)', // Light blue
  briefLabelClaude: 'rgb(215,119,87)', // Brand orange
  rainbow_red: 'rgb(235,95,87)',
  rainbow_orange: 'rgb(245,139,87)',
  rainbow_yellow: 'rgb(250,195,95)',
  rainbow_green: 'rgb(145,200,130)',
  rainbow_blue: 'rgb(130,170,220)',
  rainbow_indigo: 'rgb(155,130,200)',
  rainbow_violet: 'rgb(200,130,180)',
  rainbow_red_shimmer: 'rgb(250,155,147)',
  rainbow_orange_shimmer: 'rgb(255,185,137)',
  rainbow_yellow_shimmer: 'rgb(255,225,155)',
  rainbow_green_shimmer: 'rgb(185,230,180)',
  rainbow_blue_shimmer: 'rgb(180,205,240)',
  rainbow_indigo_shimmer: 'rgb(195,180,230)',
  rainbow_violet_shimmer: 'rgb(230,180,210)',
}

/**
 * Dark daltonized theme (color-blind friendly) using explicit RGB values
 * to avoid inconsistencies from users' custom terminal ANSI color definitions
 */
const darkDaltonizedTheme: Theme = {
  autoAccept: 'rgb(175,135,255)', // Electric violet
  bashBorder: 'rgb(51,153,255)', // Bright blue
  claude: 'rgb(255,153,51)', // Orange adjusted for deuteranopia
  claudeShimmer: 'rgb(255,183,101)', // Lighter orange for shimmer effect
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(153,204,255)', // Light blue for system spinner
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(183,224,255)', // Lighter blue for system spinner shimmer
  permission: 'rgb(153,204,255)', // Light blue
  permissionShimmer: 'rgb(183,224,255)', // Lighter blue for shimmer
  planMode: 'rgb(102,153,153)', // Muted gray-teal (works for color-blind)
  ide: 'rgb(71,130,200)', // Muted blue
  promptBorder: 'rgb(136,136,136)', // Medium gray
  promptBorderShimmer: 'rgb(166,166,166)', // Lighter gray for shimmer
  text: 'rgb(255,255,255)', // White
  inverseText: 'rgb(0,0,0)', // Black
  inactive: 'rgb(153,153,153)', // Light gray
  inactiveShimmer: 'rgb(193,193,193)', // Lighter gray for shimmer effect
  subtle: 'rgb(80,80,80)', // Dark gray
  suggestion: 'rgb(153,204,255)', // Light blue
  remember: 'rgb(153,204,255)', // Light blue
  background: 'rgb(0,204,204)', // Bright cyan (color-blind friendly)
  success: 'rgb(51,153,255)', // Blue instead of green
  error: 'rgb(255,102,102)', // Bright red
  spinnerStalled: DEFAULT_STALL_RED, // Stalled-spinner red
  warning: 'rgb(255,204,0)', // Yellow-orange for deuteranopia
  merged: 'rgb(175,135,255)', // Electric violet (matches autoAccept)
  warningShimmer: 'rgb(255,234,50)', // Lighter yellow-orange for shimmer
  diffAdded: 'rgb(0,68,102)', // Dark blue
  diffRemoved: 'rgb(102,0,0)', // Dark red
  diffAddedDimmed: 'rgb(62,81,91)', // Dimmed blue
  diffRemovedDimmed: 'rgb(62,44,44)', // Dimmed red
  diffAddedWord: 'rgb(0,119,179)', // Medium blue
  diffRemovedWord: 'rgb(179,0,0)', // Medium red
  // Agent colors (daltonism-friendly, dark mode)
  red_FOR_SUBAGENTS_ONLY: 'rgb(255,102,102)', // Bright red
  blue_FOR_SUBAGENTS_ONLY: 'rgb(102,178,255)', // Bright blue
  green_FOR_SUBAGENTS_ONLY: 'rgb(102,255,102)', // Bright green
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(255,255,102)', // Bright yellow
  purple_FOR_SUBAGENTS_ONLY: 'rgb(178,102,255)', // Bright purple
  orange_FOR_SUBAGENTS_ONLY: 'rgb(255,178,102)', // Bright orange
  pink_FOR_SUBAGENTS_ONLY: 'rgb(255,153,204)', // Bright pink
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(102,204,204)', // Bright cyan
  // Grove colors
  professionalBlue: 'rgb(106,155,204)',
  // Chrome colors
  chromeYellow: 'rgb(251,188,4)', // Chrome yellow
  // TUI V2 colors
  clawd_body: 'rgb(215,119,87)',
  clawd_background: 'rgb(0,0,0)',
  userMessageBackground: 'rgb(55, 55, 55)', // Lighter grey for better visual contrast
  userMessageBackgroundHover: 'rgb(70, 70, 70)',
  messageActionsBackground: 'rgb(44, 50, 62)', // cool gray, slight blue
  selectionBg: 'rgb(38, 79, 120)', // classic dark-mode selection blue (VS Code dark default); light fgs stay readable
  bashMessageBackgroundColor: 'rgb(65, 60, 65)',

  memoryBackgroundColor: 'rgb(55, 65, 70)',
  rate_limit_fill: 'rgb(153,204,255)', // Light blue
  rate_limit_empty: 'rgb(69,92,115)', // Dark blue
  fastMode: 'rgb(255,120,20)', // Electric orange for dark bg (color-blind safe)
  fastModeShimmer: 'rgb(255,165,70)', // Lighter orange for shimmer
  briefLabelYou: 'rgb(122,180,232)', // Light blue
  briefLabelClaude: 'rgb(255,153,51)', // Orange adjusted for deuteranopia (matches claude)
  rainbow_red: 'rgb(235,95,87)',
  rainbow_orange: 'rgb(245,139,87)',
  rainbow_yellow: 'rgb(250,195,95)',
  rainbow_green: 'rgb(145,200,130)',
  rainbow_blue: 'rgb(130,170,220)',
  rainbow_indigo: 'rgb(155,130,200)',
  rainbow_violet: 'rgb(200,130,180)',
  rainbow_red_shimmer: 'rgb(250,155,147)',
  rainbow_orange_shimmer: 'rgb(255,185,137)',
  rainbow_yellow_shimmer: 'rgb(255,225,155)',
  rainbow_green_shimmer: 'rgb(185,230,180)',
  rainbow_blue_shimmer: 'rgb(180,205,240)',
  rainbow_indigo_shimmer: 'rgb(195,180,230)',
  rainbow_violet_shimmer: 'rgb(230,180,210)',
}

/**
 * Terminal default theme — inherits the terminal emulator's own colors.
 * `text`/`inverseText` use the 'terminal' sentinel (no escape → terminal
 * default foreground); accents and backgrounds use the 16 ANSI names so they
 * follow the terminal's palette. Dimmed/border fields use neutral gray
 * (blackBright) so they stay legible on both light and dark terminals.
 * Based on darkAnsiTheme.
 */
const terminalTheme: Theme = {
  autoAccept: 'ansi:magentaBright',
  bashBorder: 'ansi:magentaBright',
  claude: 'ansi:redBright',
  claudeShimmer: 'ansi:yellowBright',
  claudeBlue_FOR_SYSTEM_SPINNER: 'ansi:blueBright',
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'ansi:blueBright',
  permission: 'ansi:blueBright',
  permissionShimmer: 'ansi:blueBright',
  planMode: 'ansi:cyanBright',
  ide: 'ansi:blue',
  promptBorder: 'ansi:blackBright', // neutral gray (legible on light + dark)
  promptBorderShimmer: 'ansi:white',
  text: 'terminal', // inherit terminal default foreground
  inverseText: 'terminal', // inherit terminal default foreground
  spinnerStalled: 'ansi:redBright', // Stalled-spinner (mirrors error for ANSI)
  inactive: 'ansi:blackBright', // neutral gray (legible on light + dark)
  inactiveShimmer: 'ansi:white',
  subtle: 'ansi:blackBright', // neutral gray (legible on light + dark)
  suggestion: 'ansi:blueBright',
  remember: 'ansi:blueBright',
  background: 'ansi:cyanBright',
  success: 'ansi:greenBright',
  error: 'ansi:redBright',
  warning: 'ansi:yellowBright',
  merged: 'ansi:magentaBright',
  warningShimmer: 'ansi:yellowBright',
  diffAdded: 'ansi:green',
  diffRemoved: 'ansi:red',
  diffAddedDimmed: 'ansi:green',
  diffRemovedDimmed: 'ansi:red',
  diffAddedWord: 'ansi:greenBright',
  diffRemovedWord: 'ansi:redBright',
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'ansi:redBright',
  blue_FOR_SUBAGENTS_ONLY: 'ansi:blueBright',
  green_FOR_SUBAGENTS_ONLY: 'ansi:greenBright',
  yellow_FOR_SUBAGENTS_ONLY: 'ansi:yellowBright',
  purple_FOR_SUBAGENTS_ONLY: 'ansi:magentaBright',
  orange_FOR_SUBAGENTS_ONLY: 'ansi:redBright',
  pink_FOR_SUBAGENTS_ONLY: 'ansi:magentaBright',
  cyan_FOR_SUBAGENTS_ONLY: 'ansi:cyanBright',
  // Grove colors
  professionalBlue: 'rgb(106,155,204)',
  // Chrome colors
  chromeYellow: 'ansi:yellowBright',
  // TUI V2 colors
  clawd_body: 'ansi:redBright',
  clawd_background: 'ansi:black', // kept ANSI: used as both fg+bg for logo cutouts
  userMessageBackground: 'ansi:blackBright',
  userMessageBackgroundHover: 'ansi:white',
  messageActionsBackground: 'ansi:blackBright',
  selectionBg: 'ansi:blue',
  bashMessageBackgroundColor: 'ansi:black',

  memoryBackgroundColor: 'ansi:blackBright',
  rate_limit_fill: 'ansi:yellow',
  rate_limit_empty: 'ansi:white',
  fastMode: 'ansi:redBright',
  fastModeShimmer: 'ansi:redBright',
  briefLabelYou: 'ansi:blueBright',
  briefLabelClaude: 'ansi:redBright',
  rainbow_red: 'ansi:red',
  rainbow_orange: 'ansi:redBright',
  rainbow_yellow: 'ansi:yellow',
  rainbow_green: 'ansi:green',
  rainbow_blue: 'ansi:cyan',
  rainbow_indigo: 'ansi:blue',
  rainbow_violet: 'ansi:magenta',
  rainbow_red_shimmer: 'ansi:redBright',
  rainbow_orange_shimmer: 'ansi:yellow',
  rainbow_yellow_shimmer: 'ansi:yellowBright',
  rainbow_green_shimmer: 'ansi:greenBright',
  rainbow_blue_shimmer: 'ansi:cyanBright',
  rainbow_indigo_shimmer: 'ansi:blueBright',
  rainbow_violet_shimmer: 'ansi:magentaBright',
}

/**
 * Dracula theme — the classic purple/pink dark palette
 * (https://draculatheme.com). Explicit RGB values for true-color terminals.
 */
const draculaTheme: Theme = {
  autoAccept: 'rgb(189,147,249)', // Purple
  bashBorder: 'rgb(255,121,198)', // Pink
  claude: 'rgb(255,184,108)', // Orange
  claudeShimmer: 'rgb(255,204,148)', // Lighter orange for shimmer effect
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(139,233,253)', // Cyan
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(179,243,255)', // Lighter cyan for shimmer
  permission: 'rgb(189,147,249)', // Purple
  permissionShimmer: 'rgb(209,177,255)', // Lighter purple for shimmer
  planMode: 'rgb(80,250,123)', // Green
  ide: 'rgb(98,114,164)', // Comment blue
  promptBorder: 'rgb(98,114,164)', // Comment blue
  promptBorderShimmer: 'rgb(128,144,194)', // Lighter comment for shimmer
  text: 'rgb(248,248,242)', // Foreground
  inverseText: 'rgb(40,42,54)', // Background
  inactive: 'rgb(98,114,164)', // Comment
  inactiveShimmer: 'rgb(138,154,204)', // Lighter comment for shimmer effect
  subtle: 'rgb(68,71,90)', // Current line
  suggestion: 'rgb(189,147,249)', // Purple
  remember: 'rgb(189,147,249)', // Purple
  background: 'rgb(139,233,253)', // Cyan accent
  success: 'rgb(80,250,123)', // Green
  error: 'rgb(255,85,85)', // Red
  spinnerStalled: DEFAULT_STALL_RED, // Stalled-spinner red
  warning: 'rgb(241,250,140)', // Yellow
  merged: 'rgb(189,147,249)', // Purple (matches autoAccept)
  warningShimmer: 'rgb(255,255,180)', // Lighter yellow for shimmer
  diffAdded: 'rgb(40,80,55)', // Dark green
  diffRemoved: 'rgb(90,45,55)', // Dark red
  diffAddedDimmed: 'rgb(48,62,53)', // Very dark green
  diffRemovedDimmed: 'rgb(72,52,57)', // Very dark red
  diffAddedWord: 'rgb(80,200,110)', // Medium green
  diffRemovedWord: 'rgb(255,121,140)', // Softer red
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'rgb(255,85,85)', // Red
  blue_FOR_SUBAGENTS_ONLY: 'rgb(139,180,250)', // Blue
  green_FOR_SUBAGENTS_ONLY: 'rgb(80,250,123)', // Green
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(241,250,140)', // Yellow
  purple_FOR_SUBAGENTS_ONLY: 'rgb(189,147,249)', // Purple
  orange_FOR_SUBAGENTS_ONLY: 'rgb(255,184,108)', // Orange
  pink_FOR_SUBAGENTS_ONLY: 'rgb(255,121,198)', // Pink
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(139,233,253)', // Cyan
  // Grove colors
  professionalBlue: 'rgb(106,130,180)',
  // Chrome colors
  chromeYellow: 'rgb(241,250,140)',
  // TUI V2 colors
  clawd_body: 'rgb(255,184,108)',
  clawd_background: 'rgb(40,42,54)',
  userMessageBackground: 'rgb(55, 57, 72)',
  userMessageBackgroundHover: 'rgb(68, 71, 90)',
  messageActionsBackground: 'rgb(52, 52, 75)', // cool, slight purple
  selectionBg: 'rgb(61, 64, 110)', // bluish selection over Dracula bg
  bashMessageBackgroundColor: 'rgb(60, 52, 68)',

  memoryBackgroundColor: 'rgb(52, 58, 75)',
  rate_limit_fill: 'rgb(189,147,249)', // Purple
  rate_limit_empty: 'rgb(80,70,112)', // Dark purple
  fastMode: 'rgb(255,160,80)', // Electric orange for dark bg
  fastModeShimmer: 'rgb(255,190,130)', // Lighter orange for shimmer
  briefLabelYou: 'rgb(139,233,253)', // Cyan
  briefLabelClaude: 'rgb(255,184,108)', // Orange
  rainbow_red: 'rgb(255,85,85)',
  rainbow_orange: 'rgb(255,184,108)',
  rainbow_yellow: 'rgb(241,250,140)',
  rainbow_green: 'rgb(80,250,123)',
  rainbow_blue: 'rgb(139,233,253)',
  rainbow_indigo: 'rgb(189,147,249)',
  rainbow_violet: 'rgb(255,121,198)',
  rainbow_red_shimmer: 'rgb(255,135,135)',
  rainbow_orange_shimmer: 'rgb(255,204,148)',
  rainbow_yellow_shimmer: 'rgb(255,255,180)',
  rainbow_green_shimmer: 'rgb(130,255,163)',
  rainbow_blue_shimmer: 'rgb(179,243,255)',
  rainbow_indigo_shimmer: 'rgb(209,177,255)',
  rainbow_violet_shimmer: 'rgb(255,161,218)',
}

/**
 * Catppuccin Mocha theme — soft pastels on a warm dark base
 * (https://catppuccin.com/palette). Explicit RGB values for true-color terminals.
 */
const catppuccinMochaTheme: Theme = {
  autoAccept: 'rgb(203,166,247)', // Mauve
  bashBorder: 'rgb(245,194,231)', // Pink
  claude: 'rgb(250,179,135)', // Peach
  claudeShimmer: 'rgb(255,199,165)', // Lighter peach for shimmer effect
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(137,180,250)', // Blue
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(167,200,255)', // Lighter blue for shimmer
  permission: 'rgb(180,190,254)', // Lavender
  permissionShimmer: 'rgb(200,210,255)', // Lighter lavender for shimmer
  planMode: 'rgb(148,226,213)', // Teal
  ide: 'rgb(116,199,236)', // Sapphire
  promptBorder: 'rgb(108,112,134)', // Overlay0
  promptBorderShimmer: 'rgb(138,142,164)', // Lighter overlay for shimmer
  text: 'rgb(205,214,244)', // Text
  inverseText: 'rgb(30,30,46)', // Base
  inactive: 'rgb(147,153,178)', // Overlay2
  inactiveShimmer: 'rgb(177,183,208)', // Lighter overlay for shimmer effect
  subtle: 'rgb(69,71,90)', // Surface1
  suggestion: 'rgb(180,190,254)', // Lavender
  remember: 'rgb(203,166,247)', // Mauve
  background: 'rgb(148,226,213)', // Teal accent
  success: 'rgb(166,227,161)', // Green
  error: 'rgb(243,139,168)', // Red
  spinnerStalled: DEFAULT_STALL_RED, // Stalled-spinner red
  warning: 'rgb(249,226,175)', // Yellow
  merged: 'rgb(203,166,247)', // Mauve (matches autoAccept)
  warningShimmer: 'rgb(255,240,195)', // Lighter yellow for shimmer
  diffAdded: 'rgb(48,70,55)', // Dark green
  diffRemoved: 'rgb(80,48,58)', // Dark red
  diffAddedDimmed: 'rgb(50,58,55)', // Very dark green
  diffRemovedDimmed: 'rgb(66,52,58)', // Very dark red
  diffAddedWord: 'rgb(120,190,115)', // Medium green
  diffRemovedWord: 'rgb(220,120,145)', // Softer red
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'rgb(243,139,168)', // Red
  blue_FOR_SUBAGENTS_ONLY: 'rgb(137,180,250)', // Blue
  green_FOR_SUBAGENTS_ONLY: 'rgb(166,227,161)', // Green
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(249,226,175)', // Yellow
  purple_FOR_SUBAGENTS_ONLY: 'rgb(203,166,247)', // Mauve
  orange_FOR_SUBAGENTS_ONLY: 'rgb(250,179,135)', // Peach
  pink_FOR_SUBAGENTS_ONLY: 'rgb(245,194,231)', // Pink
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(148,226,213)', // Teal
  // Grove colors
  professionalBlue: 'rgb(116,199,236)',
  // Chrome colors
  chromeYellow: 'rgb(249,226,175)',
  // TUI V2 colors
  clawd_body: 'rgb(250,179,135)',
  clawd_background: 'rgb(30,30,46)',
  userMessageBackground: 'rgb(49, 50, 68)', // Surface0
  userMessageBackgroundHover: 'rgb(69, 71, 90)', // Surface1
  messageActionsBackground: 'rgb(54, 56, 78)', // cool, slight lavender
  selectionBg: 'rgb(69, 71, 110)', // bluish selection over Mocha base
  bashMessageBackgroundColor: 'rgb(60, 52, 72)',

  memoryBackgroundColor: 'rgb(49, 58, 70)',
  rate_limit_fill: 'rgb(180,190,254)', // Lavender
  rate_limit_empty: 'rgb(76, 80, 112)', // Dark lavender
  fastMode: 'rgb(250,179,135)', // Peach
  fastModeShimmer: 'rgb(255,199,165)', // Lighter peach for shimmer
  briefLabelYou: 'rgb(137,180,250)', // Blue
  briefLabelClaude: 'rgb(250,179,135)', // Peach
  rainbow_red: 'rgb(243,139,168)',
  rainbow_orange: 'rgb(250,179,135)',
  rainbow_yellow: 'rgb(249,226,175)',
  rainbow_green: 'rgb(166,227,161)',
  rainbow_blue: 'rgb(137,180,250)',
  rainbow_indigo: 'rgb(180,190,254)',
  rainbow_violet: 'rgb(203,166,247)',
  rainbow_red_shimmer: 'rgb(255,179,198)',
  rainbow_orange_shimmer: 'rgb(255,199,165)',
  rainbow_yellow_shimmer: 'rgb(255,240,195)',
  rainbow_green_shimmer: 'rgb(196,247,191)',
  rainbow_blue_shimmer: 'rgb(167,200,255)',
  rainbow_indigo_shimmer: 'rgb(200,210,255)',
  rainbow_violet_shimmer: 'rgb(223,196,255)',
}

/**
 * Catppuccin Latte theme — the light counterpart to Mocha
 * (https://catppuccin.com/palette). Explicit RGB values for true-color terminals.
 */
const catppuccinLatteTheme: Theme = {
  autoAccept: 'rgb(136,57,239)', // Mauve
  bashBorder: 'rgb(234,118,203)', // Pink
  claude: 'rgb(254,100,11)', // Peach
  claudeShimmer: 'rgb(255,140,71)', // Lighter peach for shimmer effect
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(30,102,245)', // Blue
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(80,142,255)', // Lighter blue for shimmer
  permission: 'rgb(114,135,253)', // Lavender
  permissionShimmer: 'rgb(154,170,255)', // Lighter lavender for shimmer
  planMode: 'rgb(23,146,153)', // Teal
  ide: 'rgb(32,159,181)', // Sapphire
  promptBorder: 'rgb(156,160,176)', // Overlay0
  promptBorderShimmer: 'rgb(186,190,206)', // Lighter overlay for shimmer
  text: 'rgb(76,79,105)', // Text
  inverseText: 'rgb(239,241,245)', // Base
  inactive: 'rgb(124,127,147)', // Overlay2
  inactiveShimmer: 'rgb(154,157,177)', // Lighter overlay for shimmer effect
  subtle: 'rgb(188,192,204)', // Surface1
  suggestion: 'rgb(30,102,245)', // Blue
  remember: 'rgb(136,57,239)', // Mauve
  background: 'rgb(23,146,153)', // Teal accent
  success: 'rgb(64,160,43)', // Green
  error: 'rgb(210,15,57)', // Red
  spinnerStalled: DEFAULT_STALL_RED, // Stalled-spinner red
  warning: 'rgb(223,142,29)', // Yellow
  merged: 'rgb(136,57,239)', // Mauve (matches autoAccept)
  warningShimmer: 'rgb(243,172,69)', // Lighter yellow for shimmer effect
  diffAdded: 'rgb(180,225,170)', // Light green
  diffRemoved: 'rgb(245,185,195)', // Light red
  diffAddedDimmed: 'rgb(210,230,205)', // Very light green
  diffRemovedDimmed: 'rgb(245,215,222)', // Very light red
  diffAddedWord: 'rgb(64,160,43)', // Medium green
  diffRemovedWord: 'rgb(210,15,57)', // Medium red
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'rgb(210,15,57)', // Red
  blue_FOR_SUBAGENTS_ONLY: 'rgb(30,102,245)', // Blue
  green_FOR_SUBAGENTS_ONLY: 'rgb(64,160,43)', // Green
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(223,142,29)', // Yellow
  purple_FOR_SUBAGENTS_ONLY: 'rgb(136,57,239)', // Mauve
  orange_FOR_SUBAGENTS_ONLY: 'rgb(254,100,11)', // Peach
  pink_FOR_SUBAGENTS_ONLY: 'rgb(234,118,203)', // Pink
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(23,146,153)', // Teal
  // Grove colors
  professionalBlue: 'rgb(32,159,181)',
  // Chrome colors
  chromeYellow: 'rgb(223,142,29)',
  // TUI V2 colors
  clawd_body: 'rgb(254,100,11)',
  clawd_background: 'rgb(239,241,245)',
  userMessageBackground: 'rgb(230, 233, 239)', // Mantle
  userMessageBackgroundHover: 'rgb(220, 224, 232)', // Crust
  messageActionsBackground: 'rgb(225, 229, 240)', // cool, slight lavender
  selectionBg: 'rgb(186, 203, 245)', // light selection blue; dark fgs stay readable
  bashMessageBackgroundColor: 'rgb(238, 234, 240)',

  memoryBackgroundColor: 'rgb(225, 238, 240)',
  rate_limit_fill: 'rgb(30,102,245)', // Blue
  rate_limit_empty: 'rgb(172,176,190)', // Surface2
  fastMode: 'rgb(254,100,11)', // Peach
  fastModeShimmer: 'rgb(255,140,71)', // Lighter peach for shimmer
  briefLabelYou: 'rgb(30,102,245)', // Blue
  briefLabelClaude: 'rgb(254,100,11)', // Peach
  rainbow_red: 'rgb(210,15,57)',
  rainbow_orange: 'rgb(254,100,11)',
  rainbow_yellow: 'rgb(223,142,29)',
  rainbow_green: 'rgb(64,160,43)',
  rainbow_blue: 'rgb(30,102,245)',
  rainbow_indigo: 'rgb(114,135,253)',
  rainbow_violet: 'rgb(136,57,239)',
  rainbow_red_shimmer: 'rgb(230,75,107)',
  rainbow_orange_shimmer: 'rgb(255,140,71)',
  rainbow_yellow_shimmer: 'rgb(243,172,69)',
  rainbow_green_shimmer: 'rgb(104,190,83)',
  rainbow_blue_shimmer: 'rgb(80,142,255)',
  rainbow_indigo_shimmer: 'rgb(154,170,255)',
  rainbow_violet_shimmer: 'rgb(176,107,255)',
}

/**
 * Tokyo Night theme — deep navy with violet/blue accents
 * (https://github.com/folke/tokyonight.nvim). Explicit RGB for true-color terminals.
 */
const tokyoNightTheme: Theme = {
  autoAccept: 'rgb(187,154,247)', // Magenta
  bashBorder: 'rgb(187,154,247)', // Magenta (mode accent — must not read as `error`)
  claude: 'ansi:redBright', // Claude orange — the dark-ansi one (follows the terminal palette)
  claudeShimmer: 'ansi:yellowBright', // Lighter claude orange for shimmer (dark-ansi)
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(122,162,247)', // Blue
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(152,192,255)', // Lighter blue for shimmer
  permission: 'rgb(122,162,247)', // Blue (links/inline code, matches dark-ansi)
  permissionShimmer: 'rgb(152,192,255)', // Lighter blue for shimmer
  planMode: 'rgb(158,206,106)', // Green
  ide: 'rgb(86,110,160)', // Muted blue
  promptBorder: 'rgb(86,95,137)', // Comment
  promptBorderShimmer: 'rgb(116,125,167)', // Lighter comment for shimmer
  text: 'rgb(192,202,245)', // Foreground
  inverseText: 'rgb(26,27,38)', // Background
  inactive: 'rgb(115,120,132)', // Neutral gray (secondary/dim text — darker, matches dark-ansi feel)
  inactiveShimmer: 'rgb(150,156,170)', // Lighter for shimmer effect
  subtle: 'rgb(65,72,104)', // Terminal black
  suggestion: 'rgb(122,162,247)', // Blue
  remember: 'rgb(187,154,247)', // Magenta
  background: 'rgb(125,207,255)', // Cyan accent
  success: 'rgb(158,206,106)', // Green
  error: 'rgb(247,118,142)', // Red
  spinnerStalled: 'ansi:redBright', // Stalled-spinner (mirrors error for ANSI, like dark-ansi)
  warning: 'rgb(224,175,104)', // Yellow
  merged: 'rgb(187,154,247)', // Magenta (matches autoAccept)
  warningShimmer: 'rgb(255,205,134)', // Lighter yellow for shimmer
  diffAdded: 'rgb(40,65,45)', // Dark green
  diffRemoved: 'rgb(75,42,52)', // Dark red
  diffAddedDimmed: 'rgb(45,55,50)', // Very dark green
  diffRemovedDimmed: 'rgb(62,48,55)', // Very dark red
  diffAddedWord: 'rgb(120,180,95)', // Medium green
  diffRemovedWord: 'rgb(230,110,135)', // Softer red
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'rgb(247,118,142)', // Red
  blue_FOR_SUBAGENTS_ONLY: 'rgb(122,162,247)', // Blue
  green_FOR_SUBAGENTS_ONLY: 'rgb(158,206,106)', // Green
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(224,175,104)', // Yellow
  purple_FOR_SUBAGENTS_ONLY: 'rgb(187,154,247)', // Magenta
  orange_FOR_SUBAGENTS_ONLY: 'rgb(255,158,100)', // Orange
  pink_FOR_SUBAGENTS_ONLY: 'rgb(255,117,160)', // Pink
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(125,207,255)', // Cyan
  // Grove colors
  professionalBlue: 'rgb(94,129,172)',
  // Chrome colors
  chromeYellow: 'rgb(224,175,104)',
  // TUI V2 colors
  clawd_body: 'ansi:redBright',
  clawd_background: 'rgb(26,27,38)',
  userMessageBackground: 'rgb(40, 44, 62)',
  userMessageBackgroundHover: 'rgb(52, 57, 80)',
  messageActionsBackground: 'rgb(40, 52, 87)', // cool, slight blue
  selectionBg: 'rgb(40, 52, 87)', // Tokyo Night selection
  bashMessageBackgroundColor: 'rgb(52, 46, 66)',

  memoryBackgroundColor: 'rgb(40, 50, 66)',
  rate_limit_fill: 'rgb(122,162,247)', // Blue
  rate_limit_empty: 'rgb(60, 72, 112)', // Dark blue
  fastMode: 'rgb(255,140,70)', // Electric orange for dark bg
  fastModeShimmer: 'rgb(255,175,120)', // Lighter orange for shimmer
  briefLabelYou: 'rgb(125,207,255)', // Cyan
  briefLabelClaude: 'ansi:redBright', // Brand orange (dark-ansi)
  rainbow_red: 'rgb(247,118,142)',
  rainbow_orange: 'rgb(255,158,100)',
  rainbow_yellow: 'rgb(224,175,104)',
  rainbow_green: 'rgb(158,206,106)',
  rainbow_blue: 'rgb(125,207,255)',
  rainbow_indigo: 'rgb(122,162,247)',
  rainbow_violet: 'rgb(187,154,247)',
  rainbow_red_shimmer: 'rgb(255,158,182)',
  rainbow_orange_shimmer: 'rgb(255,178,130)',
  rainbow_yellow_shimmer: 'rgb(255,205,134)',
  rainbow_green_shimmer: 'rgb(188,236,146)',
  rainbow_blue_shimmer: 'rgb(165,227,255)',
  rainbow_indigo_shimmer: 'rgb(152,192,255)',
  rainbow_violet_shimmer: 'rgb(207,184,255)',
}

/**
 * Nord theme — low-saturation arctic blue-gray palette
 * (https://www.nordtheme.com). Explicit RGB for true-color terminals.
 */
const nordTheme: Theme = {
  autoAccept: 'rgb(180,142,173)', // Aurora purple
  bashBorder: 'rgb(180,142,173)', // Aurora purple (mode accent — must not read as `error`)
  claude: 'rgb(208,135,112)', // Aurora orange
  claudeShimmer: 'rgb(228,165,142)', // Lighter orange for shimmer effect
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(136,192,208)', // Frost cyan
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(166,212,228)', // Lighter cyan for shimmer
  permission: 'rgb(129,161,193)', // Frost blue
  permissionShimmer: 'rgb(159,191,223)', // Lighter blue for shimmer
  planMode: 'rgb(143,188,187)', // Frost teal
  ide: 'rgb(94,129,172)', // Frost dark blue
  promptBorder: 'rgb(76,86,106)', // nord3
  promptBorderShimmer: 'rgb(106,116,136)', // Lighter for shimmer
  text: 'rgb(236,239,244)', // nord6
  inverseText: 'rgb(46,52,64)', // nord0
  inactive: 'rgb(118,128,148)', // Muted gray-blue
  inactiveShimmer: 'rgb(148,158,178)', // Lighter for shimmer effect
  subtle: 'rgb(59,66,82)', // nord1
  suggestion: 'rgb(129,161,193)', // Frost blue
  remember: 'rgb(180,142,173)', // Aurora purple
  background: 'rgb(136,192,208)', // Frost cyan accent
  success: 'rgb(163,190,140)', // Aurora green
  error: 'rgb(191,97,106)', // Aurora red
  spinnerStalled: DEFAULT_STALL_RED, // Stalled-spinner red
  warning: 'rgb(235,203,139)', // Aurora yellow
  merged: 'rgb(180,142,173)', // Aurora purple (matches autoAccept)
  warningShimmer: 'rgb(255,223,159)', // Lighter yellow for shimmer
  diffAdded: 'rgb(45,62,48)', // Dark green
  diffRemoved: 'rgb(72,48,52)', // Dark red
  diffAddedDimmed: 'rgb(50,58,52)', // Very dark green
  diffRemovedDimmed: 'rgb(62,52,55)', // Very dark red
  diffAddedWord: 'rgb(130,160,110)', // Medium green
  diffRemovedWord: 'rgb(200,120,130)', // Softer red
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'rgb(191,97,106)', // Red
  blue_FOR_SUBAGENTS_ONLY: 'rgb(129,161,193)', // Blue
  green_FOR_SUBAGENTS_ONLY: 'rgb(163,190,140)', // Green
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(235,203,139)', // Yellow
  purple_FOR_SUBAGENTS_ONLY: 'rgb(180,142,173)', // Purple
  orange_FOR_SUBAGENTS_ONLY: 'rgb(208,135,112)', // Orange
  pink_FOR_SUBAGENTS_ONLY: 'rgb(196,142,168)', // Pink
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(136,192,208)', // Cyan
  // Grove colors
  professionalBlue: 'rgb(94,129,172)',
  // Chrome colors
  chromeYellow: 'rgb(235,203,139)',
  // TUI V2 colors
  clawd_body: 'rgb(208,135,112)',
  clawd_background: 'rgb(46,52,64)',
  userMessageBackground: 'rgb(59, 66, 82)', // nord1
  userMessageBackgroundHover: 'rgb(67, 76, 94)', // nord2
  messageActionsBackground: 'rgb(56, 66, 86)', // cool, slight blue
  selectionBg: 'rgb(60, 72, 100)', // bluish selection over nord0
  bashMessageBackgroundColor: 'rgb(62, 60, 72)',

  memoryBackgroundColor: 'rgb(52, 64, 72)',
  rate_limit_fill: 'rgb(129,161,193)', // Frost blue
  rate_limit_empty: 'rgb(64, 76, 100)', // Dark blue
  fastMode: 'rgb(224,150,110)', // Orange for dark bg
  fastModeShimmer: 'rgb(240,180,150)', // Lighter orange for shimmer
  briefLabelYou: 'rgb(136,192,208)', // Frost cyan
  briefLabelClaude: 'rgb(208,135,112)', // Orange
  rainbow_red: 'rgb(191,97,106)',
  rainbow_orange: 'rgb(208,135,112)',
  rainbow_yellow: 'rgb(235,203,139)',
  rainbow_green: 'rgb(163,190,140)',
  rainbow_blue: 'rgb(136,192,208)',
  rainbow_indigo: 'rgb(129,161,193)',
  rainbow_violet: 'rgb(180,142,173)',
  rainbow_red_shimmer: 'rgb(221,137,146)',
  rainbow_orange_shimmer: 'rgb(228,165,142)',
  rainbow_yellow_shimmer: 'rgb(255,223,159)',
  rainbow_green_shimmer: 'rgb(193,210,170)',
  rainbow_blue_shimmer: 'rgb(166,212,228)',
  rainbow_indigo_shimmer: 'rgb(159,191,223)',
  rainbow_violet_shimmer: 'rgb(210,172,203)',
}

/**
 * Gruvbox Dark theme — warm retro earth tones (medium contrast)
 * (https://github.com/morhetz/gruvbox). Explicit RGB for true-color terminals.
 */
const gruvboxDarkTheme: Theme = {
  autoAccept: 'rgb(211,134,155)', // Bright purple
  bashBorder: 'rgb(211,134,155)', // Bright purple (mode accent — must not read as `error`)
  claude: 'rgb(254,128,25)', // Bright orange
  claudeShimmer: 'rgb(255,158,75)', // Lighter orange for shimmer effect
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(131,165,152)', // Bright blue
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(161,195,182)', // Lighter blue for shimmer
  permission: 'rgb(211,134,155)', // Bright purple
  permissionShimmer: 'rgb(231,164,185)', // Lighter purple for shimmer
  planMode: 'rgb(142,192,124)', // Bright aqua
  ide: 'rgb(69,133,136)', // Neutral blue
  promptBorder: 'rgb(102,92,84)', // bg3
  promptBorderShimmer: 'rgb(132,122,114)', // Lighter for shimmer
  text: 'rgb(235,219,178)', // fg
  inverseText: 'rgb(40,40,40)', // bg0
  inactive: 'rgb(146,131,116)', // Gray
  inactiveShimmer: 'rgb(176,161,146)', // Lighter gray for shimmer effect
  subtle: 'rgb(80,73,69)', // bg2
  suggestion: 'rgb(131,165,152)', // Bright blue
  remember: 'rgb(211,134,155)', // Bright purple
  background: 'rgb(142,192,124)', // Bright aqua accent
  success: 'rgb(184,187,38)', // Bright green
  error: 'rgb(251,73,52)', // Bright red
  spinnerStalled: DEFAULT_STALL_RED, // Stalled-spinner red
  warning: 'rgb(250,189,47)', // Bright yellow
  merged: 'rgb(211,134,155)', // Bright purple (matches autoAccept)
  warningShimmer: 'rgb(255,219,107)', // Lighter yellow for shimmer
  diffAdded: 'rgb(50,58,30)', // Dark green
  diffRemoved: 'rgb(80,45,40)', // Dark red
  diffAddedDimmed: 'rgb(52,54,42)', // Very dark green
  diffRemovedDimmed: 'rgb(66,52,48)', // Very dark red
  diffAddedWord: 'rgb(150,160,40)', // Medium green
  diffRemovedWord: 'rgb(220,90,70)', // Softer red
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'rgb(251,73,52)', // Red
  blue_FOR_SUBAGENTS_ONLY: 'rgb(131,165,152)', // Blue
  green_FOR_SUBAGENTS_ONLY: 'rgb(184,187,38)', // Green
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(250,189,47)', // Yellow
  purple_FOR_SUBAGENTS_ONLY: 'rgb(211,134,155)', // Purple
  orange_FOR_SUBAGENTS_ONLY: 'rgb(254,128,25)', // Orange
  pink_FOR_SUBAGENTS_ONLY: 'rgb(216,140,168)', // Pink
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(142,192,124)', // Aqua
  // Grove colors
  professionalBlue: 'rgb(106,140,140)',
  // Chrome colors
  chromeYellow: 'rgb(250,189,47)',
  // TUI V2 colors
  clawd_body: 'rgb(254,128,25)',
  clawd_background: 'rgb(40,40,40)',
  userMessageBackground: 'rgb(60, 56, 54)', // bg1
  userMessageBackgroundHover: 'rgb(80, 73, 69)', // bg2
  messageActionsBackground: 'rgb(62, 60, 52)', // warm
  selectionBg: 'rgb(80, 73, 60)', // warm selection over bg0
  bashMessageBackgroundColor: 'rgb(66, 58, 52)',

  memoryBackgroundColor: 'rgb(58, 60, 50)',
  rate_limit_fill: 'rgb(131,165,152)', // Bright blue
  rate_limit_empty: 'rgb(76, 72, 64)', // Dark gray
  fastMode: 'rgb(254,128,25)', // Bright orange
  fastModeShimmer: 'rgb(255,165,85)', // Lighter orange for shimmer
  briefLabelYou: 'rgb(131,165,152)', // Bright blue
  briefLabelClaude: 'rgb(254,128,25)', // Bright orange
  rainbow_red: 'rgb(251,73,52)',
  rainbow_orange: 'rgb(254,128,25)',
  rainbow_yellow: 'rgb(250,189,47)',
  rainbow_green: 'rgb(184,187,38)',
  rainbow_blue: 'rgb(131,165,152)',
  rainbow_indigo: 'rgb(69,133,136)',
  rainbow_violet: 'rgb(211,134,155)',
  rainbow_red_shimmer: 'rgb(255,123,102)',
  rainbow_orange_shimmer: 'rgb(255,158,75)',
  rainbow_yellow_shimmer: 'rgb(255,219,107)',
  rainbow_green_shimmer: 'rgb(214,217,88)',
  rainbow_blue_shimmer: 'rgb(161,195,182)',
  rainbow_indigo_shimmer: 'rgb(109,173,176)',
  rainbow_violet_shimmer: 'rgb(231,164,185)',
}

export function getTheme(themeName: ThemeName): Theme {
  switch (themeName) {
    case 'light':
      return lightTheme
    case 'light-ansi':
      return lightAnsiTheme
    case 'dark-ansi':
      return darkAnsiTheme
    case 'terminal':
      return terminalTheme
    case 'light-daltonized':
      return lightDaltonizedTheme
    case 'dark-daltonized':
      return darkDaltonizedTheme
    case 'dracula':
      return draculaTheme
    case 'catppuccin-mocha':
      return catppuccinMochaTheme
    case 'catppuccin-latte':
      return catppuccinLatteTheme
    case 'tokyo-night':
      return tokyoNightTheme
    case 'nord':
      return nordTheme
    case 'gruvbox-dark':
      return gruvboxDarkTheme
    default:
      return darkTheme
  }
}

// Create a chalk instance with 256-color level for Apple Terminal
// Apple Terminal doesn't handle 24-bit color escape sequences well
const chalkForChart =
  env.terminal === 'Apple_Terminal'
    ? new Chalk({ level: 2 }) // 256 colors
    : chalk

/**
 * Converts a theme color to an ANSI escape sequence for use with asciichart.
 * Uses chalk to generate the escape codes, with 256-color mode for Apple Terminal.
 */
export function themeColorToAnsi(themeColor: string): string {
  const rgbMatch = themeColor.match(/rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)/)
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1]!, 10)
    const g = parseInt(rgbMatch[2]!, 10)
    const b = parseInt(rgbMatch[3]!, 10)
    // Use chalk.rgb which auto-converts to 256 colors when level is 2
    // Extract just the opening escape sequence by using a marker
    const colored = chalkForChart.rgb(r, g, b)('X')
    return colored.slice(0, colored.indexOf('X'))
  }
  // Fallback to magenta if parsing fails
  return '\x1b[35m'
}
