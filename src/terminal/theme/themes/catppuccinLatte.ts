import { DEFAULT_STALL_RED, type Theme } from 'src/terminal/theme/themes/types.js'

/**
 * Catppuccin Latte theme — the light counterpart to Mocha
 * (https://catppuccin.com/palette). Explicit RGB values for true-color terminals.
 */
export const catppuccinLatteTheme: Theme = {
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
  sidePanelBackground: 'rgb(230,233,239)', // Latte's mantle
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
  // Accent colors
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
