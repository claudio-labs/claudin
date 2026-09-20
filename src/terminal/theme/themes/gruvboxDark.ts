import { DEFAULT_STALL_RED, type Theme } from 'src/terminal/theme/themes/types.js'

/**
 * Gruvbox Dark theme — warm retro earth tones (medium contrast)
 * (https://github.com/morhetz/gruvbox). Explicit RGB for true-color terminals.
 */
export const gruvboxDarkTheme: Theme = {
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
  sidePanelBackground: 'rgb(50,48,45)', // One step off Gruvbox's bg0
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
  // Accent colors
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
